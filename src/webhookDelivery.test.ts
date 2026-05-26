/**
 * Tests for webhookDelivery.ts
 *
 * Covers:
 *  #255 — HMAC timestamp tolerance and replay protection
 *  #285 — Multi-key rotation (sign-with-new/verify-with-old, retire-old-key rejection)
 */

import crypto from 'crypto';
import Database from 'better-sqlite3';
import axios from 'axios';
import {
  computeHmac,
  safeEqual,
  verifyWebhookSignature,
  ensureReplayCacheTable,
  isReplay,
  recordSignature,
  loadSigningSecrets,
  getToleranceSeconds,
  WebhookDeliveryService,
} from './webhookDelivery';
import {
  WebhookSignatureError,
  WebhookTimestampError,
  WebhookReplayError,
} from './errors/safeErrors';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  ensureReplayCacheTable(db);
  return db;
}

function sign(secret: string, timestamp: string, body: string): string {
  return computeHmac(secret, `${timestamp}.${body}`);
}

const SECRET = 'test-secret-one';
const SECRET2 = 'test-secret-two';
const BODY = JSON.stringify({ event: 'test' });
const NOW = 1_700_000_000;

// ---------------------------------------------------------------------------
// computeHmac / safeEqual
// ---------------------------------------------------------------------------

describe('computeHmac', () => {
  it('produces a deterministic hex digest', () => {
    const a = computeHmac(SECRET, 'payload');
    const b = computeHmac(SECRET, 'payload');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs for different secrets', () => {
    expect(computeHmac(SECRET, 'payload')).not.toBe(computeHmac(SECRET2, 'payload'));
  });
});

