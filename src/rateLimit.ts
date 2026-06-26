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
 * Buckets can be held in-process (a plain `Map`) or in a shared Redis store
 * for cluster-wide enforcement.
 *
 * ## Configuration (environment variables)
 * | Variable                        | Default | Description                              |
 * |---------------------------------|---------|------------------------------------------|
 * | `WEBHOOK_BUCKET_CAPACITY`       | `10`    | Max tokens per provider bucket           |
 * | `WEBHOOK_REFILL_RATE_PER_SEC`   | `2`     | Tokens added per second per provider     |
 * | `RATE_LIMIT_STORE`              | `memory`| Store type: 'memory' or 'redis'          |
 * | `REDIS_HOST`                    | None    | Redis server hostname                    |
 * | `REDIS_PORT`                    | `6379`  | Redis server port                        |
 * | `REDIS_PASSWORD`                | None    | Redis server password                    |
 *
 * Both values are validated at construction time; the process will throw a
 * descriptive error on invalid configuration rather than silently misbehaving.
 *
 * ## Security
 * Provider secrets are **never** passed to or stored by this module.
 * Only opaque provider IDs appear in log output.
 */

import Redis from 'ioredis';
import { recordThrottled } from './webhookMetrics';

// ---------------------------------------------------------------------------
// Configuration helpers
// ---------------------------------------------------------------------------

/** Validated, parsed rate-limiter configuration. */
export interface RateLimiterConfig {
  /** Maximum number of tokens a single provider bucket can hold. */
  capacity: number;
  /** Number of tokens added to each bucket per second. */
  refillRatePerSec: number;
  /** Backing store instance. If omitted, resolved from env. */
  store?: BucketStore;
}

/**
 * Parse and validate rate-limiter configuration from environment variables.
 *
 * @throws {Error} If any value is missing, non-numeric, non-positive, or
 *   `capacity` is zero (which would make every delivery block forever).
 */
export function loadRateLimiterConfig(): RateLimiterConfig {
  const rawCapacity = process.env.WEBHOOK_BUCKET_CAPACITY ?? '10';
  const rawRefill = process.env.WEBHOOK_REFILL_RATE_PER_SEC ?? '2';

  const capacity = Number(rawCapacity);
  const refillRatePerSec = Number(rawRefill);

  if (!Number.isFinite(capacity) || capacity <= 0) {
    throw new Error(
      `[rateLimit] Invalid WEBHOOK_BUCKET_CAPACITY="${rawCapacity}". ` +
        'Must be a finite positive number greater than zero.',
    );
  }

  if (!Number.isFinite(refillRatePerSec) || refillRatePerSec <= 0) {
    throw new Error(
      `[rateLimit] Invalid WEBHOOK_REFILL_RATE_PER_SEC="${rawRefill}". ` +
        'Must be a finite positive number greater than zero.',
    );
  }

  return { capacity, refillRatePerSec };
}

// ---------------------------------------------------------------------------
// BucketStore abstraction
// ---------------------------------------------------------------------------

/**
 * Represents a storage engine for token bucket state.
 */
export interface BucketStore {
  /**
   * Atomically refills and attempts to consume a token for the given provider.
   *
   * @param providerId - Opaque provider identifier.
   * @param capacity - Maximum number of tokens a bucket can hold.
   * @param refillRatePerSec - Number of tokens refilled per second.
   * @returns Object containing whether consumption was allowed and the current token count.
   */
  consume(
    providerId: string,
    capacity: number,
    refillRatePerSec: number,
  ): Promise<{ allowed: boolean; tokens: number }>;

  /**
   * Retrieves the current token count for a provider after refilling.
   *
   * @param providerId - Opaque provider identifier.
   * @param capacity - Maximum number of tokens a bucket can hold.
   * @param refillRatePerSec - Number of tokens refilled per second.
   */
  getTokens(
    providerId: string,
    capacity: number,
    refillRatePerSec: number,
  ): Promise<number>;
}

// ---------------------------------------------------------------------------
// Memory Store Implementation
// ---------------------------------------------------------------------------

/**
 * Memory-backed implementation of BucketStore.
 */
export class MemoryBucketStore implements BucketStore {
  private readonly buckets: Map<string, { tokens: number; lastRefillMs: number }> = new Map();

  private getOrCreate(providerId: string, capacity: number): { tokens: number; lastRefillMs: number } {
    if (!this.buckets.has(providerId)) {
      this.buckets.set(providerId, {
        tokens: capacity,
        lastRefillMs: Date.now(),
      });
    }
    return this.buckets.get(providerId)!;
  }

  public async consume(
    providerId: string,
    capacity: number,
    refillRatePerSec: number,
  ): Promise<{ allowed: boolean; tokens: number }> {
    return this.consumeSync(providerId, capacity, refillRatePerSec);
  }

