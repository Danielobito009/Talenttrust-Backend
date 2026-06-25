/**
 * Unit tests for webhook metrics utility functions.
 * @module webhookMetrics.test
 */

import { register } from 'prom-client';
import {
  webhookDlqOperationsTotal,
  incrementDlqOperation,
  webhookDlqReplaysTotal,
  incrementDlqReplay,
} from './webhookMetrics';

describe('webhookMetrics', () => {
  /**
   * Reset the Prometheus registry before each test to ensure test isolation.
   * This prevents metrics from one test polluting another.
   * We use resetMetrics() instead of clear() to keep the metrics registered.
   */
  beforeEach(() => {
    register.resetMetrics();
  });

  describe('webhookDlqOperationsTotal', () => {
    it('has the correct metric name and help text', () => {
      expect((webhookDlqOperationsTotal as any).name).toBe('webhook_dlq_operations_total');
      expect((webhookDlqOperationsTotal as any).help).toBe('Total number of webhook DLQ core operations.');
    });

    it('has the correct label names', () => {
      expect((webhookDlqOperationsTotal as any).labelNames).toEqual(['operation']);
    });

    it('is a Counter metric type', () => {
      expect((webhookDlqOperationsTotal as any).type).toBe('counter');
    });

    it('ensures label cardinality is bounded (only operation label)', () => {
      // Verify that only the expected label exists
      expect((webhookDlqOperationsTotal as any).labelNames.length).toBe(1);
      expect((webhookDlqOperationsTotal as any).labelNames).toContain('operation');
      // Ensure no URL or other high-cardinality labels are present
      expect((webhookDlqOperationsTotal as any).labelNames).not.toContain('url');
      expect((webhookDlqOperationsTotal as any).labelNames).not.toContain('host');
      expect((webhookDlqOperationsTotal as any).labelNames).not.toContain('endpoint');
    });
  });

  describe('incrementDlqOperation', () => {
    it('increments the counter for enqueue operation', async () => {
      incrementDlqOperation('enqueue');
      
      const metrics = await register.getMetricsAsJSON();
      const counter = metrics.find((m: any) => m.name === 'webhook_dlq_operations_total');
      expect(counter).toBeDefined();
      const value = (counter!.values as any[]).find((v: any) => v.labels.operation === 'enqueue');
      expect(value?.value).toBe(1);
    });

    it('increments the counter for drop_overflow operation', async () => {
      incrementDlqOperation('drop_overflow');
      
      const metrics = await register.getMetricsAsJSON();
      const counter = metrics.find((m: any) => m.name === 'webhook_dlq_operations_total');
      expect(counter).toBeDefined();
      const value = (counter!.values as any[]).find((v: any) => v.labels.operation === 'drop_overflow');
      expect(value?.value).toBe(1);
    });

    it('increments the counter for drop_poison operation', async () => {
      incrementDlqOperation('drop_poison');
      
      const metrics = await register.getMetricsAsJSON();
      const counter = metrics.find((m: any) => m.name === 'webhook_dlq_operations_total');
      expect(counter).toBeDefined();
      const value = (counter!.values as any[]).find((v: any) => v.labels.operation === 'drop_poison');
      expect(value?.value).toBe(1);
    });

    it('increments multiple times for the same operation', async () => {
      incrementDlqOperation('enqueue');
      incrementDlqOperation('enqueue');
      incrementDlqOperation('enqueue');
      
      const metrics = await register.getMetricsAsJSON();
      const counter = metrics.find((m: any) => m.name === 'webhook_dlq_operations_total');
      const value = (counter!.values as any[]).find((v: any) => v.labels.operation === 'enqueue');
      expect(value?.value).toBe(3);
    });

    it('tracks different operations independently', async () => {
      incrementDlqOperation('enqueue');
      incrementDlqOperation('enqueue');
      incrementDlqOperation('drop_overflow');
      incrementDlqOperation('drop_poison');
      
      const metrics = await register.getMetricsAsJSON();
      const counter = metrics.find((m: any) => m.name === 'webhook_dlq_operations_total');
      
      const enqueueValue = (counter!.values as any[]).find((v: any) => v.labels.operation === 'enqueue');
      const dropOverflowValue = (counter!.values as any[]).find((v: any) => v.labels.operation === 'drop_overflow');
      const dropPoisonValue = (counter!.values as any[]).find((v: any) => v.labels.operation === 'drop_poison');
      
      expect(enqueueValue?.value).toBe(2);
      expect(dropOverflowValue?.value).toBe(1);
      expect(dropPoisonValue?.value).toBe(1);
    });

    it('does not leak high-cardinality data into labels', async () => {
      // This test ensures that the function only uses the bounded 'operation' label
      // and does not accept or use any other labels that could cause cardinality explosion
      incrementDlqOperation('enqueue');
      
      const metrics = await register.getMetricsAsJSON();
      const dlqMetric = metrics.find((m: any) => m.name === 'webhook_dlq_operations_total');
      
      expect(dlqMetric).toBeDefined();
      expect(dlqMetric!.values).toHaveLength(1);
      expect((dlqMetric!.values as any[])[0].labels).toEqual({ operation: 'enqueue' });
      // Ensure no unexpected labels are present
      Object.keys((dlqMetric!.values as any[])[0].labels).forEach((key) => {
        expect(key).toBe('operation');
      });
    });
  });

  describe('webhookDlqReplaysTotal', () => {
    it('has the correct metric name and help text', () => {
      expect((webhookDlqReplaysTotal as any).name).toBe('webhook_dlq_replays_total');
      expect((webhookDlqReplaysTotal as any).help).toBe('Total tracking counts of webhook DLQ manual or batch replay jobs executed.');
    });

    it('has the correct label names', () => {
      expect((webhookDlqReplaysTotal as any).labelNames).toEqual(['outcome']);
    });

    it('is a Counter metric type', () => {
      expect((webhookDlqReplaysTotal as any).type).toBe('counter');
    });

    it('ensures label cardinality is bounded (only outcome label)', () => {
      // Verify that only the expected label exists
      expect((webhookDlqReplaysTotal as any).labelNames.length).toBe(1);
      expect((webhookDlqReplaysTotal as any).labelNames).toContain('outcome');
      // Ensure no URL or other high-cardinality labels are present
      expect((webhookDlqReplaysTotal as any).labelNames).not.toContain('url');
      expect((webhookDlqReplaysTotal as any).labelNames).not.toContain('host');
      expect((webhookDlqReplaysTotal as any).labelNames).not.toContain('endpoint');
      expect((webhookDlqReplaysTotal as any).labelNames).not.toContain('webhook_id');
    });
  });

  describe('incrementDlqReplay', () => {
    it('increments the counter for success outcome', async () => {
      incrementDlqReplay('success');
      
      const metrics = await register.getMetricsAsJSON();
      const counter = metrics.find((m: any) => m.name === 'webhook_dlq_replays_total');
      expect(counter).toBeDefined();
      const value = (counter!.values as any[]).find((v: any) => v.labels.outcome === 'success');
      expect(value?.value).toBe(1);
    });

    it('increments the counter for failed outcome', async () => {
      incrementDlqReplay('failed');
      
      const metrics = await register.getMetricsAsJSON();
      const counter = metrics.find((m: any) => m.name === 'webhook_dlq_replays_total');
      expect(counter).toBeDefined();
      const value = (counter!.values as any[]).find((v: any) => v.labels.outcome === 'failed');
      expect(value?.value).toBe(1);
    });

    it('increments the counter for idempotent_noop outcome', async () => {
      incrementDlqReplay('idempotent_noop');
      
      const metrics = await register.getMetricsAsJSON();
      const counter = metrics.find((m: any) => m.name === 'webhook_dlq_replays_total');
      expect(counter).toBeDefined();
      const value = (counter!.values as any[]).find((v: any) => v.labels.outcome === 'idempotent_noop');
      expect(value?.value).toBe(1);
    });

    it('increments the counter for error outcome', async () => {
      incrementDlqReplay('error');
      
      const metrics = await register.getMetricsAsJSON();
      const counter = metrics.find((m: any) => m.name === 'webhook_dlq_replays_total');
      expect(counter).toBeDefined();
      const value = (counter!.values as any[]).find((v: any) => v.labels.outcome === 'error');
      expect(value?.value).toBe(1);
    });

    it('increments multiple times for the same outcome', async () => {
      incrementDlqReplay('success');
      incrementDlqReplay('success');
      incrementDlqReplay('success');
      
      const metrics = await register.getMetricsAsJSON();
      const counter = metrics.find((m: any) => m.name === 'webhook_dlq_replays_total');
      const value = (counter!.values as any[]).find((v: any) => v.labels.outcome === 'success');
      expect(value?.value).toBe(3);
    });

    it('tracks different outcomes independently', async () => {
      incrementDlqReplay('success');
      incrementDlqReplay('success');
      incrementDlqReplay('failed');
      incrementDlqReplay('idempotent_noop');
      incrementDlqReplay('error');
      
      const metrics = await register.getMetricsAsJSON();
      const counter = metrics.find((m: any) => m.name === 'webhook_dlq_replays_total');
      
      const successValue = (counter!.values as any[]).find((v: any) => v.labels.outcome === 'success');
      const failedValue = (counter!.values as any[]).find((v: any) => v.labels.outcome === 'failed');
      const idempotentValue = (counter!.values as any[]).find((v: any) => v.labels.outcome === 'idempotent_noop');
      const errorValue = (counter!.values as any[]).find((v: any) => v.labels.outcome === 'error');
      
      expect(successValue?.value).toBe(2);
      expect(failedValue?.value).toBe(1);
      expect(idempotentValue?.value).toBe(1);
      expect(errorValue?.value).toBe(1);
    });

    it('does not leak high-cardinality data into labels', async () => {
      // This test ensures that the function only uses the bounded 'outcome' label
      // and does not accept or use any other labels that could cause cardinality explosion
      incrementDlqReplay('success');
      
      const metrics = await register.getMetricsAsJSON();
      const replayMetric = metrics.find((m: any) => m.name === 'webhook_dlq_replays_total');
      
      expect(replayMetric).toBeDefined();
      expect(replayMetric!.values).toHaveLength(1);
      expect((replayMetric!.values as any[])[0].labels).toEqual({ outcome: 'success' });
      // Ensure no unexpected labels are present
      Object.keys((replayMetric!.values as any[])[0].labels).forEach((key) => {
        expect(key).toBe('outcome');
      });
    });
  });

  describe('Metric isolation between tests', () => {
    it('ensures DLQ operations counter starts fresh after registry clear', async () => {
      // First increment
      incrementDlqOperation('enqueue');
      
      let metrics = await register.getMetricsAsJSON();
      let counter = metrics.find((m: any) => m.name === 'webhook_dlq_operations_total');
      let value = (counter!.values as any[]).find((v: any) => v.labels.operation === 'enqueue');
      expect(value?.value).toBe(1);
      
      // Reset registry (simulating test isolation)
      register.resetMetrics();
      
      // Re-increment after clear
      incrementDlqOperation('enqueue');
      
      metrics = await register.getMetricsAsJSON();
      counter = metrics.find((m: any) => m.name === 'webhook_dlq_operations_total');
      value = (counter!.values as any[]).find((v: any) => v.labels.operation === 'enqueue');
      expect(value?.value).toBe(1); // Should be 1, not 2
    });

    it('ensures DLQ replays counter starts fresh after registry clear', async () => {
      // First increment
      incrementDlqReplay('success');
      
      let metrics = await register.getMetricsAsJSON();
      let counter = metrics.find((m: any) => m.name === 'webhook_dlq_replays_total');
      let value = (counter!.values as any[]).find((v: any) => v.labels.outcome === 'success');
      expect(value?.value).toBe(1);
      
      // Reset registry (simulating test isolation)
      register.resetMetrics();
      
      // Re-increment after clear
      incrementDlqReplay('success');
      
      metrics = await register.getMetricsAsJSON();
      counter = metrics.find((m: any) => m.name === 'webhook_dlq_replays_total');
      value = (counter!.values as any[]).find((v: any) => v.labels.outcome === 'success');
      expect(value?.value).toBe(1); // Should be 1, not 2
    });

    it('ensures both metrics are independent of each other', async () => {
      incrementDlqOperation('enqueue');
      incrementDlqReplay('success');
      
      const metrics = await register.getMetricsAsJSON();
      
      const dlqOpsMetric = metrics.find((m: any) => m.name === 'webhook_dlq_operations_total');
      const dlqReplaysMetric = metrics.find((m: any) => m.name === 'webhook_dlq_replays_total');
      
      expect(dlqOpsMetric).toBeDefined();
      expect(dlqReplaysMetric).toBeDefined();
      expect((dlqOpsMetric!.values as any[])[0].labels).toEqual({ operation: 'enqueue' });
      expect((dlqReplaysMetric!.values as any[])[0].labels).toEqual({ outcome: 'success' });
    });
  });

  describe('Label cardinality enforcement', () => {
    it('verifies DLQ operations uses only bounded enum values', () => {
      const allowedOperations = ['enqueue', 'drop_overflow', 'drop_poison'];
      
      allowedOperations.forEach((operation) => {
        expect(() => {
          incrementDlqOperation(operation as any);
        }).not.toThrow();
      });
    });

    it('verifies DLQ replays uses only bounded enum values', () => {
      const allowedOutcomes = ['success', 'failed', 'idempotent_noop', 'error'];
      
      allowedOutcomes.forEach((outcome) => {
        expect(() => {
          incrementDlqReplay(outcome as any);
        }).not.toThrow();
      });
    });

    it('ensures no dynamic label values are accepted', async () => {
      // The functions only accept specific enum values, preventing arbitrary label injection
      // This is enforced at compile time by TypeScript, but we verify the runtime behavior
      
      // These should work (valid enum values)
      expect(() => incrementDlqOperation('enqueue')).not.toThrow();
      expect(() => incrementDlqReplay('success')).not.toThrow();
      
      // After incrementing, verify only the expected labels exist
      const metrics = await register.getMetricsAsJSON();
      
      metrics.forEach((metric: any) => {
        (metric.values as any[]).forEach((data: any) => {
          Object.keys(data.labels).forEach((labelKey) => {
            // All label keys should be from the predefined set
            const allowedLabelKeys = ['operation', 'outcome'];
            expect(allowedLabelKeys).toContain(labelKey);
          });
        });
      });
    });
  });
});

