import { RateLimitStore } from './lib/rateLimitStore';
import { TokenBucketLimiter, loadRateLimiterConfig } from './rateLimit';

jest.mock('./webhookMetrics', () => ({
  recordThrottled: jest.fn(),
}));

describe('TokenBucketLimiter unified store integration', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('stores provider buckets in the unified rate-limit store', async () => {
    const store = new RateLimitStore({ sweepIntervalMs: 0 });
    const limiter = new TokenBucketLimiter({ capacity: 2, refillRatePerSec: 1 }, store);

    await limiter.acquireToken('provider-a');
    await limiter.acquireToken('provider-b');

    expect(store.tokenBucketSize).toBe(2);
    expect(store.getTokenBucket('provider-a')?.tokens).toBe(1);
    expect(store.getTokenBucket('provider-b')?.tokens).toBe(1);

    store.destroy();
  });

  it('preserves token-bucket queuing and refill behavior', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);

    const store = new RateLimitStore({ sweepIntervalMs: 0 });
    const limiter = new TokenBucketLimiter({ capacity: 1, refillRatePerSec: 1 }, store);

    await limiter.acquireToken('provider-a');
    const queued = limiter.acquireToken('provider-a');

    expect(limiter.getQueueDepth('provider-a')).toBe(1);
    expect(store.getTokenBucket('provider-a')?.queue).toHaveLength(1);

    jest.setSystemTime(2_000);
    jest.advanceTimersByTime(1_000);
    await queued;

    expect(limiter.getQueueDepth('provider-a')).toBe(0);
    expect(store.getTokenBucket('provider-a')?.tokens).toBe(0);

    store.destroy();
  });
});

describe('loadRateLimiterConfig', () => {
  it('reads token-bucket defaults from centralized rate-limit config', () => {
    const originalCapacity = process.env.WEBHOOK_BUCKET_CAPACITY;
    const originalRefill = process.env.WEBHOOK_REFILL_RATE_PER_SEC;
    process.env.WEBHOOK_BUCKET_CAPACITY = '7';
    process.env.WEBHOOK_REFILL_RATE_PER_SEC = '3';

    expect(loadRateLimiterConfig()).toEqual({ capacity: 7, refillRatePerSec: 3 });

    if (originalCapacity === undefined) {
      delete process.env.WEBHOOK_BUCKET_CAPACITY;
    } else {
      process.env.WEBHOOK_BUCKET_CAPACITY = originalCapacity;
    }

    if (originalRefill === undefined) {
      delete process.env.WEBHOOK_REFILL_RATE_PER_SEC;
    } else {
      process.env.WEBHOOK_REFILL_RATE_PER_SEC = originalRefill;
    }
  });
});
