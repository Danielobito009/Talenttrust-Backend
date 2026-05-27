# Webhook Dead Letter Queue (DLQ) Metrics

## Overview

The webhook delivery system tracks failed deliveries in a Dead Letter Queue (DLQ). Two Prometheus gauges provide real-time visibility into DLQ health, enabling operators to set up alerts for growing backlogs and stale entries.

---

## Metrics

### `webhook_dlq_depth`

**Type:** Gauge  
**Labels:** `provider`  
**Description:** Current number of items in the webhook DLQ per provider.

**Semantics:**
- Increments when a webhook delivery fails after all retries and is pushed to the DLQ.
- Decrements when an entry is drained (manually retried or discarded).
- Resets to exactly `0` when a provider's DLQ is empty.

**Example:**
```
webhook_dlq_depth{provider="acme"} 42
webhook_dlq_depth{provider="partnerx"} 0
```

---

### `webhook_dlq_oldest_age_seconds`

**Type:** Gauge  
**Labels:** `provider`  
**Description:** Age in seconds of the oldest entry in the webhook DLQ per provider.

**Semantics:**
- Tracks the age (wall-clock time since entry was added) of the oldest entry in each provider's DLQ.
- Increases continuously as entries age.
- Resets to `0` (or is omitted) when a provider's DLQ is empty.

**Example:**
```
webhook_dlq_oldest_age_seconds{provider="acme"} 3600
webhook_dlq_oldest_age_seconds{provider="partnerx"} 0
```

---

## Label Sanitization

Provider IDs are sanitized before use as Prometheus label values to prevent label cardinality explosion:

- Converted to lowercase
- Non-alphanumeric characters (except `-` and `_`) replaced with `_`
- Truncated to 32 characters max

**Example:**
```
Provider ID: "Provider@123!XYZ"
Sanitized:   "provider_123_xyz"
```

**Security Note:** Provider IDs are assumed to be opaque identifiers (not secrets). Secrets are never included in metric labels or DLQ entries.

---

## Sampling Interval

DLQ metrics are updated on a **bounded interval** (not on every DLQ operation) to avoid blocking the Node.js event loop.

### Configuration

| Environment Variable       | Default | Description                                    |
|----------------------------|---------|------------------------------------------------|
| `DLQ_METRICS_INTERVAL_MS`  | `30000` | DLQ metrics sampling interval in milliseconds. |

**Recommended values:**
- **Development:** `10000` (10 seconds) for faster feedback.
- **Production:** `30000` (30 seconds) balances freshness and overhead.
- **High-volume:** `60000` (60 seconds) reduces CPU usage.

### Example `.env`

```
DLQ_METRICS_INTERVAL_MS=30000
```

---

## Recommended Alert Thresholds

### Alert: DLQ Backlog Growing

**Condition:** `webhook_dlq_depth > 100` for 5 minutes  
**Severity:** Warning  
**Action:** Investigate why deliveries are failing. Check target endpoint health, network connectivity, and rate limits.

**PromQL:**
```promql
webhook_dlq_depth > 100
```

---

### Alert: DLQ Entries Stale

**Condition:** `webhook_dlq_oldest_age_seconds > 3600` (1 hour)  
**Severity:** Warning  
**Action:** Manually retry or discard stale entries. Investigate root cause of delivery failures.

**PromQL:**
```promql
webhook_dlq_oldest_age_seconds > 3600
```

---

### Alert: DLQ Backlog Critical

**Condition:** `webhook_dlq_depth > 1000` for 10 minutes  
**Severity:** Critical  
**Action:** Immediate intervention required. Deliveries are failing at scale. Check for:
- Target endpoint outages
- Network partitions
- Rate limit exhaustion
- Misconfigured signing secrets

**PromQL:**
```promql
webhook_dlq_depth > 1000
```

---

## Scrape Configuration

Add the following to your Prometheus `prometheus.yml`:

```yaml
scrape_configs:
  - job_name: 'talenttrust-webhooks'
    static_configs:
      - targets: ['localhost:3001']
    scrape_interval: 15s
    metrics_path: /metrics
```

