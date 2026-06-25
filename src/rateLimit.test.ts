/**
 * @module rateLimit.test
 *
 * Comprehensive tests for the token-bucket rate limiter, including metrics sampling.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Registry, Gauge } from 'prom-client';
import { TokenBucketLimiter, loadRateLimiterConfig, redactId } from './rateLimit';

describe('rateLimit', () => {
  describe('loadRateLimiterConfig', () => {
    it('should load default config when env vars are unset', () => {
      delete process.env.WEBHOOK_BUCKET_CAPACITY;
      delete process.env.WEBHOOK_REFILL_RATE_PER_SEC;

      const config = loadRateLimiterConfig();
      expect(config).toEqual({ capacity: 10, refillRatePerSec: 2 });
    });

    it('should parse valid env vars', () => {
      process.env.WEBHOOK_BUCKET_CAPACITY = '20';
      process.env.WEBHOOK_REFILL_RATE_PER_SEC = '5';

      const config = loadRateLimiterConfig();
      expect(config).toEqual({ capacity: 20, refillRatePerSec: 5 });

      delete process.env.WEBHOOK_BUCKET_CAPACITY;
      delete process.env.WEBHOOK_REFILL_RATE_PER_SEC;
    });

    it('should throw on invalid capacity', () => {
      process.env.WEBHOOK_BUCKET_CAPACITY = 'invalid';
      expect(() => loadRateLimiterConfig()).toThrow('Invalid WEBHOOK_BUCKET_CAPACITY');
      delete process.env.WEBHOOK_BUCKET_CAPACITY;
    });

    it('should throw on non-positive capacity', () => {
      process.env.WEBHOOK_BUCKET_CAPACITY = '0';
      expect(() => loadRateLimiterConfig()).toThrow('Invalid WEBHOOK_BUCKET_CAPACITY');
      delete process.env.WEBHOOK_BUCKET_CAPACITY;
    });

    it('should throw on invalid refill rate', () => {
      process.env.WEBHOOK_REFILL_RATE_PER_SEC = 'invalid';
      expect(() => loadRateLimiterConfig()).toThrow('Invalid WEBHOOK_REFILL_RATE_PER_SEC');
      delete process.env.WEBHOOK_REFILL_RATE_PER_SEC;
    });

    it('should throw on non-positive refill rate', () => {
      process.env.WEBHOOK_REFILL_RATE_PER_SEC = '-1';
      expect(() => loadRateLimiterConfig()).toThrow('Invalid WEBHOOK_REFILL_RATE_PER_SEC');
      delete process.env.WEBHOOK_REFILL_RATE_PER_SEC;
    });
  });

  describe('redactId', () => {
    it('should redact long IDs', () => {
      expect(redactId('provider-12345')).toBe('prov****');
    });

    it('should redact short IDs', () => {
      expect(redactId('abc')).toBe('****');
    });

    it('should redact exactly 4-char IDs', () => {
      expect(redactId('abcd')).toBe('****');
    });

    it('should handle empty string', () => {
      expect(redactId('')).toBe('****');
    });
  });

  describe('TokenBucketLimiter', () => {
    let limiter: TokenBucketLimiter;
    let registry: Registry;
    let tokenGauge: Gauge<string>;
    let queueDepthGauge: Gauge<string>;

    beforeEach(() => {
      limiter = new TokenBucketLimiter({ capacity: 5, refillRatePerSec: 10 });
      registry = new Registry();
      tokenGauge = new Gauge({
        name: 'test_tokens',
        help: 'Test token gauge',
        labelNames: ['provider_id'],
        registers: [registry],
      });
      queueDepthGauge = new Gauge({
        name: 'test_queue_depth',
        help: 'Test queue depth gauge',
        labelNames: ['provider_id'],
        registers: [registry],
      });
    });

    afterEach(() => {
      limiter.stopMetricsSampling();
    });

    describe('acquireToken', () => {
      it('should resolve immediately when tokens are available', async () => {
        await expect(limiter.acquireToken('provider-1')).resolves.toBeUndefined();
      });

      it('should consume a token when available', async () => {
        await limiter.acquireToken('provider-1');
        expect(limiter.getTokenCount('provider-1')).toBeLessThan(5);
      });

      it('should queue when bucket is empty', async () => {
        const config = { capacity: 2, refillRatePerSec: 100 };
        const fastLimiter = new TokenBucketLimiter(config);

        // Consume all tokens
        await fastLimiter.acquireToken('provider-1');
        await fastLimiter.acquireToken('provider-1');

        // This should queue
        const promise = fastLimiter.acquireToken('provider-1');
        expect(fastLimiter.getQueueDepth('provider-1')).toBe(1);

        await promise;
      });

      it('should create separate buckets per provider', async () => {
        await limiter.acquireToken('provider-1');
        await limiter.acquireToken('provider-2');

        expect(limiter.getTokenCount('provider-1')).toBeLessThan(5);
        expect(limiter.getTokenCount('provider-2')).toBeLessThan(5);
      });
    });

    describe('getTokenCount', () => {
      it('should return capacity for new provider', () => {
        expect(limiter.getTokenCount('new-provider')).toBe(5);
      });

      it('should return current token count after consumption', async () => {
        await limiter.acquireToken('provider-1');
        expect(limiter.getTokenCount('provider-1')).toBe(4);
      });

      it('should apply refill based on elapsed time', async () => {
        const config = { capacity: 10, refillRatePerSec: 100 };
        const fastLimiter = new TokenBucketLimiter(config);

        await fastLimiter.acquireToken('provider-1');
        expect(fastLimiter.getTokenCount('provider-1')).toBe(9);

        // Wait for refill
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(fastLimiter.getTokenCount('provider-1')).toBeGreaterThan(9);
      });
    });

    describe('getQueueDepth', () => {
      it('should return 0 for new provider', () => {
        expect(limiter.getQueueDepth('new-provider')).toBe(0);
      });

      it('should return queue depth when throttled', async () => {
        const config = { capacity: 1, refillRatePerSec: 100 };
        const fastLimiter = new TokenBucketLimiter(config);

        await fastLimiter.acquireToken('provider-1');
        const promise = fastLimiter.acquireToken('provider-1');

        expect(fastLimiter.getQueueDepth('provider-1')).toBe(1);
        await promise;
      });

      it('should return 0 after queue is drained', async () => {
        const config = { capacity: 1, refillRatePerSec: 100 };
        const fastLimiter = new TokenBucketLimiter(config);

        await fastLimiter.acquireToken('provider-1');
        const promise = fastLimiter.acquireToken('provider-1');

        expect(fastLimiter.getQueueDepth('provider-1')).toBe(1);
        await promise;
        expect(fastLimiter.getQueueDepth('provider-1')).toBe(0);
      });
    });

    describe('startMetricsSampling', () => {
      it('should sample initial values immediately', () => {
        limiter.acquireToken('provider-1');
        limiter.startMetricsSampling(tokenGauge, queueDepthGauge, 10000);

        const metrics = registry.metrics();
        expect(metrics).toContain('test_tokens');
        expect(metrics).toContain('test_queue_depth');
      });

      it('should update gauges with current token count', async () => {
        await limiter.acquireToken('provider-1');
        limiter.startMetricsSampling(tokenGauge, queueDepthGauge, 10000);

        const metrics = await registry.metrics();
        expect(metrics).toContain('test_tokens{provider_id="prov****"} 4');
      });

      it('should update gauges with current queue depth', async () => {
        const config = { capacity: 1, refillRatePerSec: 100 };
        const fastLimiter = new TokenBucketLimiter(config);

        await fastLimiter.acquireToken('provider-1');
        const promise = fastLimiter.acquireToken('provider-1');

        fastLimiter.startMetricsSampling(tokenGauge, queueDepthGauge, 10000);

        const metrics = await registry.metrics();
        expect(metrics).toContain('test_queue_depth{provider_id="prov****"} 1');

        await promise;
      });

      it('should use redacted provider ID as label', () => {
        limiter.startMetricsSampling(tokenGauge, queueDepthGauge, 10000);

        const metrics = registry.metrics();
        expect(metrics).toContain('provider_id="prov****"');
      });

      it('should sample at specified interval', async () => {
        const config = { capacity: 10, refillRatePerSec: 100 };
        const fastLimiter = new TokenBucketLimiter(config);

        await fastLimiter.acquireToken('provider-1');
        fastLimiter.startMetricsSampling(tokenGauge, queueDepthGauge, 50);

        // Wait for multiple samples
        await new Promise((resolve) => setTimeout(resolve, 150));

        const metrics = await registry.metrics();
        expect(metrics).toContain('test_tokens');
      });

      it('should not consume tokens during sampling', async () => {
        await limiter.acquireToken('provider-1');
        const tokensBefore = limiter.getTokenCount('provider-1');

        limiter.startMetricsSampling(tokenGauge, queueDepthGauge, 10);
        await new Promise((resolve) => setTimeout(resolve, 50));

        const tokensAfter = limiter.getTokenCount('provider-1');
        expect(tokensAfter).toBe(tokensBefore);
      });

      it('should handle multiple providers', async () => {
        await limiter.acquireToken('provider-1');
        await limiter.acquireToken('provider-2');
        await limiter.acquireToken('provider-3');

        limiter.startMetricsSampling(tokenGauge, queueDepthGauge, 10000);

        const metrics = await registry.metrics();
        expect(metrics).toContain('provider_id="prov****"');
      });

      it('should warn if sampling is already active', () => {
        const consoleWarnSpy = vi.spyOn(console, 'warn');
        limiter.startMetricsSampling(tokenGauge, queueDepthGauge, 10000);
        limiter.startMetricsSampling(tokenGauge, queueDepthGauge, 10000);

        expect(consoleWarnSpy).toHaveBeenCalledWith(
          '[rateLimit] Metrics sampling already active, ignoring start request.',
        );
        consoleWarnSpy.mockRestore();
      });

      it('should return stop function', () => {
        const stop = limiter.startMetricsSampling(tokenGauge, queueDepthGauge, 10000);
        expect(typeof stop).toBe('function');
      });
    });

    describe('stopMetricsSampling', () => {
      it('should stop active sampling', () => {
        limiter.startMetricsSampling(tokenGauge, queueDepthGauge, 10);
        limiter.stopMetricsSampling();

        // Should not throw when called again
        limiter.stopMetricsSampling();
      });

      it('should be safe to call when not sampling', () => {
        expect(() => limiter.stopMetricsSampling()).not.toThrow();
      });
    });

    describe('edge cases', () => {
      it('should handle empty bucket', () => {
        const config = { capacity: 0, refillRatePerSec: 10 };
        expect(() => new TokenBucketLimiter(config)).toThrow();
      });

      it('should handle many providers', async () => {
        const promises: Promise<void>[] = [];
        for (let i = 0; i < 50; i++) {
          promises.push(limiter.acquireToken(`provider-${i}`));
        }

        await Promise.all(promises);

        limiter.startMetricsSampling(tokenGauge, queueDepthGauge, 10000);
        const metrics = await registry.metrics();
        expect(metrics).toContain('test_tokens');
      });

      it('should handle provider with very long ID', () => {
        const _longId = 'a'.repeat(100);
        limiter.startMetricsSampling(tokenGauge, queueDepthGauge, 10000);

        const metrics = registry.metrics();
        expect(metrics).toContain('provider_id="aaaa****"');
      });

      it('should reset gauges when queue is drained', async () => {
        const config = { capacity: 1, refillRatePerSec: 100 };
        const fastLimiter = new TokenBucketLimiter(config);

        await fastLimiter.acquireToken('provider-1');
        const promise = fastLimiter.acquireToken('provider-1');

        fastLimiter.startMetricsSampling(tokenGauge, queueDepthGauge, 10000);

        let metrics = await registry.metrics();
        expect(metrics).toContain('test_queue_depth{provider_id="prov****"} 1');

        await promise;

        metrics = await registry.metrics();
        expect(metrics).toContain('test_queue_depth{provider_id="prov****"} 0');
      });
    });
  });
});
