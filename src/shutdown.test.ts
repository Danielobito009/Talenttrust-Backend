/**
 * Tests for shutdown.ts (#282)
 *
 * Covers:
 *  - Clean drain within grace period
 *  - Forced exit on grace timeout
 *  - Double-signal idempotency
 *  - DB and queue handles closed exactly once
 *  - Readiness flips to not-ready
 */

import { EventEmitter } from 'events';
import type { Server } from 'http';
import { gracefulShutdown, _resetShutdownState } from './shutdown';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeServer(closeErr?: Error): Server {
  const emitter = new EventEmitter() as unknown as Server;
  (emitter as unknown as { close: (cb: (err?: Error) => void) => void }).close = (
    cb: (err?: Error) => void,
  ) => {
    setImmediate(() => cb(closeErr));
  };
  return emitter;
}

function makeDb(closeFn = jest.fn()): { close: jest.Mock } {
  return { close: closeFn };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('gracefulShutdown', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    _resetShutdownState();
  });

  afterEach(() => {
    jest.useRealTimers();
    _resetShutdownState();
  });

  it('clean drain: closes server, drains queue, closes DB, exits 0', async () => {
    const exit = jest.fn();
    const dbClose = jest.fn();
    const drainQueue = jest.fn().mockResolvedValue(undefined);
    const setNotReady = jest.fn();

    const p = gracefulShutdown({
      server: makeServer(),
      db: makeDb(dbClose) as any,
      drainQueue,
      setNotReady,
      gracePeriodMs: 5000,
      exit,
    });

    await jest.runAllTimersAsync();
    await p;

    expect(setNotReady).toHaveBeenCalledTimes(1);
    expect(drainQueue).toHaveBeenCalledTimes(1);
    expect(dbClose).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('forced exit: calls exit(1) when grace period expires before drain completes', async () => {
    const exit = jest.fn();
    const setNotReady = jest.fn();
    // drainQueue never resolves
    const drainQueue = jest.fn().mockReturnValue(new Promise(() => {}));

    const p = gracefulShutdown({
      server: makeServer(),
      db: makeDb() as any,
      drainQueue,
      setNotReady,
      gracePeriodMs: 100,
      exit,
    });

    // Advance past grace period
    jest.advanceTimersByTime(200);
    await jest.runAllTimersAsync();

    // The force timer fires exit(1)
    expect(exit).toHaveBeenCalledWith(1);

    // Prevent unhandled rejection from the never-resolving promise
    await p.catch(() => {});
  });

  it('double-signal: second call is a no-op (idempotent)', async () => {
    const exit = jest.fn();
    const drainQueue = jest.fn().mockResolvedValue(undefined);
    const setNotReady = jest.fn();
    const dbClose = jest.fn();

    const deps = {
      server: makeServer(),
      db: makeDb(dbClose) as any,
      drainQueue,
      setNotReady,
      gracePeriodMs: 5000,
      exit,
    };

    const p1 = gracefulShutdown(deps);
    const p2 = gracefulShutdown(deps); // duplicate signal

    await jest.runAllTimersAsync();
    await Promise.all([p1, p2]);

    // Drain and DB close called exactly once
    expect(drainQueue).toHaveBeenCalledTimes(1);
    expect(dbClose).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('readiness flips to not-ready before server closes', async () => {
    const order: string[] = [];
    const exit = jest.fn();
    const setNotReady = jest.fn(() => order.push('not-ready'));
    const drainQueue = jest.fn().mockResolvedValue(undefined);

    const server = makeServer();
    const origClose = (server as any).close.bind(server);
    (server as any).close = (cb: (err?: Error) => void) => {
      order.push('server-close');
      origClose(cb);
    };

    const p = gracefulShutdown({
      server,
      db: makeDb() as any,
      drainQueue,
      setNotReady,
      gracePeriodMs: 5000,
      exit,
    });

    await jest.runAllTimersAsync();
    await p;

    expect(order[0]).toBe('not-ready');
    expect(order[1]).toBe('server-close');
  });

  it('exits with code 1 when server.close returns an error', async () => {
    const exit = jest.fn();
    const setNotReady = jest.fn();
    const drainQueue = jest.fn().mockResolvedValue(undefined);

    const p = gracefulShutdown({
      server: makeServer(new Error('close failed')),
      db: makeDb() as any,
      drainQueue,
      setNotReady,
      gracePeriodMs: 5000,
      exit,
    });

    await jest.runAllTimersAsync();
    await p;

    expect(exit).toHaveBeenCalledWith(1);
  });
});
