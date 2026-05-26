/**
 * @module webhookDelivery
 * @description Webhook delivery service with HMAC signing, timestamp tolerance,
 * replay protection, and multi-key rotation support.
 *
 * ## Security model
 * - Outbound payloads are signed with the **primary** (first) key.
 * - Inbound verification accepts **any** active key (constant-time comparison).
 * - Timestamps must be within `WEBHOOK_TIMESTAMP_TOLERANCE_S` seconds of now.
 * - Each `(signature, timestamp)` pair is stored in SQLite for the tolerance
 *   window; replays are rejected before any business logic runs.
 * - Secrets are never logged; use `redactSecret` at all log call-sites.
 *
 * ## Environment variables
 * | Variable | Default | Description |
 * |---|---|---|
 * | `WEBHOOK_SIGNING_SECRETS` | *(required)* | Comma-separated ordered list of HMAC-SHA256 secrets. First = primary. |
 * | `WEBHOOK_TIMESTAMP_TOLERANCE_S` | `300` | Max age (seconds) of an accepted timestamp. |
 */

import crypto from 'crypto';
import axios from 'axios';
import type Database from 'better-sqlite3';
import { getDb } from './db/database';
import { logger } from './logger';
import { redactSecret } from './utils/redact';
import {
  WebhookSignatureError,
  WebhookTimestampError,
  WebhookReplayError,
} from './errors/safeErrors';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Default tolerance window in seconds. */
const DEFAULT_TOLERANCE_S = 300;

/**
 * Parses the ordered list of signing secrets from the environment.
 * The first entry is the primary (used for signing outbound payloads).
 *
 * @throws {Error} If no secrets are configured.
 */
export function loadSigningSecrets(): string[] {
  const raw = process.env['WEBHOOK_SIGNING_SECRETS'] ?? '';
  const secrets = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (secrets.length === 0) {
    throw new Error(
      'WEBHOOK_SIGNING_SECRETS must contain at least one secret. ' +
        'Set it in your environment or .env file.',
    );
  }
  return secrets;
}

/** Returns the configured tolerance window in seconds. */
export function getToleranceSeconds(): number {
  const raw = process.env['WEBHOOK_TIMESTAMP_TOLERANCE_S'];
  if (!raw) return DEFAULT_TOLERANCE_S;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TOLERANCE_S;
}

// ---------------------------------------------------------------------------
// DB helpers — replay cache
// ---------------------------------------------------------------------------

/**
 * Ensures the `webhook_replay_cache` table exists.
 * Called lazily on first use so tests can pass an in-memory DB.
 */
