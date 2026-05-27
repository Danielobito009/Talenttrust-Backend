/**
 * @module api/jobs
 *
 * Background job orchestration for webhook delivery and DLQ management.
 *
 * ## Responsibilities
 * - Initialize the DLQ store (in-memory or Redis-backed).
 * - Start the DLQ metrics sampling loop.
 * - Provide a health-check endpoint for monitoring.
 *
 * ## Configuration (environment variables)
 * | Variable                  | Default | Description                                    |
 * |---------------------------|---------|------------------------------------------------|
 * | `DLQ_METRICS_INTERVAL_MS` | `30000` | DLQ metrics sampling interval in milliseconds. |
 *
 * ## Usage
 * Call {@link initializeJobs} once at application startup (e.g., from `index.ts`).
 */

import { InMemoryDlqStore, type DlqStore } from '../dlqStore';
import { startDlqMetricsSampling } from '../webhookMetrics';

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

let dlqStore: DlqStore | null = null;
let stopSampling: (() => void) | null = null;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Load DLQ metrics sampling interval from environment variables.
 *
 * @returns Sampling interval in milliseconds.
 */
function loadDlqMetricsInterval(): number {
  const raw = process.env.DLQ_METRICS_INTERVAL_MS ?? '30000';
  const parsed = Number(raw);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `[api/jobs] Invalid DLQ_METRICS_INTERVAL_MS="${raw}". ` +
        'Must be a finite positive number greater than zero.',
    );
  }

  return parsed;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialize background jobs: DLQ store and metrics sampling.
 *
 * This function is idempotent — calling it multiple times will stop the
 * previous sampling loop and start a new one.
 *
 * @param customDlqStore - Optional custom DLQ store (for testing or Redis-backed stores).
 * @returns The initialized DLQ store.
 */
export function initializeJobs(customDlqStore?: DlqStore): DlqStore {
  // Stop any existing sampling loop
  if (stopSampling !== null) {
    stopSampling();
    stopSampling = null;
  }

  // Initialize DLQ store
  dlqStore = customDlqStore ?? new InMemoryDlqStore();

  // Start DLQ metrics sampling
  const intervalMs = loadDlqMetricsInterval();
  stopSampling = startDlqMetricsSampling(dlqStore, intervalMs);

  console.log(
    `[api/jobs] DLQ metrics sampling started (interval: ${intervalMs} ms).`,
  );

  return dlqStore;
}

/**
 * Stop all background jobs and clean up resources.
 *
 * Intended for graceful shutdown or testing.
 */
export function shutdownJobs(): void {
  if (stopSampling !== null) {
    stopSampling();
    stopSampling = null;
  }

  dlqStore = null;

  console.log('[api/jobs] Background jobs stopped.');
}

/**
 * Get the current DLQ store instance.
 *
 * @returns The DLQ store, or `null` if {@link initializeJobs} has not been called.
 */
export function getDlqStore(): DlqStore | null {
  return dlqStore;
}
