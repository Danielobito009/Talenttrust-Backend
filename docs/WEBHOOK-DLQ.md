# Webhook Delivery, Retry, and DLQ Lifecycle

This document describes the end-to-end lifecycle of an outbound webhook from
signing through delivery, retry/backoff, circuit-breaker protection, DLQ
enqueue, and replay.

---

## State diagram

```
                        ┌─────────────┐
                        │   Trigger   │
                        └──────┬──────┘
                               │ sign + send
                               ▼
                        ┌─────────────┐
                        │  Delivering │◄──────────────────────┐
                        └──────┬──────┘                       │
                    success    │    failure                    │ retry (backoff)
                               ▼                              │
                        ┌─────────────┐   retryCount < MAX    │
                        │  Delivered  │   ───────────────────►┘
                        └─────────────┘
                               │ retryCount == MAX
                               ▼
                        ┌─────────────┐
                        │     DLQ     │
                        └──────┬──────┘
                               │ operator replay
                               ▼
                        ┌─────────────┐
                        │  Delivering │ (back to top)
                        └─────────────┘
```

---

## 1. Signing

Every outbound webhook is signed by `WebhookDeliveryService.send()` in
`src/webhookDelivery.ts`:

- The **primary** secret (first entry in `WEBHOOK_SIGNING_SECRETS`) is used.
- Signing payload: `HMAC-SHA256(secret, "<timestamp>.<json-body>")`.
- Headers added: `X-Webhook-Signature`, `X-Webhook-Timestamp`.

See [webhook-signature-verification.md](./webhook-signature-verification.md)
for the full signing and verification spec.

---

## 2. Delivery

`WebhookDeliveryService.send()` posts the payload to the configured URL via
`axios.post`.  On success the delivery is complete.

---

## 3. Retry / backoff

On failure the service retries with **exponential backoff**:

```
delay = INITIAL_DELAY_MS × 2^retryCount
```

| Attempt | Delay |
|---|---|
| 1 | 1 s |
| 2 | 2 s |
| 3 | 4 s |
| 4 | 8 s |
| 5 | 16 s |

After `MAX_RETRIES` (5) the payload is moved to the DLQ.

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `WEBHOOK_SIGNING_SECRETS` | *(required)* | Comma-separated HMAC secrets |
| `WEBHOOK_TIMESTAMP_TOLERANCE_S` | `300` | Replay-cache TTL in seconds |

---

## 4. Circuit breaker

Upstream RPC calls are protected by the built-in circuit breaker
(`src/circuit-breaker/CircuitBreaker.ts`).  When the breaker is `OPEN`,
webhook delivery attempts fast-fail with a `503` rather than queuing retries
against a known-down endpoint.

See [circuit-breaker.md](./backend/circuit-breaker.md) for state transitions
and configuration.

---

## 5. Dead-Letter Queue (DLQ)

Payloads that exhaust all retries are appended to the in-memory DLQ
(`WebhookDeliveryService.getDlq()`).  Each entry carries:

| Field | Type | Description |
|---|---|---|
| `id` | string | Webhook delivery ID |
| `url` | string | Target endpoint |
| `event` | string | Event type |
| `data` | unknown | Payload |
| `retryCount` | number | Always `MAX_RETRIES` at DLQ time |
| `failedAt` | Date | Timestamp of final failure |
| `lastError` | string | Last error message |

> **Production note**: Replace the in-memory DLQ with a durable store
> (e.g., a `webhook_dlq` SQLite table or a Redis list) before going to
> production.

---

## 6. Replay runbook

To replay a DLQ entry:

1. Retrieve the entry from the DLQ endpoint (requires `admin` role):

   ```http
   GET /api/v1/jobs/webhook_delivery/<jobId>
   Authorization: Bearer <admin-token>
   ```

2. Re-enqueue via the jobs API:

   ```http
   POST /api/v1/jobs
   Authorization: Bearer <admin-token>
   Content-Type: application/json

   {
     "type": "webhook_delivery",
     "payload": {
       "id": "<original-id>",
       "url": "<target-url>",
       "event": "<event-type>",
       "data": { ... },
       "retryCount": 0
     }
   }
   ```

   Setting `retryCount: 0` gives the replay a full set of retries.

3. Monitor delivery via the jobs status endpoint:

   ```http
   GET /api/v1/jobs/webhook_delivery/<newJobId>
   ```

---

## 7. Metrics and alerting

`src/observability/metrics-service.ts` exposes Prometheus metrics.  Key
signals for webhook health:

| Metric | Labels | Alert threshold |
|---|---|---|
| `http_requests_total` | `route=/api/v1/jobs, status_code=5xx` | > 1% error rate over 5 min |
| `http_request_duration_seconds` | `route=/api/v1/jobs` | p99 > 2 s |
| `service_health_status` | `service=talenttrust-backend` | value < 2 (degraded/down) |

Add a custom counter for DLQ enqueues in production:

```typescript
dlqEnqueueTotal.inc({ event: payload.event });
```

---

## 8. Security notes

- Raw signatures and secrets are **never** logged; `redactSecret()` from
  `src/utils/redact.ts` is used at every log call-site.
- Replay protection prevents re-delivery of captured signed payloads within
  the tolerance window.
- Key rotation is zero-downtime; see
  [webhook-signature-verification.md](./webhook-signature-verification.md#key-rotation-285).
