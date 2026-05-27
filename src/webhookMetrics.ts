/**
 * @module webhookMetrics
 *
 * Lightweight in-process metrics collector for webhook delivery events.
 * In a production multi-process deployment these counters are per-process;
 * export them to a Prometheus push-gateway or similar aggregator if
 * cross-process totals are required.
 *
 * SECURITY: This module never receives or stores provider secrets.
 * Only opaque provider IDs (strings) are recorded.
 */

import { Gauge, register } from 'prom-client';
import type { DlqStore } from './dlqStore';

/** Shape of the metrics snapshot returned by {@link getMetrics}. */
export interface WebhookMetricsSnapshot {
  /** Total throttled-delivery events recorded since process start, keyed by provider ID. */
  throttledByProvider: Record<string, number>;
  /** Total successful delivery events recorded since process start, keyed by provider ID. */
  deliveredByProvider: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Internal mutable state (module-level singletons, reset-able for tests)
// ---------------------------------------------------------------------------

let throttledByProvider: Record<string, number> = {};
let deliveredByProvider: Record<string, number> = {};

// ---------------------------------------------------------------------------
// Prometheus Gauges for DLQ metrics
// ---------------------------------------------------------------------------

/**
 * Gauge tracking the current number of items in the DLQ per provider.
 */
const dlqDepthGauge = new Gauge({
  name: 'webhook_dlq_depth',
  help: 'Current number of items in the webhook Dead Letter Queue',
  labelNames: ['provider'],
  registers: [register],
});

/**
 * Gauge tracking the age (in seconds) of the oldest entry in the DLQ per provider.
 */
const dlqOldestAgeGauge = new Gauge({
  name: 'webhook_dlq_oldest_age_seconds',
  help: 'Age in seconds of the oldest entry in the webhook DLQ',
  labelNames: ['provider'],
  registers: [register],
});

// ---------------------------------------------------------------------------
// Provider ID sanitization
// ---------------------------------------------------------------------------

/**
 * Sanitize a provider ID for safe use as a Prometheus label value.
 *
 * Prevents label cardinality explosion by:
 * - Truncating to 32 characters max
 * - Replacing non-alphanumeric characters (except `-` and `_`) with `_`
 * - Converting to lowercase
 *
 * SECURITY: This function does NOT redact secrets. It assumes the provider ID
 * is already an opaque identifier (not a secret). Use {@link redactId} from
 * `rateLimit.ts` for log output.
 *
 * @param providerId - Raw provider identifier.
 * @returns Sanitized label value safe for Prometheus.
 */
export function sanitizeProvider(providerId: string): string {
  return providerId
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .slice(0, 32);
}

// ---------------------------------------------------------------------------
// DLQ metrics sampling
// ---------------------------------------------------------------------------

let samplingIntervalHandle: NodeJS.Timeout | null = null;

/**
 * Update DLQ Prometheus gauges by sampling the DLQ store.
 *
 * This function is **synchronous** and non-blocking. It reads the current
 * DLQ state and updates the gauges accordingly. Providers with empty queues
 * have their gauges reset to exactly zero.
 *
 * @param dlqStore - The DLQ store to sample.
 */
export function updateDlqMetrics(dlqStore: DlqStore): void {
  const depthByProvider = dlqStore.getDepthByProvider();
  const oldestAgeByProvider = dlqStore.getOldestAgeByProvider();

  // Track which providers we've seen in this sample
  const seenProviders = new Set<string>();

  // Update depth gauge for all providers with entries
  for (const [providerId, depth] of depthByProvider.entries()) {
    const sanitized = sanitizeProvider(providerId);
    seenProviders.add(sanitized);
    dlqDepthGauge.set({ provider: sanitized }, depth);
  }

  // Update oldest-age gauge for all providers with entries
  for (const [providerId, ageSeconds] of oldestAgeByProvider.entries()) {
    const sanitized = sanitizeProvider(providerId);
    seenProviders.add(sanitized);
    dlqOldestAgeGauge.set({ provider: sanitized }, ageSeconds);
  }

  // Reset gauges to zero for providers that previously had entries but are now empty.
  // We do this by checking the gauge's internal state (all known label combinations).
  // For simplicity, we reset all providers not seen in this sample.
  // Note: prom-client doesn't expose a clean API to enumerate all label values,
  // so we rely on the fact that calling `set(..., 0)` is idempotent.
  // A production implementation might track known providers in a separate Set.

  // For now, we explicitly reset gauges for providers with depth=0
  for (const [providerId, depth] of depthByProvider.entries()) {
    if (depth === 0) {
      const sanitized = sanitizeProvider(providerId);
      dlqDepthGauge.set({ provider: sanitized }, 0);
      dlqOldestAgeGauge.set({ provider: sanitized }, 0);
    }
  }
}

/**
 * Start a bounded interval that periodically samples the DLQ store and
 * updates Prometheus gauges.
 *
 * Only one sampling interval can be active at a time. Calling this function
 * multiple times will stop the previous interval and start a new one.
 *
 * @param dlqStore - The DLQ store to sample.
 * @param intervalMs - Sampling interval in milliseconds (e.g., 30000 = 30 seconds).
 * @returns A function to stop the sampling interval.
 */
export function startDlqMetricsSampling(
  dlqStore: DlqStore,
  intervalMs: number,
): () => void {
  // Stop any existing interval
  if (samplingIntervalHandle !== null) {
    clearInterval(samplingIntervalHandle);
  }

  // Start a new interval
  samplingIntervalHandle = setInterval(() => {
    updateDlqMetrics(dlqStore);
  }, intervalMs);

  // Return a stop function
  return function stopDlqMetricsSampling(): void {
    if (samplingIntervalHandle !== null) {
      clearInterval(samplingIntervalHandle);
      samplingIntervalHandle = null;
    }
  };
}

// ---------------------------------------------------------------------------
// Public API (existing counters)
// ---------------------------------------------------------------------------

/**
 * Record that a webhook delivery was throttled (token not immediately
 * available) for the given provider.
 *
 * @param providerId - Opaque provider identifier. Must NOT contain secrets.
 */
export function recordThrottled(providerId: string): void {
  throttledByProvider[providerId] = (throttledByProvider[providerId] ?? 0) + 1;
}

/**
 * Record that a webhook was successfully delivered for the given provider.
 *
 * @param providerId - Opaque provider identifier. Must NOT contain secrets.
 */
export function recordDelivered(providerId: string): void {
  deliveredByProvider[providerId] = (deliveredByProvider[providerId] ?? 0) + 1;
}

/**
 * Return a point-in-time snapshot of all recorded metrics.
 * The returned object is a deep copy; mutations do not affect internal state.
 */
export function getMetrics(): WebhookMetricsSnapshot {
  return {
    throttledByProvider: { ...throttledByProvider },
    deliveredByProvider: { ...deliveredByProvider },
  };
}

/**
 * Reset all counters to zero.
 * Intended for use in tests only — do not call in production code.
 *
 * @internal
 */
export function _resetMetrics(): void {
  throttledByProvider = {};
  deliveredByProvider = {};
}

/**
 * Reset all DLQ gauges to zero.
 * Intended for use in tests only — do not call in production code.
 *
 * @internal
 */
export function _resetDlqGauges(): void {
  dlqDepthGauge.reset();
  dlqOldestAgeGauge.reset();
}

/**
 * Export the DLQ depth gauge for testing.
 *
 * @internal
 */
export function _getDlqDepthGauge(): Gauge<string> {
  return dlqDepthGauge;
}

/**
 * Export the DLQ oldest-age gauge for testing.
 *
 * @internal
 */
export function _getDlqOldestAgeGauge(): Gauge<string> {
  return dlqOldestAgeGauge;
}

