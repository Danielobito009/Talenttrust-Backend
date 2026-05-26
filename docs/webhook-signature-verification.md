# Webhook Signature Verification

TalentTrust signs every outbound webhook and verifies every inbound webhook
using HMAC-SHA256.  This document describes the signing scheme, timestamp
tolerance, replay protection, and key rotation procedure.

---

## Signing scheme

Every outbound request includes two headers:

| Header | Example | Description |
|---|---|---|
| `X-Webhook-Signature` | `a3f9…` (64 hex chars) | HMAC-SHA256 of `timestamp.body` |
| `X-Webhook-Timestamp` | `1700000000` | Unix epoch seconds at send time |

The signing payload is:

```
HMAC-SHA256(secret, "<timestamp>.<raw-body>")
```

where `<raw-body>` is the exact JSON bytes sent in the request body.

---

## Timestamp tolerance (#255)

To prevent replay of captured signed payloads, the verifier checks that the
`X-Webhook-Timestamp` is within a configurable window of the current time:

```
|now - timestamp| ≤ WEBHOOK_TIMESTAMP_TOLERANCE_S   (default: 300 s)
```

Requests outside this window are rejected with `401 webhook_timestamp_invalid`.

---

## Replay protection (#255)

Even within the tolerance window, each `(signature)` is stored in the
`webhook_replay_cache` SQLite table for the duration of the window.  A second
request carrying the same signature is rejected with `401 webhook_replay_detected`.

Cache entries are evicted lazily on each verification call once their TTL
(`expires_at`) has passed.

---

## Key rotation (#285)

Rotating the signing secret without downtime requires an **overlap window**:

1. Generate a new secret.
2. Prepend it to `WEBHOOK_SIGNING_SECRETS` (comma-separated, primary first):
   ```
   WEBHOOK_SIGNING_SECRETS=new-secret,old-secret
   ```
3. Deploy.  Outbound webhooks are now signed with `new-secret`.  Inbound
   verification accepts **either** key.
4. After all in-flight webhooks signed with `old-secret` have been delivered
   (typically one tolerance window), remove `old-secret`:
   ```
   WEBHOOK_SIGNING_SECRETS=new-secret
   ```
5. Deploy again.

When a request is verified with a non-primary key (`matchedKeyIndex > 0`),
the service logs an `info` record so you can monitor rotation lag.

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `WEBHOOK_SIGNING_SECRETS` | *(required)* | Comma-separated ordered secrets. First = primary. |
| `WEBHOOK_TIMESTAMP_TOLERANCE_S` | `300` | Tolerance window in seconds. |

---

## Error codes

| HTTP | Code | Meaning |
|---|---|---|
| 401 | `webhook_timestamp_invalid` | Timestamp missing, non-numeric, or outside window |
| 401 | `webhook_signature_invalid` | No active key produces a matching HMAC |
| 401 | `webhook_replay_detected` | Signature seen within the current window |

All error messages are intentionally vague to prevent oracle attacks.

---

## Receiver example (Node.js)

```typescript
import crypto from 'crypto';

function verifyIncoming(
  rawBody: string,
  signature: string,
  timestamp: string,
  secret: string,
): boolean {
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected, 'hex'),
      Buffer.from(signature, 'hex'),
    );
  } catch {
    return false;
  }
}
```
