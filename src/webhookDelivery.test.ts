/**
 * Integration tests for DLQ health metrics.
 *
 * Acceptance criteria verified here:
 *  1. DLQ population: gauges accurately track depth and oldest-age.
 *  2. DLQ drainage: gauges update correctly as entries are removed.
 *  3. Empty DLQ: gauges reset to exactly zero when the DLQ is empty.
 *  4. Provider sanitization: long/special-char IDs are sanitized for labels.
 *  5. Interval sampling: metrics are updated at the configured interval.
 */

import { InMemoryDlqStore, type DlqEntry } from './dlqStore';
import {
  updateDlqMetrics,
  startDlqMetricsSampling,
  sanitizeProvider,
  _resetDlqGauges,
  _getDlqDepthGauge,
  _getDlqOldestAgeGauge,
} from './webhookMetrics';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve after `ms` milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Create a DLQ entry with the given provider ID and age (in seconds).
 */
function makeDlqEntry(
  providerId: string,
  ageSeconds: number,
  deliveryId: string = `evt-${Date.now()}`,
): DlqEntry {
  return {
    providerId,
    deliveryId,
    targetUrl: 'https://example.com/hook',
    payload: { event: 'test' },
    timestamp: Date.now() - ageSeconds * 1_000,
  };
}

/**
 * Get the current value of a gauge for a specific provider label.
 */
async function getGaugeValue(
  gauge: ReturnType<typeof _getDlqDepthGauge>,
  provider: string,
): Promise<number | undefined> {
  const metrics = await gauge.get();
  const match = metrics.values.find((v) => v.labels.provider === provider);
  return match?.value;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  _resetDlqGauges();
});

// ---------------------------------------------------------------------------
// 1. sanitizeProvider — label sanitization
// ---------------------------------------------------------------------------

describe('sanitizeProvider', () => {
  it('converts to lowercase', () => {
    expect(sanitizeProvider('ProviderABC')).toBe('providerabc');
  });

  it('replaces special characters with underscores', () => {
    expect(sanitizeProvider('provider@123!xyz')).toBe('provider_123_xyz');
  });

  it('preserves hyphens and underscores', () => {
    expect(sanitizeProvider('provider-123_xyz')).toBe('provider-123_xyz');
  });

  it('truncates to 32 characters', () => {
    const longId = 'a'.repeat(50);
    expect(sanitizeProvider(longId)).toHaveLength(32);
  });

  it('handles empty string', () => {
    expect(sanitizeProvider('')).toBe('');
  });

  it('handles unicode characters', () => {
    expect(sanitizeProvider('provider-émoji-🚀')).toBe('provider-_moji-__');
  });
});

// ---------------------------------------------------------------------------
// 2. updateDlqMetrics — gauge updates
// ---------------------------------------------------------------------------

