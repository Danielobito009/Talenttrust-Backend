/**
 * @module shutdown
 * @description Graceful shutdown coordinator for TalentTrust Backend.
 *
 * Responsibilities:
 * 1. Flip the readiness probe to "not ready" so the load balancer stops
 *    routing new traffic.
 * 2. Stop accepting new HTTP connections (server.close).
 * 3. Drain in-flight work (BullMQ queue shutdown).
 * 4. Close the SQLite database handle.
 * 5. Force-exit if the drain takes longer than `SHUTDOWN_GRACE_MS`.
 *
 * The handler is idempotent — a second signal while draining is ignored.
 *
 * ## Environment variables
 * | Variable | Default | Description |
 * |---|---|---|
 * | `SHUTDOWN_GRACE_MS` | `10000` | Max ms to wait for drain before forced exit. |
 */

import type { Server } from 'http';
import type Database from 'better-sqlite3';
import { logger } from './logger';

export interface ShutdownDeps {
  /** HTTP server to stop accepting connections on. */
  server: Server;
  /** SQLite database handle to close. */
  db: Database.Database;
  /** Async function that drains in-flight queue work. */
  drainQueue: () => Promise<void>;
  /** Flips the readiness probe to false. */
  setNotReady: () => void;
  /** Grace period in ms before forced exit (default: SHUTDOWN_GRACE_MS env or 10 000). */
  gracePeriodMs?: number;
  /** Override process.exit for testing. */
  exit?: (code: number) => void;
}

let shutdownInProgress = false;

/** Reset idempotency guard — for tests only. */
export function _resetShutdownState(): void {
  shutdownInProgress = false;
}

/**
 * Performs a graceful shutdown sequence.
 *
 * @param deps - Injected dependencies (server, db, queue drain, readiness setter).
 */
export async function gracefulShutdown(deps: ShutdownDeps): Promise<void> {
  if (shutdownInProgress) {
    logger.warn('Shutdown already in progress — ignoring duplicate signal');
    return;
  }
  shutdownInProgress = true;

  const {
    server,
    db,
    drainQueue,
    setNotReady,
    exit = process.exit.bind(process),
  } = deps;

  const gracePeriodMs =
    deps.gracePeriodMs ??
    (process.env['SHUTDOWN_GRACE_MS']
      ? Number(process.env['SHUTDOWN_GRACE_MS'])
      : 10_000);

  logger.info('Graceful shutdown initiated', { gracePeriodMs });

  // 1. Stop accepting new traffic
  setNotReady();

  return new Promise<void>((resolve) => {
    // 2. Force-exit timer
    const forceTimer = setTimeout(() => {
      logger.error('Shutdown grace period exceeded — forcing exit');
      exit(1);
      resolve();
    }, gracePeriodMs);
    // Allow the process to exit naturally if only this timer is left
    if (typeof forceTimer.unref === 'function') forceTimer.unref();

    const finish = (code: number) => {
      clearTimeout(forceTimer);
      exit(code);
      resolve();
    };

    // 3. Stop accepting new HTTP connections, then drain, then close DB
    new Promise<void>((res, rej) => {
      server.close((err) => (err ? rej(err) : res()));
    })
      .then(() => {
        logger.info('HTTP server closed');
        return drainQueue();
      })
      .then(() => {
        logger.info('Queue drained');
        db.close();
        logger.info('Database closed');
        logger.info('Graceful shutdown complete');
        finish(0);
      })
      .catch((err: unknown) => {
        logger.error('Error during shutdown', { err: err instanceof Error ? err : String(err) });
        finish(1);
      });
  });
}