export function ensureReplayCacheTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS webhook_replay_cache (
      signature TEXT NOT NULL PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wrc_expires ON webhook_replay_cache(expires_at);
  `);
}

/**
 * Evicts expired entries and checks whether `signature` has been seen.
 *
 * @returns `true` if the signature is a replay (already in cache).
 */
export function isReplay(db: Database.Database, signature: string, nowS: number): boolean {
  ensureReplayCacheTable(db);
  // Evict expired entries first
  db.prepare('DELETE FROM webhook_replay_cache WHERE expires_at <= ?').run(nowS);
  const row = db
    .prepare('SELECT 1 FROM webhook_replay_cache WHERE signature = ?')
    .get(signature);
  return row !== undefined;
}

/**
 * Records a signature in the replay cache with a TTL of `toleranceS` seconds.
 */
export function recordSignature(
  db: Database.Database,
  signature: string,
  nowS: number,
  toleranceS: number,
): void {
  ensureReplayCacheTable(db);
  db.prepare(
    'INSERT OR IGNORE INTO webhook_replay_cache (signature, expires_at) VALUES (?, ?)',
  ).run(signature, nowS + toleranceS);
}

// ---------------------------------------------------------------------------
// HMAC helpers
// ---------------------------------------------------------------------------

/**
 * Computes HMAC-SHA256 of `payload` using `secret`.
 *
 * @param secret  - Signing secret (never logged).
 * @param payload - Raw string to sign (typically `timestamp + '.' + body`).
 */
export function computeHmac(secret: string, payload: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

/**
 * Constant-time comparison of two hex HMAC digests.
 * Returns `true` if they match.
 */
export function safeEqual(a: string, b: string): boolean {
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Inbound verification
// ---------------------------------------------------------------------------

export interface VerifyOptions {
  /** Raw request body as a string. */
  body: string;
  /** Value of the `X-Webhook-Signature` header (hex HMAC). */
  signature: string;
  /** Value of the `X-Webhook-Timestamp` header (Unix seconds as string). */
  timestamp: string;
  /** Ordered list of active signing secrets (primary first). */
  secrets?: string[];
  /** Override current time in seconds (for testing). */
  nowS?: number;
  /** Override tolerance window in seconds (for testing). */
  toleranceS?: number;
  /** Override database instance (for testing). */
  db?: Database.Database;
}

/**
 * Verifies an inbound webhook request.
 *
 * Checks (in order):
 * 1. Timestamp is a valid integer.
 * 2. Timestamp is within the tolerance window.
 * 3. HMAC matches at least one active signing key (constant-time).
 * 4. Signature has not been seen before (replay protection).
 *
 * @throws {WebhookTimestampError}  Timestamp missing, non-numeric, or out of window.
 * @throws {WebhookSignatureError}  No active key produces a matching HMAC.
 * @throws {WebhookReplayError}     Signature has been seen within the window.
 *
 * @returns The index of the matching key (0 = primary). Callers may emit a
 *          metric when `matchedKeyIndex > 0` to detect rotation lag.
 */
export function verifyWebhookSignature(opts: VerifyOptions): number {
  const {
    body,
    signature,
    timestamp,
    secrets: secretsOverride,
    nowS: nowOverride,
    toleranceS: toleranceOverride,
    db: dbOverride,
  } = opts;

  const nowS = nowOverride ?? Math.floor(Date.now() / 1000);
  const toleranceS = toleranceOverride ?? getToleranceSeconds();
  const secrets = secretsOverride ?? loadSigningSecrets();
  const db = dbOverride ?? getDb();

  // 1. Validate timestamp
  const ts = Number(timestamp);
  if (!Number.isInteger(ts) || !Number.isFinite(ts)) {
    logger.warn('Webhook timestamp invalid', { timestamp: redactSecret(timestamp) });
    throw new WebhookTimestampError();
  }

  // 2. Tolerance window
  const age = Math.abs(nowS - ts);
  if (age > toleranceS) {
    logger.warn('Webhook timestamp outside tolerance', { age, toleranceS });
    throw new WebhookTimestampError();
  }

  // 3. HMAC verification — try each active key
  const signingPayload = `${timestamp}.${body}`;
  let matchedKeyIndex = -1;
  for (let i = 0; i < secrets.length; i++) {
    const expected = computeHmac(secrets[i]!, signingPayload);
    if (safeEqual(expected, signature)) {
      matchedKeyIndex = i;
      break;
    }
  }

  if (matchedKeyIndex === -1) {
    logger.warn('Webhook HMAC verification failed', {
      signature: redactSecret(signature),
    });
    throw new WebhookSignatureError();
  }

  // 4. Replay check
  if (isReplay(db, signature, nowS)) {
    logger.warn('Webhook replay detected', { signature: redactSecret(signature) });
    throw new WebhookReplayError();
  }

  // Record signature to prevent future replays
  recordSignature(db, signature, nowS, toleranceS);

  if (matchedKeyIndex > 0) {
    logger.info('Webhook verified with non-primary key (rotation in progress)', {
      matchedKeyIndex,
    });
  }

  return matchedKeyIndex;
}

// ---------------------------------------------------------------------------
// Outbound delivery
// ---------------------------------------------------------------------------

export interface WebhookDeliveryPayload {
  id: string;
  url: string;
  event: string;
  data: unknown;
  retryCount: number;
}

interface DLQEntry extends WebhookDeliveryPayload {
  failedAt: Date;
  lastError: string;
}

const MAX_RETRIES = 5;
const INITIAL_DELAY_MS = 1000;

/**
 * Webhook delivery service.
 *
 * Signs outbound payloads with the primary HMAC key and delivers them with
 * exponential backoff.  Failed deliveries after `MAX_RETRIES` are moved to
 * an in-memory DLQ (replace with durable storage in production).
 */
export class WebhookDeliveryService {
  private readonly dlq: DLQEntry[] = [];

  /**
   * Sends a signed webhook with exponential backoff.
   *
   * @param payload - Delivery payload including target URL and event data.
   * @param secrets - Optional secrets override (for testing).
   */
  async send(
    payload: WebhookDeliveryPayload,
    secrets?: string[],
  ): Promise<void> {
    const activeSecrets = secrets ?? loadSigningSecrets();
    const primarySecret = activeSecrets[0]!;
    const timestampS = String(Math.floor(Date.now() / 1000));
    const body = JSON.stringify(payload.data);
    const signature = computeHmac(primarySecret, `${timestampS}.${body}`);

    try {
      await axios.post(payload.url, payload.data, {
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Signature': signature,
          'X-Webhook-Timestamp': timestampS,
        },
      });
      logger.info('Webhook delivered', { id: payload.id });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (payload.retryCount < MAX_RETRIES) {
        const delay = INITIAL_DELAY_MS * Math.pow(2, payload.retryCount);
        payload.retryCount++;
        logger.warn('Webhook delivery failed, retrying', {
          id: payload.id,
          retryCount: payload.retryCount,
          delayMs: delay,
        });
        setTimeout(() => void this.send(payload, secrets), delay);
      } else {
        this.moveToDlq(payload, message);
      }
    }
  }

  private moveToDlq(payload: WebhookDeliveryPayload, error: string): void {
    this.dlq.push({ ...payload, failedAt: new Date(), lastError: error });
    logger.error('Webhook moved to DLQ', { id: payload.id });
  }

  getDlq(): DLQEntry[] {
    return this.dlq;
  }
}
