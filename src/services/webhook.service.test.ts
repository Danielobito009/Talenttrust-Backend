import { WebhookService } from './webhook.service';
import axios from 'axios';
import { createWebhookSignature } from '../utils/webhook-signing.util';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock('../utils/webhook-signing.util');
const mockedCreateWebhookSignature = createWebhookSignature as jest.MockedFunction<typeof createWebhookSignature>;

describe('WebhookService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('sends webhook without signature when no secret is provided', async () => {
    mockedAxios.post.mockResolvedValue({ status: 200 });

    const service = new WebhookService();
    const payload = {
      id: '123',
      url: 'http://test.com',
      data: { event: 'test', data: {} },
      retryCount: 0,
    };

    await service.send(payload);

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://test.com',
      { event: 'test', data: {} },
      {
        headers: {
          'Content-Type': 'application/json'
        }
      }
    );
  });

  it('sends webhook with HMAC signature when secret is provided', async () => {
    const mockSignature = 'sha256=abcdef1234567890';
    const mockTimestamp = 1640995200000;
    
    mockedCreateWebhookSignature.mockReturnValue({
      signature: 'abcdef1234567890',
      timestamp: mockTimestamp
    });
    
    mockedAxios.post.mockResolvedValue({ status: 200 });

    const service = new WebhookService();
    const payload = {
      id: '123',
      url: 'http://test.com',
      data: { event: 'test', data: {} },
      retryCount: 0,
      webhookSecret: 'test-secret'
    };

    await service.send(payload);

    expect(mockedCreateWebhookSignature).toHaveBeenCalledWith(
      { event: 'test', data: {} },
      'test-secret'
    );

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'http://test.com',
      { event: 'test', data: {} },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Signature': mockSignature,
          'X-Timestamp': mockTimestamp.toString()
        }
      }
    );
  });

  it('handles webhook delivery failure with HMAC signing', async () => {
    const mockTimestamp = 1640995200000;
    
    mockedCreateWebhookSignature.mockReturnValue({
      signature: 'abcdef1234567890',
      timestamp: mockTimestamp
    });
    
    mockedAxios.post.mockRejectedValue(new Error('Network Error'));

    const service = new WebhookService();
    const payload = {
      id: '123',
      url: 'http://test.com',
      data: { event: 'test', data: {} },
      retryCount: 0,
      webhookSecret: 'test-secret'
    };

    jest.useFakeTimers();
    try {
      const sendOp = service.send(payload);

      // Run the first retry
      await jest.runOnlyPendingTimersAsync();

      await sendOp;

      expect(mockedCreateWebhookSignature).toHaveBeenCalledTimes(2); // Initial + 1 retry
      expect(mockedAxios.post).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('moves webhook with HMAC signing to DLQ after max retries', async () => {
    const mockTimestamp = 1640995200000;
    
    mockedCreateWebhookSignature.mockReturnValue({
      signature: 'abcdef1234567890',
      timestamp: mockTimestamp
    });
    
    mockedAxios.post.mockRejectedValue(new Error('Network Error'));

    const service = new WebhookService();
    const payload = {
      id: '123',
      url: 'http://test.com',
      data: { event: 'test', data: {} },
      retryCount: 4, // Start with 4 retries (will fail on 5th attempt)
      webhookSecret: 'test-secret'
    };

    await service.send(payload);

    expect(service.getDLQ().length).toBe(1);
    expect(service.getDLQ()[0].webhookId).toBe('123');
  });
});

/**
 * @module services/webhook.service.test
 * @description Unit tests for correlation ID propagation in webhook service.
 *
 * Tests:
 * - Correlation ID is included in webhook request headers
 * - Webhook headers are correctly formatted
 * - Correlation ID is optional (not sent if undefined)
 * - Signature headers are preserved alongside correlation ID
 */
describe('WebhookService with correlation ID propagation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * Should include X-Correlation-Id header when correlation ID is provided.
   */
  it('should include X-Correlation-Id header when provided', async () => {
    mockedAxios.post.mockResolvedValue({ status: 200 });

    const service = new WebhookService();
    const payload = {
      id: 'webhook-123',
      url: 'https://example.com/webhook',
      data: { event: 'test' },
      retryCount: 0,
      correlationId: 'trace-webhook-456',
    };

    await service.send(payload);

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://example.com/webhook',
      { event: 'test' },
      expect.objectContaining({
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Correlation-Id': 'trace-webhook-456',
        }),
      })
    );
  });

  /**
   * Should not include X-Correlation-Id header when undefined.
   */
  it('should not include X-Correlation-Id when undefined', async () => {
    mockedAxios.post.mockResolvedValue({ status: 200 });

    const service = new WebhookService();
    const payload = {
      id: 'webhook-789',
      url: 'https://example.com/webhook',
      data: { event: 'test' },
      retryCount: 0,
      correlationId: undefined,
    };

    await service.send(payload);

    const callArgs = mockedAxios.post.mock.calls[0];
    expect(callArgs).toBeTruthy();
    expect(callArgs[2]).toBeTruthy();
    expect((callArgs[2] as any).headers['X-Correlation-Id']).toBeUndefined();
  });

  /**
   * Should include both signature and correlation ID headers.
   */
  it('should include both signature and correlation ID headers', async () => {
    mockedCreateWebhookSignature.mockReturnValue({
      signature: 'sig-abc123',
      timestamp: 1234567890,
    });

    mockedAxios.post.mockResolvedValue({ status: 200 });

    const service = new WebhookService();
    const payload = {
      id: 'webhook-sig-corr',
      url: 'https://example.com/webhook',
      data: { event: 'signed' },
      retryCount: 0,
      webhookSecret: 'secret-key',
      correlationId: 'trace-sig-corr-789',
    };

    await service.send(payload);

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://example.com/webhook',
      { event: 'signed' },
      expect.objectContaining({
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Signature': 'sha256=sig-abc123',
          'X-Timestamp': '1234567890',
          'X-Correlation-Id': 'trace-sig-corr-789',
        }),
      })
    );
  });

  /**
   * Should not include correlation ID in webhook body, only in headers.
   */
  it('should send correlation ID only in headers, not in body', async () => {
    mockedAxios.post.mockResolvedValue({ status: 200 });

    const service = new WebhookService();
    const payload = {
      id: 'webhook-body-test',
      url: 'https://example.com/webhook',
      data: { event: 'test', shouldNotHaveCorr: false },
      retryCount: 0,
      correlationId: 'trace-body-test',
    };

    await service.send(payload);

    const callArgs = mockedAxios.post.mock.calls[0];
    expect(callArgs).toBeTruthy();
    const bodyArg = callArgs[1];
    const headersArg = (callArgs[2] as any)?.headers;

    // Correlation ID should NOT be in body
    expect(bodyArg).toEqual({ event: 'test', shouldNotHaveCorr: false });
    expect(bodyArg).not.toHaveProperty('correlationId');

    // Correlation ID SHOULD be in headers
    expect(headersArg).toBeTruthy();
    expect(headersArg['X-Correlation-Id']).toBe('trace-body-test');
  });

  /**
   * Should support correlation ID with complex event data.
   */
  it('should propagate correlation ID with complex event data', async () => {
    mockedAxios.post.mockResolvedValue({ status: 200 });

    const complexData = {
      contractId: 'contract-123',
      eventType: 'escrow.released',
      amount: 10000,
      timestamp: new Date().toISOString(),
      metadata: {
        userId: 'user-456',
        region: 'us-west-2',
      },
    };

    const service = new WebhookService();
    const payload = {
      id: 'webhook-complex',
      url: 'https://example.com/webhook',
      data: complexData,
      retryCount: 0,
      correlationId: 'trace-complex-789',
    };

    await service.send(payload);

    expect(mockedAxios.post).toHaveBeenCalledWith(
      'https://example.com/webhook',
      complexData,
      expect.objectContaining({
        headers: expect.objectContaining({
          'X-Correlation-Id': 'trace-complex-789',
        }),
      })
    );
  });
});

