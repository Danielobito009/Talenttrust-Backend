const mockRedis = {
  eval: jest.fn(),
  disconnect: jest.fn().mockResolvedValue(undefined),
};

jest.mock('ioredis', () => {
  return {
    default: jest.fn().mockImplementation(() => mockRedis),
    __esModule: true,
  };
});

import { TokenBucketLimiter, MemoryBucketStore, RedisBucketStore } from './rateLimit';

describe('TokenBucketLimiter', () => {
  let systemTime = 1000000;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    systemTime = 1000000;
    jest.spyOn(Date, 'now').mockImplementation(() => systemTime);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('MemoryBucketStore', () => {
    it('should consume tokens and refill continuously', async () => {
      const limiter = new TokenBucketLimiter({
        capacity: 3,
        refillRatePerSec: 1,
        store: new MemoryBucketStore(),
      });

      // Consume tokens
      await expect(limiter.acquireToken('p1')).resolves.toBeUndefined();
      await expect(limiter.acquireToken('p1')).resolves.toBeUndefined();
      await expect(limiter.acquireToken('p1')).resolves.toBeUndefined();

      expect(limiter.getQueueDepth('p1')).toBe(0);

      // Next one should queue
      const req4 = limiter.acquireToken('p1');

      // Yield microtasks so acquireToken executes past the await store.consume
      await Promise.resolve();
      await Promise.resolve();

      // Queue depth should be 1
      expect(limiter.getQueueDepth('p1')).toBe(1);

      // Fast forward 1 second (should refill 1 token)
      systemTime += 1000;
      jest.advanceTimersByTime(1000);

      // Await the queued promise directly
      await expect(req4).resolves.toBeUndefined();
      expect(limiter.getQueueDepth('p1')).toBe(0);
    });

    it('should cap tokens at capacity', async () => {
      const limiter = new TokenBucketLimiter({
        capacity: 2,
        refillRatePerSec: 10,
        store: new MemoryBucketStore(),
      });

      // Let it sit to refill
      systemTime += 5000;
      jest.advanceTimersByTime(5000);

      // Can only acquire up to capacity (2)
      await expect(limiter.acquireToken('p2')).resolves.toBeUndefined();
      await expect(limiter.acquireToken('p2')).resolves.toBeUndefined();

      void limiter.acquireToken('p2');

      // Yield microtasks
      await Promise.resolve();
      await Promise.resolve();

      expect(limiter.getQueueDepth('p2')).toBe(1);
    });
  });

  describe('RedisBucketStore Mocked Tests', () => {
    it('should evaluate Lua script on consume', async () => {
      // Mock evaluation to return [allowed=1, tokens=4]
      mockRedis.eval.mockResolvedValue([1, 4]);

      const store = new RedisBucketStore({ host: 'localhost', port: 6379 });
      const result = await store.consume('p3', 5, 2);

      expect(mockRedis.eval).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ allowed: true, tokens: 4 });

      // Check that the script arguments are correct
      const args = mockRedis.eval.mock.calls[0];
      expect(args[0]).toContain('KEYS[1]');
      expect(args[1]).toBe(1); // numKeys
      expect(args[2]).toBe('rate_limit:bucket:p3'); // key
      expect(args[3]).toBe('5'); // capacity
      expect(args[4]).toBe('2'); // refillRatePerSec
    });

    it('should evaluate Lua script on getTokens', async () => {
      mockRedis.eval.mockResolvedValue(3.5);

      const store = new RedisBucketStore({ host: 'localhost', port: 6379 });
      const tokens = await store.getTokens('p3', 5, 2);

      expect(mockRedis.eval).toHaveBeenCalledTimes(1);
      expect(tokens).toBe(3.5);
    });

    it('should propagate Redis error and fail-closed when Redis fails', async () => {
      const redisError = new Error('Redis connection lost');
      mockRedis.eval.mockRejectedValue(redisError);

      const limiter = new TokenBucketLimiter({
        capacity: 5,
        refillRatePerSec: 2,
        store: new RedisBucketStore({ host: 'localhost', port: 6379 }),
      });

      await expect(limiter.acquireToken('p3')).rejects.toThrow('Redis connection lost');
    });

    it('should enforce limits across concurrent requests atomically', async () => {
      // Mock state: capacity=2.
      // We will mock `eval` to simulate token depletion sequentially.
      // First 2 calls allowed (1), 3rd call rejected (0).
      let callCount = 0;
      mockRedis.eval.mockImplementation(async () => {
        callCount++;
        if (callCount <= 2) {
          return [1, 2 - callCount];
        }
        return [0, 0];
      });

      const limiter = new TokenBucketLimiter({
        capacity: 2,
        refillRatePerSec: 1,
        store: new RedisBucketStore({ host: 'localhost', port: 6379 }),
      });

      const req1 = limiter.acquireToken('p4');
      const req2 = limiter.acquireToken('p4');
      void limiter.acquireToken('p4');

      // The first two should resolve immediately
      await expect(req1).resolves.toBeUndefined();
      await expect(req2).resolves.toBeUndefined();

      // Yield microtasks
      await Promise.resolve();
      await Promise.resolve();

      // The third one should be queued
      expect(limiter.getQueueDepth('p4')).toBe(1);
    });

    it('should support cross-instance sharing of bucket state via Redis client', async () => {
      let tokensLeft = 1;
      mockRedis.eval.mockImplementation(async (script: string) => {
        if (script.includes('tokens - 1.0')) {
          if (tokensLeft >= 1) {
            tokensLeft--;
            return [1, tokensLeft];
          }
          return [0, tokensLeft];
        } else {
          return tokensLeft;
        }
      });

      const store = new RedisBucketStore({ host: 'localhost', port: 6379 });

      // Instance A
      const limiterA = new TokenBucketLimiter({
        capacity: 1,
        refillRatePerSec: 1,
        store,
      });

      // Instance B
      const limiterB = new TokenBucketLimiter({
        capacity: 1,
        refillRatePerSec: 1,
        store,
      });

      // Instance A consumes the only token
      await expect(limiterA.acquireToken('shared')).resolves.toBeUndefined();

      // Instance B tries to consume and should get queued
      void limiterB.acquireToken('shared');

      // Yield microtasks
      await Promise.resolve();
      await Promise.resolve();

      expect(limiterB.getQueueDepth('shared')).toBe(1);
    });
  });
});