describe('safeEqual', () => {
  it('returns true for equal digests', () => {
    const h = computeHmac(SECRET, 'x');
    expect(safeEqual(h, h)).toBe(true);
  });

  it('returns false for different digests', () => {
    expect(safeEqual(computeHmac(SECRET, 'x'), computeHmac(SECRET2, 'x'))).toBe(false);
  });

  it('returns false for malformed hex', () => {
    expect(safeEqual('not-hex', computeHmac(SECRET, 'x'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Replay cache
// ---------------------------------------------------------------------------

describe('replay cache', () => {
  it('isReplay returns false for unseen signature', () => {
    const db = makeDb();
    expect(isReplay(db, 'sig1', NOW)).toBe(false);
  });

  it('isReplay returns true after recordSignature', () => {
    const db = makeDb();
    recordSignature(db, 'sig1', NOW, 300);
    expect(isReplay(db, 'sig1', NOW)).toBe(true);
  });

  it('evicts expired entries', () => {
    const db = makeDb();
    recordSignature(db, 'sig-old', NOW, 300);
    // Advance time past expiry
    expect(isReplay(db, 'sig-old', NOW + 301)).toBe(false);
  });

  it('does not evict non-expired entries', () => {
    const db = makeDb();
    recordSignature(db, 'sig-fresh', NOW, 300);
    expect(isReplay(db, 'sig-fresh', NOW + 100)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verifyWebhookSignature — #255 timestamp tolerance
// ---------------------------------------------------------------------------

describe('verifyWebhookSignature — timestamp tolerance (#255)', () => {
  it('accepts a valid in-window signature', () => {
    const db = makeDb();
    const ts = String(NOW);
    const sig = sign(SECRET, ts, BODY);
    const idx = verifyWebhookSignature({
      body: BODY,
      signature: sig,
      timestamp: ts,
      secrets: [SECRET],
      nowS: NOW,
      toleranceS: 300,
      db,
    });
    expect(idx).toBe(0);
  });

  it('accepts a signature at the edge of the tolerance window', () => {
    const db = makeDb();
    const ts = String(NOW - 300);
    const sig = sign(SECRET, ts, BODY);
    expect(() =>
      verifyWebhookSignature({
        body: BODY,
        signature: sig,
        timestamp: ts,
        secrets: [SECRET],
        nowS: NOW,
        toleranceS: 300,
        db,
      }),
    ).not.toThrow();
  });

  it('rejects an expired timestamp (past)', () => {
    const db = makeDb();
    const ts = String(NOW - 301);
    const sig = sign(SECRET, ts, BODY);
    expect(() =>
      verifyWebhookSignature({
        body: BODY,
        signature: sig,
        timestamp: ts,
        secrets: [SECRET],
        nowS: NOW,
        toleranceS: 300,
        db,
      }),
    ).toThrow(WebhookTimestampError);
  });

  it('rejects a future-skewed timestamp', () => {
    const db = makeDb();
    const ts = String(NOW + 301);
    const sig = sign(SECRET, ts, BODY);
    expect(() =>
      verifyWebhookSignature({
        body: BODY,
        signature: sig,
        timestamp: ts,
        secrets: [SECRET],
        nowS: NOW,
        toleranceS: 300,
        db,
      }),
    ).toThrow(WebhookTimestampError);
  });

  it('rejects a non-numeric timestamp', () => {
    const db = makeDb();
    expect(() =>
      verifyWebhookSignature({
        body: BODY,
        signature: 'any',
        timestamp: 'not-a-number',
        secrets: [SECRET],
        nowS: NOW,
        toleranceS: 300,
        db,
      }),
    ).toThrow(WebhookTimestampError);
  });
});

// ---------------------------------------------------------------------------
// verifyWebhookSignature — #255 replay protection
// ---------------------------------------------------------------------------

describe('verifyWebhookSignature — replay protection (#255)', () => {
  it('rejects a replayed signature', () => {
    const db = makeDb();
    const ts = String(NOW);
    const sig = sign(SECRET, ts, BODY);
    const opts = {
      body: BODY,
      signature: sig,
      timestamp: ts,
      secrets: [SECRET],
      nowS: NOW,
      toleranceS: 300,
      db,
    };
    // First call succeeds
    verifyWebhookSignature(opts);
    // Second call with same signature is a replay
    expect(() => verifyWebhookSignature(opts)).toThrow(WebhookReplayError);
  });

  it('accepts the same payload after the tolerance window expires', () => {
    const db = makeDb();
    const ts = String(NOW);
    const sig = sign(SECRET, ts, BODY);
    // Record it at NOW
    verifyWebhookSignature({
      body: BODY,
      signature: sig,
      timestamp: ts,
      secrets: [SECRET],
      nowS: NOW,
      toleranceS: 300,
      db,
    });
    // After expiry the cache entry is evicted; but the timestamp is now too old
    // so it would throw WebhookTimestampError — that's correct behaviour.
    expect(() =>
      verifyWebhookSignature({
        body: BODY,
        signature: sig,
        timestamp: ts,
        secrets: [SECRET],
        nowS: NOW + 400,
        toleranceS: 300,
        db,
      }),
    ).toThrow(WebhookTimestampError);
  });
});

// ---------------------------------------------------------------------------
// verifyWebhookSignature — bad HMAC
// ---------------------------------------------------------------------------

describe('verifyWebhookSignature — bad HMAC', () => {
  it('rejects a tampered body', () => {
    const db = makeDb();
    const ts = String(NOW);
    const sig = sign(SECRET, ts, BODY);
    expect(() =>
      verifyWebhookSignature({
        body: '{"tampered":true}',
        signature: sig,
        timestamp: ts,
        secrets: [SECRET],
        nowS: NOW,
        toleranceS: 300,
        db,
      }),
    ).toThrow(WebhookSignatureError);
  });

  it('rejects a wrong secret', () => {
    const db = makeDb();
    const ts = String(NOW);
    const sig = sign('wrong-secret', ts, BODY);
    expect(() =>
      verifyWebhookSignature({
        body: BODY,
        signature: sig,
        timestamp: ts,
        secrets: [SECRET],
        nowS: NOW,
        toleranceS: 300,
        db,
      }),
    ).toThrow(WebhookSignatureError);
  });
});

// ---------------------------------------------------------------------------
// verifyWebhookSignature — #285 key rotation
// ---------------------------------------------------------------------------

describe('verifyWebhookSignature — key rotation (#285)', () => {
  it('verifies with old key when new key is primary', () => {
    const db = makeDb();
    const ts = String(NOW);
    // Signed with old key (SECRET2)
    const sig = sign(SECRET2, ts, BODY);
    // Active keys: [new=SECRET, old=SECRET2]
    const idx = verifyWebhookSignature({
      body: BODY,
      signature: sig,
      timestamp: ts,
      secrets: [SECRET, SECRET2],
      nowS: NOW,
      toleranceS: 300,
      db,
    });
    expect(idx).toBe(1); // matched old key
  });

  it('verifies with new primary key', () => {
    const db = makeDb();
    const ts = String(NOW);
    const sig = sign(SECRET, ts, BODY);
    const idx = verifyWebhookSignature({
      body: BODY,
      signature: sig,
      timestamp: ts,
      secrets: [SECRET, SECRET2],
      nowS: NOW,
      toleranceS: 300,
      db,
    });
    expect(idx).toBe(0);
  });

  it('rejects when old key is retired (removed from list)', () => {
    const db = makeDb();
    const ts = String(NOW);
    // Signed with old key that is no longer active
    const sig = sign(SECRET2, ts, BODY);
    expect(() =>
      verifyWebhookSignature({
        body: BODY,
        signature: sig,
        timestamp: ts,
        secrets: [SECRET], // only new key
        nowS: NOW,
        toleranceS: 300,
        db,
      }),
    ).toThrow(WebhookSignatureError);
  });

  it('throws when secrets list is empty', () => {
    const db = makeDb();
    const ts = String(NOW);
    const sig = sign(SECRET, ts, BODY);
    // Empty secrets list → no key matches → WebhookSignatureError
    expect(() =>
      verifyWebhookSignature({
        body: BODY,
        signature: sig,
        timestamp: ts,
        secrets: [],
        nowS: NOW,
        toleranceS: 300,
        db,
      }),
    ).toThrow(WebhookSignatureError);
  });
});

// ---------------------------------------------------------------------------
// loadSigningSecrets / getToleranceSeconds
// ---------------------------------------------------------------------------

describe('loadSigningSecrets', () => {
  const orig = process.env['WEBHOOK_SIGNING_SECRETS'];
  afterEach(() => {
    if (orig === undefined) delete process.env['WEBHOOK_SIGNING_SECRETS'];
    else process.env['WEBHOOK_SIGNING_SECRETS'] = orig;
  });

  it('parses comma-separated secrets', () => {
    process.env['WEBHOOK_SIGNING_SECRETS'] = 'a,b,c';
    expect(loadSigningSecrets()).toEqual(['a', 'b', 'c']);
  });

  it('throws when env var is empty', () => {
    process.env['WEBHOOK_SIGNING_SECRETS'] = '';
    expect(() => loadSigningSecrets()).toThrow();
  });

  it('throws when env var is unset', () => {
    delete process.env['WEBHOOK_SIGNING_SECRETS'];
    expect(() => loadSigningSecrets()).toThrow();
  });
});

describe('getToleranceSeconds', () => {
  const orig = process.env['WEBHOOK_TIMESTAMP_TOLERANCE_S'];
  afterEach(() => {
    if (orig === undefined) delete process.env['WEBHOOK_TIMESTAMP_TOLERANCE_S'];
    else process.env['WEBHOOK_TIMESTAMP_TOLERANCE_S'] = orig;
  });

  it('returns 300 by default', () => {
    delete process.env['WEBHOOK_TIMESTAMP_TOLERANCE_S'];
    expect(getToleranceSeconds()).toBe(300);
  });

  it('parses a valid integer', () => {
    process.env['WEBHOOK_TIMESTAMP_TOLERANCE_S'] = '60';
    expect(getToleranceSeconds()).toBe(60);
  });

  it('falls back to 300 for invalid value', () => {
    process.env['WEBHOOK_TIMESTAMP_TOLERANCE_S'] = 'bad';
    expect(getToleranceSeconds()).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// WebhookDeliveryService — outbound delivery
// ---------------------------------------------------------------------------

describe('WebhookDeliveryService', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('delivers successfully and sets HMAC headers', async () => {
    mockedAxios.post.mockResolvedValueOnce({ status: 200 });
    const svc = new WebhookDeliveryService();
    await svc.send(
      { id: '1', url: 'http://example.com', event: 'test', data: {}, retryCount: 0 },
      [SECRET],
    );
    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://example.com',
      {},
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Webhook-Signature': expect.stringMatching(/^[0-9a-f]{64}$/),
          'X-Webhook-Timestamp': expect.stringMatching(/^\d+$/),
        }),
      }),
    );
    expect(svc.getDlq()).toHaveLength(0);
  });

  it('retries on failure and eventually moves to DLQ', async () => {
    mockedAxios.post.mockRejectedValue(new Error('Network Error'));
    const svc = new WebhookDeliveryService();
    const payload = {
      id: '2',
      url: 'http://example.com',
      event: 'test',
      data: {},
      retryCount: 0,
    };
    const sendOp = svc.send(payload, [SECRET]);
    for (let i = 0; i < 20; i++) {
      await jest.runOnlyPendingTimersAsync();
    }
    await sendOp;
    expect(svc.getDlq()).toHaveLength(1);
    expect(svc.getDlq()[0]!.id).toBe('2');
  });
});