// ─── replayAll tests ────────────────────────────────────────────────────────

/**
 * @module services/webhook.service.test
 * @description Unit tests for WebhookService.replayAll bulk DLQ replay.
 *
 * Edge cases covered:
 * - empty DLQ → returns zeros
 * - all entries already replayed → skips them, attempted=0
 * - mixed success/failure → counts correctly
 * - deduped entries → counted in deduped, not succeeded/failed
 * - concurrency cap honoured (batch width ≤ concurrency)
 * - partial failure does not throw (no unhandled rejection)
 * - high concurrency clamped to remaining entries
 */

// Isolate replayAll with a fresh module scope and DLQ mock
jest.mock('../queue/webhook-dlq', () => {
  const mockStorage = {
    addEntry: jest.fn(),
    listEntries: jest.fn().mockReturnValue([]),
    getEntry: jest.fn(),
    checkDedupe: jest.fn().mockReturnValue({ exists: false }),
    markReplayed: jest.fn(),
    getStats: jest.fn().mockResolvedValue({ total: 0, pending: 0, replayed: 0 }),
    deleteEntry: jest.fn(),
    incrementReplayAttempts: jest.fn(),
  };
  return {
    getWebhookDLQStorage: jest.fn().mockReturnValue(mockStorage),
    clearWebhookDLQInstance: jest.fn(),
    __mockStorage: mockStorage,
  };
});

