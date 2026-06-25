/**
 * @module health/probes
 * @description Built-in dependency probes for the health check subsystem.
 *
 * Each probe is a zero-argument async function returning a {@link ProbeResult}.
 * Add new probes here and register them in {@link runHealthCheck}.
 */

import Redis from "ioredis";
import { getDb } from "../db/database";
import { ProbeResult } from "./types";
import { QueueManager } from "../queue/queue-manager";
import { circuitBreakerRegistry } from "../circuit-breaker/registry";

const REDIS_PROBE_TIMEOUT_MS = 3_000;

/**
 * Probe: verify required environment variables are present.
 * Does NOT expose values — only checks existence.
 */
export async function envProbe(): Promise<ProbeResult> {
  const start = Date.now();
  const required = (process.env.REQUIRED_ENV_VARS ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);

  const missing = required.filter((key) => !process.env[key]);
  const ok = missing.length === 0;

  return {
    name: "env",
    ok,
    detail: ok ? undefined : `Missing vars: ${missing.join(", ")}`,
    latencyMs: Date.now() - start,
  };
}

/**
 * Probe: reachability check for the configured Stellar/Soroban RPC endpoint.
 * Uses a lightweight GET to the horizon or soroban-rpc base URL.
 * Aborts after 5 seconds to avoid blocking the health response.
 */
export async function stellarRpcProbe(): Promise<ProbeResult> {
  const url = process.env.STELLAR_RPC_URL ?? "";
  const start = Date.now();

  if (!url) {
    return {
      name: "stellar-rpc",
      ok: false,
      detail: "STELLAR_RPC_URL not set",
      latencyMs: 0,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  timeout.unref();

  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal });

    const latencyMs = Date.now() - start;
    const ok = res.status < 500;
    return {
      name: "stellar-rpc",
      ok,
      detail: ok ? undefined : `HTTP ${res.status}`,
      latencyMs,
    };
  } catch (err: unknown) {
    return {
      name: "stellar-rpc",
      ok: false,
      detail: err instanceof Error ? err.message : "unknown error",
      latencyMs: Date.now() - start,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Probe: verify the SQLite database is reachable with a lightweight SELECT 1.
 * Uses the shared singleton returned by {@link getDb}.
 */
export async function dbProbe(): Promise<ProbeResult> {
  const start = Date.now();
  try {
    getDb().prepare("SELECT 1").run();
    return { name: "db", ok: true, latencyMs: Date.now() - start };
  } catch (err: unknown) {
    return {
      name: "db",
      ok: false,
      detail: err instanceof Error ? err.message : "unknown error",
      latencyMs: Date.now() - start,
    };
  }
}

/**
 * Probe: verify Redis is reachable with a PING command.
 * Opens a short-lived connection using environment configuration, sends PING,
 * then disconnects. Times out after {@link REDIS_PROBE_TIMEOUT_MS} ms.
 */
export async function redisProbe(): Promise<ProbeResult> {
  const start = Date.now();
  const host = process.env["REDIS_HOST"] ?? "localhost";
  const port = parseInt(process.env["REDIS_PORT"] ?? "6379", 10);
  const password = process.env["REDIS_PASSWORD"] || undefined;

  const client = new Redis({
    host,
    port,
    password,
    connectTimeout: REDIS_PROBE_TIMEOUT_MS,
    commandTimeout: REDIS_PROBE_TIMEOUT_MS,
    maxRetriesPerRequest: 0,
    enableReadyCheck: false,
    lazyConnect: true,
  });

  // Suppress unhandled-error events — errors are captured via the try/catch.
  client.on("error", () => undefined);

  try {
    await client.connect();
    await client.ping();
    return { name: "redis", ok: true, latencyMs: Date.now() - start };
  } catch (err: unknown) {
    return {
      name: "redis",
      ok: false,
      detail: err instanceof Error ? err.message : "unknown error",
      latencyMs: Date.now() - start,
    };
  } finally {
    try {
      client.disconnect();
    } catch {
      // best-effort cleanup
    }
  }
}

const QUEUE_PROBE_TIMEOUT_MS = 3_000;

/**
 * Probe: checks BullMQ queue health via {@link QueueManager.getHealth}.
 *
 * Reports `degraded` when any queue has failed-job count above
 * `QUEUE_FAILED_THRESHOLD` or waiting backlog above `QUEUE_BACKLOG_THRESHOLD`.
 * The probe resolves in at most `QUEUE_PROBE_TIMEOUT_MS` ms.
 *
 * Thresholds are configurable via env at call time:
 * - `QUEUE_PROBE_TIMEOUT_MS` (default 3000)
 * - `QUEUE_FAILED_THRESHOLD` (default 10)
 * - `QUEUE_BACKLOG_THRESHOLD` (default 100)
 */
export async function queueProbe(): Promise<ProbeResult> {
  const timeoutMs = parseInt(process.env["QUEUE_PROBE_TIMEOUT_MS"] ?? String(QUEUE_PROBE_TIMEOUT_MS), 10);
  const failedThreshold = parseInt(process.env["QUEUE_FAILED_THRESHOLD"] ?? "10", 10);
  const backlogThreshold = parseInt(process.env["QUEUE_BACKLOG_THRESHOLD"] ?? "100", 10);
  const start = Date.now();
  try {
    const healthInfos = await Promise.race([
      QueueManager.getInstance().getHealth(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("queue probe timeout")), timeoutMs)
      ),
    ]);

    const violations: string[] = [];
    for (const q of healthInfos) {
      if (q.failed > failedThreshold) {
        violations.push(`${q.jobType}: ${q.failed} failed jobs`);
      }
      if (q.waiting > backlogThreshold) {
        violations.push(`${q.jobType}: ${q.waiting} waiting jobs`);
      }
    }

    const ok = violations.length === 0;
    return {
      name: "queue",
      ok,
      detail: ok ? undefined : violations.join("; "),
      latencyMs: Date.now() - start,
    };
  } catch (err: unknown) {
    return {
      name: "queue",
      ok: false,
      detail: err instanceof Error ? err.message : "unknown error",
      latencyMs: Date.now() - start,
    };
  }
}

/**
 * Probe: reports the number of open circuit breakers from
 * {@link circuitBreakerRegistry}.
 *
 * Returns `ok: false` (degraded) when at least one breaker is in the OPEN
 * state. Detail is a count of open breakers — no internal topology is exposed.
 */
export async function circuitBreakerProbe(): Promise<ProbeResult> {
  const start = Date.now();
  try {
    const statuses = circuitBreakerRegistry.getAll();
    const openCount = statuses.filter((s) => s.state === "OPEN").length;
    const ok = openCount === 0;
    return {
      name: "circuit-breaker",
      ok,
      detail: ok ? undefined : `${openCount} breaker(s) open`,
      latencyMs: Date.now() - start,
    };
  } catch (err: unknown) {
    return {
      name: "circuit-breaker",
      ok: false,
      detail: err instanceof Error ? err.message : "unknown error",
      latencyMs: Date.now() - start,
    };
  }
}
