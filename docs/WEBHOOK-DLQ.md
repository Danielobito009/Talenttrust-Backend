# Webhook DLQ (Dead Letter Queue)

This document describes the webhook DLQ persistence implementation.

## Overview

Failed webhook deliveries are persisted to durable SQLite storage for later inspection and replay.

## Components

### Storage (`src/queue/webhook-dlq.ts`)

- SQLite-backed persistent storage
- Deduplication via SHA-256 hash key (webhookId + payload)
- Unique constraint prevents duplicate entries

### Retry Policy (`src/queue/webhook-retry-policy.ts`)

- Max 5 retry attempts
- Exponential backoff: 1s → 2s → 4s → 8s → 16s
- 10% jitter to prevent thundering herd
- Max delay cap: 30s

### Admin Endpoints (`src/routes/admin.routes.ts`)

| Method | Endpoint | Description |
|--------|----------|------------|
| GET | /api/v1/admin/webhook-dlq | List DLQ entries |
| GET | /api/v1/admin/webhook-dlq/:id | Get single entry |
| POST | /api/v1/admin/webhook-dlq/:id/replay | Replay webhook |

## Capacity Management

### Overflow Policy: Oldest-Evict

When the DLQ reaches its maximum capacity (default: 10,000 entries), the system automatically evicts the oldest pending entry to make room for new failures.

**Behavior:**
- Default max capacity: 10,000 entries
- When at capacity, the oldest pending (not-yet-replayed) entry is evicted
- Replayed entries are not evicted (they are kept for historical reference)
- The eviction occurs before the new entry is added

**Rationale:**
- Ensures the DLQ doesn't grow unbounded
- Prioritizes newer failures which may be more actionable
- Replayed entries are preserved for audit and historical tracking

**Configuration:**
```typescript
const storage = new WebhookDLQStorage(':memory:', { 
  maxCapacity: 10000  // configurable
});
```

### Environment

| Variable | Description | Default |
|----------|-------------|---------|
| WEBHOOK_DLQ_PATH | SQLite DB path | `./data/webhook-dlq.db` |

## Poison Message Handling

A poison message is a webhook that consistently fails on every replay attempt, typically due to malformed data or an unrecoverable downstream issue.

### Behavior

- Default max replay attempts: 5
- Each failed replay increments the `replay_attempts` counter
- When `replay_attempts >= maxReplayAttempts`, the message is **permanently dropped**
- The entry is deleted from the database and cannot be recovered

**Rationale:**
- Prevents infinite retry loops
- Prevents DLQ pollution with unrecoverable messages
- Limits resource consumption on repeated failed attempts

**Configuration:**
```typescript
const storage = new WebhookDLQStorage(':memory:', { 
  maxReplayAttempts: 5  // configurable
});
```

### Tracking

The `WebhookDLQEntry` includes a `replayAttempts` field that tracks how many times an entry has been replayed:

```typescript
interface WebhookDLQEntry {
  // ... other fields
  replayAttempts: number;
}
```

## Metrics

DLQ operations are tracked via Prometheus counters in `webhookMetrics.ts`:

| Metric | Labels | Description |
|--------|--------|-------------|
| `webhook_dlq_operations_total` | `operation` | Total DLQ operations |

**Operations tracked:**

| Operation | Description |
|-----------|-------------|
| `enqueue` | Entry added to DLQ |
| `drop_overflow` | Entry evicted due to capacity overflow |
| `drop_poison` | Entry dropped after exceeding max replay attempts |

## Security

- All endpoints require admin JWT role
- `webhookSecret` is never returned in API responses
- Replay requires a reason (min 5 chars) for audit