  public consumeSync(
    providerId: string,
    capacity: number,
    refillRatePerSec: number,
  ): { allowed: boolean; tokens: number } {
    const bucket = this.getOrCreate(providerId, capacity);
    const nowMs = Date.now();
    const elapsedSec = (nowMs - bucket.lastRefillMs) / 1_000;
    const added = elapsedSec * refillRatePerSec;

    bucket.tokens = Math.min(capacity, bucket.tokens + added);
    bucket.lastRefillMs = nowMs;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, tokens: bucket.tokens };
    }

    return { allowed: false, tokens: bucket.tokens };
  }

  public async getTokens(
    providerId: string,
    capacity: number,
    refillRatePerSec: number,
  ): Promise<number> {
    return this.getTokensSync(providerId, capacity, refillRatePerSec);
  }

  public getTokensSync(
    providerId: string,
    capacity: number,
    refillRatePerSec: number,
  ): number {
    const bucket = this.getOrCreate(providerId, capacity);
    const nowMs = Date.now();
    const elapsedSec = (nowMs - bucket.lastRefillMs) / 1_000;
    const added = elapsedSec * refillRatePerSec;
    return Math.min(capacity, bucket.tokens + added);
  }
}

// ---------------------------------------------------------------------------
// Redis Store Implementation
// ---------------------------------------------------------------------------

/**
 * Redis-backed implementation of BucketStore.
 */
export class RedisBucketStore implements BucketStore {
  private readonly redis: Redis;