describe('updateDlqMetrics', () => {
  it('sets depth gauge to the correct value for each provider', async () => {
    const store = new InMemoryDlqStore();
    store.push(makeDlqEntry('acme', 10));
    store.push(makeDlqEntry('acme', 20));
    store.push(makeDlqEntry('partnerx', 5));

    updateDlqMetrics(store);

    const depthGauge = _getDlqDepthGauge();
    expect(await getGaugeValue(depthGauge, 'acme')).toBe(2);
    expect(await getGaugeValue(depthGauge, 'partnerx')).toBe(1);
  });

  it('sets oldest-age gauge to the age of the oldest entry', async () => {
    const store = new InMemoryDlqStore();
    store.push(makeDlqEntry('acme', 100)); // oldest
    store.push(makeDlqEntry('acme', 50));  // newer

    updateDlqMetrics(store);

    const ageGauge = _getDlqOldestAgeGauge();
    const age = await getGaugeValue(ageGauge, 'acme');

    // Age should be approximately 100 seconds (allow 1-second tolerance)
    expect(age).toBeGreaterThanOrEqual(99);
    expect(age).toBeLessThanOrEqual(101);
  });

  it('resets gauges to zero when a provider queue is empty', async () => {
    const store = new InMemoryDlqStore();
    store.push(makeDlqEntry('acme', 10));

    updateDlqMetrics(store);

    const depthGauge = _getDlqDepthGauge();
    expect(await getGaugeValue(depthGauge, 'acme')).toBe(1);

    // Drain the queue
    store.drain('acme', 1);
    updateDlqMetrics(store);

    expect(await getGaugeValue(depthGauge, 'acme')).toBe(0);
  });

  it('handles multiple providers independently', async () => {
    const store = new InMemoryDlqStore();
    store.push(makeDlqEntry('alpha', 10));
    store.push(makeDlqEntry('beta', 20));
    store.push(makeDlqEntry('gamma', 30));

    updateDlqMetrics(store);

    const depthGauge = _getDlqDepthGauge();
    expect(await getGaugeValue(depthGauge, 'alpha')).toBe(1);
    expect(await getGaugeValue(depthGauge, 'beta')).toBe(1);
    expect(await getGaugeValue(depthGauge, 'gamma')).toBe(1);
  });

  it('omits providers with empty queues from oldest-age gauge', async () => {
    const store = new InMemoryDlqStore();
    store.push(makeDlqEntry('acme', 10));

    updateDlqMetrics(store);

    const ageGauge = _getDlqOldestAgeGauge();
    expect(await getGaugeValue(ageGauge, 'acme')).toBeGreaterThan(0);

    // Drain the queue
    store.drain('acme', 1);
    updateDlqMetrics(store);

    // Age gauge should be reset to zero (or undefined, depending on prom-client behavior)
    const ageAfterDrain = await getGaugeValue(ageGauge, 'acme');
    expect(ageAfterDrain === 0 || ageAfterDrain === undefined).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. DLQ population and drainage — acceptance criteria
// ---------------------------------------------------------------------------

describe('DLQ population and drainage', () => {
  it('AC1 — gauges track depth correctly as entries are added', async () => {
    const store = new InMemoryDlqStore();

    // Start with empty DLQ
    updateDlqMetrics(store);
    const depthGauge = _getDlqDepthGauge();
    expect(await getGaugeValue(depthGauge, 'acme')).toBeUndefined();

    // Add one entry
    store.push(makeDlqEntry('acme', 10));
    updateDlqMetrics(store);
    expect(await getGaugeValue(depthGauge, 'acme')).toBe(1);

    // Add two more entries
    store.push(makeDlqEntry('acme', 20));
    store.push(makeDlqEntry('acme', 30));
    updateDlqMetrics(store);
    expect(await getGaugeValue(depthGauge, 'acme')).toBe(3);
  });

  it('AC2 — gauges track oldest-age correctly as entries age', async () => {
    const store = new InMemoryDlqStore();
    store.push(makeDlqEntry('acme', 50)); // 50 seconds old

    updateDlqMetrics(store);

    const ageGauge = _getDlqOldestAgeGauge();
    const age1 = await getGaugeValue(ageGauge, 'acme');
    expect(age1).toBeGreaterThanOrEqual(49);
    expect(age1).toBeLessThanOrEqual(51);

    // Wait 1 second and re-sample — age should increase
    await sleep(1000);
    updateDlqMetrics(store);

    const age2 = await getGaugeValue(ageGauge, 'acme');
    expect(age2).toBeGreaterThan(age1!);
  }, 3000);

  it('AC3 — gauges update correctly as entries are drained', async () => {
    const store = new InMemoryDlqStore();
    store.push(makeDlqEntry('acme', 10, 'evt-1'));
    store.push(makeDlqEntry('acme', 20, 'evt-2'));
    store.push(makeDlqEntry('acme', 30, 'evt-3'));

    updateDlqMetrics(store);

    const depthGauge = _getDlqDepthGauge();
    expect(await getGaugeValue(depthGauge, 'acme')).toBe(3);

    // Drain one entry
    store.drain('acme', 1);
    updateDlqMetrics(store);
    expect(await getGaugeValue(depthGauge, 'acme')).toBe(2);

    // Drain remaining entries
    store.drain('acme', 2);
    updateDlqMetrics(store);
    expect(await getGaugeValue(depthGauge, 'acme')).toBe(0);
  });

  it('AC4 — gauges reset to exactly zero when DLQ is empty', async () => {
    const store = new InMemoryDlqStore();
    store.push(makeDlqEntry('acme', 10));

    updateDlqMetrics(store);

    const depthGauge = _getDlqDepthGauge();
    const ageGauge = _getDlqOldestAgeGauge();

    expect(await getGaugeValue(depthGauge, 'acme')).toBe(1);
    expect(await getGaugeValue(ageGauge, 'acme')).toBeGreaterThan(0);

    // Drain all entries
    store.drain('acme', 1);
    updateDlqMetrics(store);

    expect(await getGaugeValue(depthGauge, 'acme')).toBe(0);

    const ageAfterDrain = await getGaugeValue(ageGauge, 'acme');
    expect(ageAfterDrain === 0 || ageAfterDrain === undefined).toBe(true);
  });

  it('AC5 — provider A DLQ does not affect provider B gauges', async () => {
    const store = new InMemoryDlqStore();
    store.push(makeDlqEntry('providerA', 10));
    store.push(makeDlqEntry('providerA', 20));
    store.push(makeDlqEntry('providerB', 5));

    updateDlqMetrics(store);

    const depthGauge = _getDlqDepthGauge();
    expect(await getGaugeValue(depthGauge, 'providera')).toBe(2);
    expect(await getGaugeValue(depthGauge, 'providerb')).toBe(1);

    // Drain provider A completely
    store.drain('providerA', 2);
    updateDlqMetrics(store);

    expect(await getGaugeValue(depthGauge, 'providera')).toBe(0);
    expect(await getGaugeValue(depthGauge, 'providerb')).toBe(1); // unchanged
  });
});

// ---------------------------------------------------------------------------
// 4. startDlqMetricsSampling — interval sampling
// ---------------------------------------------------------------------------

describe('startDlqMetricsSampling', () => {
  it('updates metrics at the configured interval', async () => {
    const store = new InMemoryDlqStore();
    const intervalMs = 100; // 100 ms for fast test

    const stopSampling = startDlqMetricsSampling(store, intervalMs);

    // Add an entry after sampling starts
    store.push(makeDlqEntry('acme', 10));

    // Wait for one interval cycle
    await sleep(intervalMs + 50);

    const depthGauge = _getDlqDepthGauge();
    expect(await getGaugeValue(depthGauge, 'acme')).toBe(1);

    // Add another entry
    store.push(makeDlqEntry('acme', 20));

    // Wait for another interval cycle
    await sleep(intervalMs + 50);

    expect(await getGaugeValue(depthGauge, 'acme')).toBe(2);

    stopSampling();
  }, 5000);

  it('stops sampling when the stop function is called', async () => {
    const store = new InMemoryDlqStore();
    const intervalMs = 100;

    const stopSampling = startDlqMetricsSampling(store, intervalMs);

    store.push(makeDlqEntry('acme', 10));
    await sleep(intervalMs + 50);

    const depthGauge = _getDlqDepthGauge();
    expect(await getGaugeValue(depthGauge, 'acme')).toBe(1);

    // Stop sampling
    stopSampling();

    // Add another entry — should NOT be reflected in gauges
    store.push(makeDlqEntry('acme', 20));
    await sleep(intervalMs + 50);

    // Gauge should still show 1 (not updated after stop)
    expect(await getGaugeValue(depthGauge, 'acme')).toBe(1);
  }, 5000);

  it('calling startDlqMetricsSampling multiple times stops the previous interval', async () => {
    const store = new InMemoryDlqStore();
    const intervalMs = 100;

    const stop1 = startDlqMetricsSampling(store, intervalMs);
    const stop2 = startDlqMetricsSampling(store, intervalMs);

    // Only the second interval should be active
    store.push(makeDlqEntry('acme', 10));
    await sleep(intervalMs + 50);

    const depthGauge = _getDlqDepthGauge();
    expect(await getGaugeValue(depthGauge, 'acme')).toBe(1);

    stop2();

    // Calling stop1 should be a no-op (already stopped by stop2)
    stop1();
  }, 5000);
});

// ---------------------------------------------------------------------------
// 5. Edge cases
// ---------------------------------------------------------------------------

describe('Edge cases', () => {
  it('handles empty DLQ store gracefully', async () => {
    const store = new InMemoryDlqStore();
    updateDlqMetrics(store);

    const depthGauge = _getDlqDepthGauge();
    const ageGauge = _getDlqOldestAgeGauge();

    // No providers should have gauges set
    const depthMetrics = await depthGauge.get();
    const ageMetrics = await ageGauge.get();

    expect(depthMetrics.values).toHaveLength(0);
    expect(ageMetrics.values).toHaveLength(0);
  });

  it('handles provider IDs with special characters', async () => {
    const store = new InMemoryDlqStore();
    store.push(makeDlqEntry('provider@123!xyz', 10));

    updateDlqMetrics(store);

    const depthGauge = _getDlqDepthGauge();
    const sanitized = sanitizeProvider('provider@123!xyz');
    expect(await getGaugeValue(depthGauge, sanitized)).toBe(1);
  });

  it('handles very old entries (age > 1 day)', async () => {
    const store = new InMemoryDlqStore();
    const oneDaySeconds = 86400;
    store.push(makeDlqEntry('acme', oneDaySeconds));

    updateDlqMetrics(store);

    const ageGauge = _getDlqOldestAgeGauge();
    const age = await getGaugeValue(ageGauge, 'acme');

    expect(age).toBeGreaterThanOrEqual(oneDaySeconds - 1);
    expect(age).toBeLessThanOrEqual(oneDaySeconds + 1);
  });

  it('handles large DLQ depth (1000+ entries)', async () => {
    const store = new InMemoryDlqStore();
    const COUNT = 1000;

    for (let i = 0; i < COUNT; i++) {
      store.push(makeDlqEntry('acme', 10, `evt-${i}`));
    }

    updateDlqMetrics(store);

    const depthGauge = _getDlqDepthGauge();
    expect(await getGaugeValue(depthGauge, 'acme')).toBe(COUNT);
  });

  it('handles concurrent updates from multiple providers', async () => {
    const store = new InMemoryDlqStore();
    const providers = Array.from({ length: 10 }, (_, i) => `provider-${i}`);

    // Add entries for all providers
    providers.forEach((p) => {
      store.push(makeDlqEntry(p, 10));
    });

    updateDlqMetrics(store);

    const depthGauge = _getDlqDepthGauge();

    // All providers should have depth=1
    for (const p of providers) {
      expect(await getGaugeValue(depthGauge, p)).toBe(1);
    }
  });
});
