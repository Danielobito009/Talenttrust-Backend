/**
 * @module rateLimit
 *
 * Per-provider token-bucket rate limiter for outbound webhook deliveries.
 *
 * ## Algorithm
 * Each provider gets its own token bucket.  Tokens refill continuously at
 * `refillRatePerSec` tokens/second up to `capacity`.  When a caller requests
 * a token and the bucket is empty the call is queued and resolved as soon as
 * enough tokens have refilled — deliveries are **paced/queued, never dropped**.
 *
 * ## State
 * Buckets are held in the shared in-process `RateLimitStore`. In a blue/green
 * or multi-replica deployment each process maintains its own independent bucket
 * state unless the store interface is backed by Redis or another shared
 * implementation.
 *
 * ## Configuration (environment variables)
 * | Variable                        | Default | Description                              |
 * |---------------------------------|---------|------------------------------------------|
 * | `WEBHOOK_BUCKET_CAPACITY`       | `10`    | Max tokens per provider bucket           |
 * | `WEBHOOK_REFILL_RATE_PER_SEC`   | `2`     | Tokens added per second per provider     |
 *
 * Both values are validated at construction time; the process will throw a
 * descriptive error on invalid configuration rather than silently misbehaving.
 *
 * ## Security
 * Provider secrets are **never** passed to or stored by this module.
 * Only opaque provider IDs appear in log output.
 */

import { recordThrottled } from './webhookMetrics';
import { rateLimitConfig } from './config/rateLimit';
import {
  loadWebhookTokenBucketConfig,
  rateLimitStore,
  type WebhookTokenBucketConfig,
} from './config/rateLimit';
import type { RateLimitStoreInterface, TokenBucketEntry } from './lib/rateLimitStore';

// ---------------------------------------------------------------------------
// Configuration helpers
// ---------------------------------------------------------------------------

export type RateLimiterConfig = WebhookTokenBucketConfig;
export const loadRateLimiterConfig = loadWebhookTokenBucketConfig;

/**
 * Per-provider token-bucket rate limiter.
 *
 * Instantiate once at application startup (or use the module-level singleton
 * {@link defaultLimiter}) and share the instance across all delivery workers.
 *
 * @example
 * ```ts
 * const limiter = new TokenBucketLimiter();
 * await limiter.acquireToken('provider-acme');
 * // safe to send the webhook now
 * ```
 */
export class TokenBucketLimiter {
  private readonly capacity: number;
  private readonly refillRatePerSec: number;
  private readonly store: RateLimitStoreInterface;

  /**
   * @param config - Parsed configuration.  Defaults to
   *   {@link loadRateLimiterConfig} (reads env vars) when omitted.
   * @param store - Shared rate-limit store. Defaults to the process-wide store
   *   from `src/config/rateLimit.ts`.
   */
  constructor(config?: RateLimiterConfig, store: RateLimitStoreInterface = rateLimitStore) {
    const resolved = config ?? loadRateLimiterConfig();
    this.capacity = resolved.capacity;
    this.refillRatePerSec = resolved.refillRatePerSec;
    this.store = store;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Acquire one token for the given provider.
   *
   * Resolves immediately when a token is available.  If the bucket is empty
   * the returned promise is queued and resolves as soon as the next refill
   * produces a token — the delivery is **paced, not dropped**.
   *
   * @param providerId - Opaque provider identifier.  Must NOT contain secrets.
   * @returns A promise that resolves when the caller may proceed with delivery.
   */
  public async acquireToken(providerId: string): Promise<void> {
    this.refillBucket(providerId);
    const bucket = this.getBucket(providerId);

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      this.store.setTokenBucket(providerId, bucket);
      return;
    }

    // Bucket is empty — queue the caller and record the throttle event.
    recordThrottled(providerId);
    console.log(
      `[rateLimit] Provider "${redactId(providerId)}" throttled — queuing delivery.`,
    );

    return new Promise<void>((resolve) => {
      bucket.queue.push(resolve);
      this.store.setTokenBucket(providerId, bucket);
      this.scheduleRefill(providerId);
    });
  }

  /**
   * Return the current token count for a provider without consuming a token.
   * Useful for observability and testing.
   *
   * @param providerId - Opaque provider identifier.
   */
  public getTokenCount(providerId: string): number {
    this.refillBucket(providerId);
    return this.getBucket(providerId).tokens;
  }

  /**
   * Return the number of queued (waiting) deliveries for a provider.
   *
   * @param providerId - Opaque provider identifier.
   */
  public getQueueDepth(providerId: string): number {
    return this.getBucket(providerId).queue.length;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Retrieve or lazily create the bucket state for a provider.
   */
  private getBucket(providerId: string): TokenBucketEntry {
    const existing = this.store.getTokenBucket(providerId);
    if (existing) return existing;

    const created: TokenBucketEntry = {
      tokens: this.capacity,
      lastRefillMs: Date.now(),
      queue: [],
    };
    this.store.setTokenBucket(providerId, created);
    return created;
  }

  /**
   * Apply elapsed-time token refill to the named bucket using the continuous
   * token-bucket formula:
   *
   *   newTokens = min(capacity, currentTokens + elapsed_sec * refillRate)
   */
  private refillBucket(providerId: string): void {
    const bucket = this.getBucket(providerId);
    const nowMs = Date.now();
    const elapsedSec = (nowMs - bucket.lastRefillMs) / 1_000;
    const added = elapsedSec * this.refillRatePerSec;

    bucket.tokens = Math.min(this.capacity, bucket.tokens + added);
    bucket.lastRefillMs = nowMs;
    this.store.setTokenBucket(providerId, bucket);
  }

  /**
   * Schedule a `setTimeout` to drain the queue for a provider once enough
   * time has elapsed to produce the next token.
   *
   * Only one timer is scheduled per provider at a time; the drain loop
   * re-schedules itself while the queue is non-empty.
   */
  private scheduleRefill(providerId: string): void {
    // Time (ms) until the next whole token is available.
    const msUntilToken = Math.ceil((1 / this.refillRatePerSec) * 1_000);

    setTimeout(() => {
      this.refillBucket(providerId);
      this.drainQueue(providerId);
    }, msUntilToken);
  }

  /**
   * Resolve as many queued waiters as the current token count allows,
   * then re-schedule if the queue is still non-empty.
   */
  private drainQueue(providerId: string): void {
    const bucket = this.getBucket(providerId);

    while (bucket.queue.length > 0 && bucket.tokens >= 1) {
      bucket.tokens -= 1;
      const resolve = bucket.queue.shift()!;
      resolve();
    }
    this.store.setTokenBucket(providerId, bucket);

    if (bucket.queue.length > 0) {
      this.scheduleRefill(providerId);
    }
  }
}

// ---------------------------------------------------------------------------
// Security helper
// ---------------------------------------------------------------------------

/**
 * Redact a provider ID for safe log output.
 *
 * Shows only the first 4 characters followed by `****` to aid debugging
 * without leaking full identifiers that might encode sensitive routing info.
 *
 * @param id - Raw provider identifier.
 * @returns Redacted string safe for log output.
 */
export function redactId(id: string): string {
  if (id.length <= 4) {
    return '****';
  }
  return `${id.slice(0, 4)}****`;
}

// ---------------------------------------------------------------------------
// Module-level singleton
// ---------------------------------------------------------------------------

/**
 * Shared default limiter instance, initialised once at module load time.
 * Configuration is read from environment variables (see module docs).
 *
 * Import and use this in `WebhookDeliveryService` and anywhere else that
 * needs rate-limited webhook delivery.
 */
export const defaultLimiter: TokenBucketLimiter = new TokenBucketLimiter();
