
import axios from 'axios';
import { createWebhookSignature } from '../utils/webhook-signing.util';
import { getWebhookDLQStorage, WebhookDLQEntry } from '../queue/webhook-dlq';
import { WEBHOOK_RETRY_POLICY, calculateWebhookRetryDelay } from '../queue/webhook-retry-policy';
import { MetricsServiceLike } from '../observability';

export interface WebhookPayload {
  id: string;
  url: string;
  data: unknown;
  retryCount: number;
  webhookSecret?: string;
  /** Optional correlation ID for distributed tracing across webhook deliveries. */
  correlationId?: string;
}

export class WebhookService {
  private dlqStorage = getWebhookDLQStorage();

  constructor(private readonly metrics?: MetricsServiceLike) {}

  /**
   * Sends a webhook payload with iterative bounded retry and DLQ fallback.
   *
   * @remarks
   * Uses a bounded for-loop so no call stack growth occurs across retries.
   * Retry policy and DLQ behavior are identical to the previous recursive version.
   *
   * @param payload - Webhook payload including URL, data, and retry state
   */
  async send(payload: WebhookPayload): Promise<void> {
    const maxAttempts = WEBHOOK_RETRY_POLICY.maxRetries + 1;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };

        if (payload.webhookSecret) {
          const { signature, timestamp } = createWebhookSignature(
            payload.data,
            payload.webhookSecret,
          );
          headers['X-Signature'] = `sha256=${signature}`;
          headers['X-Timestamp'] = timestamp.toString();
        }

        if (payload.correlationId) {
          headers['X-Correlation-Id'] = payload.correlationId;
        }

        await axios.post(payload.url, payload.data, { headers });
        return;
      } catch (error: unknown) {
        lastError = error as Error;
        payload.retryCount = attempt + 1;

        const isLastAttempt = attempt === maxAttempts - 1;
        if (!isLastAttempt) {
          const delay = calculateWebhookRetryDelay(attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    await this.persistToDLQ(payload, lastError?.message ?? 'Unknown error');
  }

  private async persistToDLQ(payload: WebhookPayload, error: string): Promise<void> {
    try {
      await this.dlqStorage.addEntry(
        payload.id,
        payload.url,
        payload.data as Record<string, unknown>,
        payload.retryCount,
        error,
        payload.webhookSecret,
      );
    } catch (err: unknown) {
      if ((err as Error).message === 'DUPLICATE_ENTRY') {
        return;
      }
      throw err;
    }
  }

  getDLQ(): Omit<WebhookDLQEntry, 'webhookSecret'>[] {
    const entries = this.dlqStorage.listEntries();
    return entries.map((entry) => {
      const { webhookSecret, ...rest } = entry;
      return rest;
    });
  }

  async getDLQEntry(id: string): Promise<Omit<WebhookDLQEntry, 'webhookSecret'> | null> {
    const entry = this.dlqStorage.getEntry(id);
    if (!entry) return null;
    const { webhookSecret, ...rest } = entry;
    return rest;
  }

  async replayDLQEntry(id: string): Promise<{ success: boolean; message: string }> {
    const entry = this.dlqStorage.getEntry(id);
    if (!entry) {
      return { success: false, message: 'Entry not found' };
    }

    if (entry.replayedAt) {
      return { success: false, message: 'Entry already replayed' };
    }

    const dedupe = this.dlqStorage.checkDedupe(entry.webhookId, entry.body);
    if (dedupe.exists) {
      this.dlqStorage.markReplayed(id);
      return { success: true, message: 'Deduplicated - entry already pending replay' };
    }

    try {
      await this.send({
        id: entry.webhookId,
        url: entry.url,
        data: entry.body,
        retryCount: 0,
        webhookSecret: entry.webhookSecret,
      });
      this.dlqStorage.markReplayed(id);
      return { success: true, message: 'Replay successful' };
    } catch (err) {
      return { success: false, message: (err as Error).message };
    }
  }

  async getDLQStats(): Promise<{ total: number; pending: number; replayed: number }> {
    return this.dlqStorage.getStats();
  }

  /**
   * Replays all pending DLQ entries with bounded concurrency (backpressure).
   *
   * Iterates every non-replayed DLQ entry, skipping already-replayed entries,
   * and processes up to `concurrency` entries in parallel at a time.
   *
   * @param options.concurrency - Max number of concurrent replays (default: 5).
   * @returns Summary of the bulk replay: attempted, succeeded, failed, deduped counts.
   *
   * @example
   * const summary = await webhookService.replayAll({ concurrency: 10 });
   * // { attempted: 20, succeeded: 18, failed: 1, deduped: 1 }
   */
  async replayAll(options: { concurrency?: number } = {}): Promise<{
    attempted: number;
    succeeded: number;
    failed: number;
    deduped: number;
  }> {
    const concurrency = Math.max(1, options.concurrency ?? 5);
    const entries = this.dlqStorage.listEntries({ limit: 10000 }).filter((e) => !e.replayedAt);

    let attempted = 0;
    let succeeded = 0;
    let failed = 0;
    let deduped = 0;

    for (let i = 0; i < entries.length; i += concurrency) {
      const batch = entries.slice(i, i + concurrency);
      const results = await Promise.allSettled(batch.map((e) => this.replayDLQEntry(e.id)));

      for (const result of results) {
        attempted++;
        if (result.status === 'fulfilled') {
          const { success, message } = result.value;
          if (success && message === 'Deduplicated - entry already pending replay') {
            deduped++;
          } else if (success) {
            succeeded++;
          } else {
            failed++;
          }
        } else {
          failed++;
        }
      }
    }

    return { attempted, succeeded, failed, deduped };
  }
}