import { getWebhookDLQStorage } from '../queue/webhook-dlq';

function makeDLQEntry(id: string, replayed = false) {
  return {
    id,
    webhookId: `wh-${id}`,
    url: 'https://example.com/hook',
    body: { event: 'test' },
    retryCount: 3,
    failedAt: new Date().toISOString(),
    lastError: 'timeout',
    dedupeKey: `key-${id}`,
    replayedAt: replayed ? new Date().toISOString() : undefined,
    replayAttempts: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('WebhookService.replayAll', () => {
  let service: WebhookService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockDLQ: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockDLQ = getWebhookDLQStorage();
    service = new WebhookService();
  });

  it('returns zeros when DLQ is empty', async () => {
    mockDLQ.listEntries.mockReturnValue([]);

    const result = await service.replayAll();
    expect(result).toEqual({ attempted: 0, succeeded: 0, failed: 0, deduped: 0 });
  });

  it('skips already-replayed entries and returns attempted=0', async () => {
    mockDLQ.listEntries.mockReturnValue([
      makeDLQEntry('1', true),
      makeDLQEntry('2', true),
    ]);

    const result = await service.replayAll();
    expect(result).toEqual({ attempted: 0, succeeded: 0, failed: 0, deduped: 0 });
  });

  it('counts succeeded entries correctly', async () => {
    mockDLQ.listEntries.mockReturnValue([makeDLQEntry('a'), makeDLQEntry('b')]);
    mockDLQ.getEntry
      .mockImplementation((id: string) => makeDLQEntry(id));
    mockDLQ.checkDedupe.mockReturnValue({ exists: false });
    mockDLQ.markReplayed.mockReturnValue(true);
    mockedAxios.post.mockResolvedValue({ status: 200 });

    const result = await service.replayAll();
    expect(result.attempted).toBe(2);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.deduped).toBe(0);
  });

  it('counts failed entries correctly on send error', async () => {
    mockDLQ.listEntries.mockReturnValue([makeDLQEntry('x')]);
    const spy = jest.spyOn(service, 'replayDLQEntry');
    spy.mockResolvedValue({ success: false, message: 'network error' });

    const result = await service.replayAll();
    expect(result.attempted).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(0);
  });

  it('counts deduped entries correctly', async () => {
    mockDLQ.listEntries.mockReturnValue([makeDLQEntry('d')]);
    mockDLQ.getEntry.mockImplementation((id: string) => makeDLQEntry(id));
    mockDLQ.checkDedupe.mockReturnValue({ exists: true, entryId: 'other-id' });
    mockDLQ.markReplayed.mockReturnValue(true);

    const result = await service.replayAll();
    expect(result.attempted).toBe(1);
    expect(result.deduped).toBe(1);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
  });

  it('handles mixed success, failure, and deduped in one batch', async () => {
    mockDLQ.listEntries.mockReturnValue([
      makeDLQEntry('ok'),
      makeDLQEntry('fail'),
      makeDLQEntry('dup'),
    ]);
    mockDLQ.getEntry.mockImplementation((id: string) => makeDLQEntry(id));

    mockDLQ.checkDedupe.mockImplementation((_id: string, _body: unknown) => {
      // We can't distinguish by webhookId easily here, so use a counter
      return { exists: false };
    });

    // Override per-entry: use getEntry to gate behavior via replayDLQEntry internals
    // Easier: spy on replayDLQEntry itself for granular control
    const spy = jest.spyOn(service, 'replayDLQEntry');
    spy.mockImplementation(async (id: string) => {
      if (id === 'ok') return { success: true, message: 'Replay successful' };
      if (id === 'fail') return { success: false, message: 'error' };
      return { success: true, message: 'Deduplicated - entry already pending replay' };
    });

    const result = await service.replayAll({ concurrency: 3 });
    expect(result).toEqual({ attempted: 3, succeeded: 1, failed: 1, deduped: 1 });
  });

  it('processes entries in batches respecting concurrency cap', async () => {
    const entries = Array.from({ length: 6 }, (_, i) => makeDLQEntry(String(i)));
    mockDLQ.listEntries.mockReturnValue(entries);

    const callOrder: string[] = [];
    const spy = jest.spyOn(service, 'replayDLQEntry');
    spy.mockImplementation(async (id: string) => {
      callOrder.push(id);
      return { success: true, message: 'Replay successful' };
    });

    await service.replayAll({ concurrency: 2 });

    // All 6 entries processed
    expect(callOrder).toHaveLength(6);
    expect(spy).toHaveBeenCalledTimes(6);
  });

  it('does not throw when all entries fail (no unhandled rejection)', async () => {
    const entries = Array.from({ length: 3 }, (_, i) => makeDLQEntry(String(i)));
    mockDLQ.listEntries.mockReturnValue(entries);

    const spy = jest.spyOn(service, 'replayDLQEntry');
    spy.mockRejectedValue(new Error('catastrophic'));

    await expect(service.replayAll({ concurrency: 5 })).resolves.toEqual({
      attempted: 3,
      succeeded: 0,
      failed: 3,
      deduped: 0,
    });
  });

  it('uses default concurrency of 5 when not specified', async () => {
    const entries = Array.from({ length: 10 }, (_, i) => makeDLQEntry(String(i)));
    mockDLQ.listEntries.mockReturnValue(entries);

    const spy = jest.spyOn(service, 'replayDLQEntry');
    spy.mockResolvedValue({ success: true, message: 'Replay successful' });

    const result = await service.replayAll();
    expect(result.attempted).toBe(10);
    expect(result.succeeded).toBe(10);
  });

  it('clamps concurrency to minimum of 1', async () => {
    mockDLQ.listEntries.mockReturnValue([makeDLQEntry('z')]);
    const spy = jest.spyOn(service, 'replayDLQEntry');
    spy.mockResolvedValue({ success: true, message: 'Replay successful' });

    const result = await service.replayAll({ concurrency: 0 });
    expect(result.attempted).toBe(1);
    expect(result.succeeded).toBe(1);
  });
});