**Note:** Ensure your Express app exposes a `/metrics` endpoint that calls `register.metrics()` from `prom-client`.

---

## Architecture

### DLQ Store

The DLQ is backed by an in-memory store (`InMemoryDlqStore`) suitable for single-process deployments. For production multi-process or persistent storage, replace with a Redis-backed or database-backed implementation that implements the `DlqStore` interface.

**Interface:**
```typescript
interface DlqStore {
  push(entry: DlqEntry): void;
  getDepthByProvider(): Map<string, number>;
  getOldestAgeByProvider(): Map<string, number>;
  drain(providerId: string, count: number): DlqEntry[];
  clear(): void;
}
```

### Metrics Sampling

The `startDlqMetricsSampling(dlqStore, intervalMs)` function starts a `setInterval` loop that:
1. Calls `dlqStore.getDepthByProvider()` and `dlqStore.getOldestAgeByProvider()`.
2. Updates the Prometheus gauges for each provider.
3. Resets gauges to `0` for providers with empty queues.

All operations are **synchronous** (non-blocking) to avoid event-loop stalls.

---

## Security Notes

1. **No secrets in labels.** Provider IDs are sanitized and assumed to be opaque identifiers. Signing secrets are never included in DLQ entries or metric labels.

2. **Payload redaction.** DLQ entries may contain sensitive payload data. If persisting to disk or database, encrypt payloads at rest.

3. **Access control.** The `/metrics` endpoint exposes DLQ depth and age per provider. Ensure this endpoint is protected (e.g., internal network only, or behind authentication).

4. **Label cardinality.** The `sanitizeProvider` function prevents unbounded label cardinality by truncating and normalizing provider IDs. Do not bypass this function.

---

## Troubleshooting

### Gauges not updating

**Symptom:** `webhook_dlq_depth` and `webhook_dlq_oldest_age_seconds` are stale or missing.

**Possible causes:**
- `initializeJobs()` was not called at application startup.
- `DLQ_METRICS_INTERVAL_MS` is set too high (e.g., 10 minutes).
- The DLQ store is empty (no failed deliveries).

**Solution:**
- Verify `initializeJobs()` is called in `src/index.ts`.
- Check logs for `[api/jobs] DLQ metrics sampling started`.
- Lower `DLQ_METRICS_INTERVAL_MS` for faster updates.

---

### Gauges not resetting to zero

**Symptom:** `webhook_dlq_depth` shows a non-zero value even after draining all entries.

**Possible causes:**
- The DLQ store's `drain()` method is not removing entries correctly.
- The metrics sampling loop has not run since the drain operation.

**Solution:**
- Manually call `updateDlqMetrics(dlqStore)` to force an immediate update.
- Wait for the next sampling interval (default 30 seconds).
- Check the DLQ store implementation for bugs.

---

### High cardinality warning

**Symptom:** Prometheus logs a warning about high label cardinality for `webhook_dlq_depth` or `webhook_dlq_oldest_age_seconds`.

**Possible causes:**
- Provider IDs are not being sanitized (bypassing `sanitizeProvider`).
- A large number of unique providers (100+) are using the system.

**Solution:**
- Verify all provider IDs pass through `sanitizeProvider` before use as labels.
- Consider aggregating metrics by provider tier (e.g., `tier="premium"`) instead of individual provider IDs.

---

## File Map

| File | Purpose |
|---|---|
| `src/dlqStore.ts` | `DlqStore` interface and `InMemoryDlqStore` implementation |
| `src/webhookMetrics.ts` | Prometheus gauges, `updateDlqMetrics`, `startDlqMetricsSampling`, `sanitizeProvider` |
| `src/api/jobs.ts` | Background job initialization, DLQ metrics sampling bootstrap |
| `src/webhookDelivery.test.ts` | Integration tests for DLQ metrics (population, drainage, sampling) |
| `docs/WEBHOOK-DLQ.md` | This document |