  constructor(options: { host: string; port: number; password?: string }) {
    this.redis = new Redis({
      host: options.host,
      port: options.port,
      password: options.password,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  }

  public async consume(
    providerId: string,
    capacity: number,
    refillRatePerSec: number,
  ): Promise<{ allowed: boolean; tokens: number }> {
    const key = `rate_limit:bucket:${providerId}`;
    const nowMs = Date.now();

    const luaScript = `
      local key = KEYS[1]
      local capacity = tonumber(ARGV[1])
      local refill_rate = tonumber(ARGV[2])
      local now_ms = tonumber(ARGV[3])

      local state = redis.call('HMGET', key, 'tokens', 'lastRefillMs')
      local tokens = tonumber(state[1])
      local last_refill_ms = tonumber(state[2])

      if not tokens then
          tokens = capacity
          last_refill_ms = now_ms
      else
          local elapsed_sec = (now_ms - last_refill_ms) / 1000.0
          if elapsed_sec > 0 then
              local added = elapsed_sec * refill_rate
              tokens = math.min(capacity, tokens + added)
              last_refill_ms = now_ms
          end
      end

      local allowed = 0
      if tokens >= 1.0 then
          tokens = tokens - 1.0
          allowed = 1
      end

      redis.call('HMSET', key, 'tokens', tostring(tokens), 'lastRefillMs', tostring(last_refill_ms))

      local ttl = math.max(60, math.ceil(capacity / refill_rate) + 60)
      redis.call('EXPIRE', key, ttl)

      return {allowed, tokens}
    `;

    const result = (await this.redis.eval(
      luaScript,
      1,
      key,
      capacity.toString(),
      refillRatePerSec.toString(),
      nowMs.toString(),
    )) as [number, number];

    return {
      allowed: result[0] === 1,
      tokens: Number(result[1]),
    };
  }

  public async getTokens(
    providerId: string,
    capacity: number,
    refillRatePerSec: number,
  ): Promise<number> {
    const key = `rate_limit:bucket:${providerId}`;
    const nowMs = Date.now();

    const luaScript = `
      local key = KEYS[1]
      local capacity = tonumber(ARGV[1])
      local refill_rate = tonumber(ARGV[2])
      local now_ms = tonumber(ARGV[3])

      local state = redis.call('HMGET', key, 'tokens', 'lastRefillMs')
      local tokens = tonumber(state[1])
      local last_refill_ms = tonumber(state[2])

      if not tokens then
          tokens = capacity
      else
          local elapsed_sec = (now_ms - last_refill_ms) / 1000.0
          if elapsed_sec > 0 then
              local added = elapsed_sec * refill_rate
              tokens = math.min(capacity, tokens + added)
          end
      end

      return tokens
    `;

    const result = await this.redis.eval(
      luaScript,
      1,
      key,
      capacity.toString(),
      refillRatePerSec.toString(),
      nowMs.toString(),
    );

    return Number(result);
  }

  /**
   * Helper to close connection on shutdown.
   */
  public async disconnect(): Promise<void> {
    await this.redis.disconnect();
  }
}

// ---------------------------------------------------------------------------
// Internal bucket state
// ---------------------------------------------------------------------------

interface QueueWaiter {
  resolve: () => void;
  reject: (err: Error) => void;
}

/** Runtime state for a single provider's token bucket. */
interface BucketState {
  /** Current token count (may be fractional between refill ticks). */
  tokens: number;
  /** Timestamp (ms) of the last refill calculation. */
  lastRefillMs: number;
  /** Pending waiters in FIFO order. Each resolves when a token is available. */
  queue: Array<QueueWaiter>;
}

// ---------------------------------------------------------------------------
// TokenBucketLimiter
// ---------------------------------------------------------------------------

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
  private readonly buckets: Map<string, BucketState> = new Map();
  private readonly store: BucketStore;

  /**
   * @param config - Parsed configuration.  Defaults to
   *   {@link loadRateLimiterConfig} (reads env vars) when omitted.
   */
  constructor(config?: RateLimiterConfig) {
    const resolved = config ?? loadRateLimiterConfig();
    this.capacity = resolved.capacity;
    this.refillRatePerSec = resolved.refillRatePerSec;

    if (resolved.store) {
      this.store = resolved.store;
    } else {
      const storeType = process.env.RATE_LIMIT_STORE ?? 'memory';
      if (storeType === 'redis') {
        const host = process.env.REDIS_HOST;
        const port = process.env.REDIS_PORT ? parseInt(process.env.REDIS_PORT, 10) : 6379;
        const password = process.env.REDIS_PASSWORD;

        if (!host) {
          console.warn('[rateLimit] Redis store requested but REDIS_HOST is missing. Falling back to memory store.');
          this.store = new MemoryBucketStore();
        } else {
          this.store = new RedisBucketStore({ host, port, password });
        }
      } else {
        this.store = new MemoryBucketStore();
      }
    }
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
    try {
      const { allowed } = await this.store.consume(providerId, this.capacity, this.refillRatePerSec);

      if (allowed) {
        return;
      }
    } catch (err) {
      console.error(`[rateLimit] Redis error in acquireToken:`, err);
      throw err;
    }

    // Bucket is empty — queue the caller and record the throttle event.
    recordThrottled(providerId);
    console.log(
      `[rateLimit] Provider "${redactId(providerId)}" throttled — queuing delivery.`,
    );

    return new Promise<void>((resolve, reject) => {
      const bucket = this.getOrCreateBucket(providerId);
      bucket.queue.push({ resolve, reject });
      this.scheduleRefill(providerId);
    });
  }

  /**
   * Return the current token count for a provider without consuming a token.
   * Useful for observability and testing.
   *
   * @param providerId - Opaque provider identifier.
   */
  public getTokenCount(providerId: string): number | Promise<number> {
    if (this.store instanceof MemoryBucketStore) {
      return this.store.getTokensSync(providerId, this.capacity, this.refillRatePerSec);
    }
    return this.store.getTokens(providerId, this.capacity, this.refillRatePerSec);
  }

  /**
   * Return the number of queued (waiting) deliveries for a provider.
   *
   * @param providerId - Opaque provider identifier.
   */
  public getQueueDepth(providerId: string): number {
    return this.getOrCreateBucket(providerId).queue.length;
  }

  /**
   * Close connections or clean up resources.
   */
  public async close(): Promise<void> {
    if (this.store instanceof RedisBucketStore) {
      await this.store.disconnect();
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Retrieve or lazily create the bucket state for a provider.
   */
  private getOrCreateBucket(providerId: string): BucketState {
    if (!this.buckets.has(providerId)) {
      this.buckets.set(providerId, {
        tokens: this.capacity,
        lastRefillMs: Date.now(),
        queue: [],
      });
    }
    return this.buckets.get(providerId)!;
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
      this.drainQueue(providerId).catch((err) => {
        console.error(`[rateLimit] Error refilling and draining queue:`, err);
      });
    }, msUntilToken);
  }

  /**
   * Resolve as many queued waiters as the current token count allows,
   * then re-schedule if the queue is still non-empty.
   */
  private async drainQueue(providerId: string): Promise<void> {
    const bucket = this.getOrCreateBucket(providerId);

    while (bucket.queue.length > 0) {
      try {
        const { allowed } = await this.store.consume(providerId, this.capacity, this.refillRatePerSec);
        if (allowed) {
          const waiter = bucket.queue.shift()!;
          waiter.resolve();
        } else {
          break;
        }
      } catch (err) {
        console.error(`[rateLimit] Redis store consume error in drainQueue:`, err);
        // Fail all pending waiters for this provider
        while (bucket.queue.length > 0) {
          const waiter = bucket.queue.shift()!;
          waiter.reject(err instanceof Error ? err : new Error(String(err)));
        }
        break;
      }
    }

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
