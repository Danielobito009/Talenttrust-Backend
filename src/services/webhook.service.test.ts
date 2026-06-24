import { WebhookService } from './webhook.service';
import { MetricsServiceLike } from '../observability';
import axios from 'axios';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

function makeMetrics(): jest.Mocked<Pick<MetricsServiceLike, 'recordWebhookDelivery' | 'setWebhookDlqDepth'>> {
  return {
    recordWebhookDelivery: jest.fn(),
    setWebhookDlqDepth: jest.fn(),
  };
}

const basePayload = () => ({ id: '123', url: 'http://test.com', data: {}, retryCount: 0 });

describe('WebhookService', () => {
  it('moves a repeatedly failing delivery to the DLQ after max retries (fake timers)', async () => {
    jest.useFakeTimers();
    try {
      mockedAxios.post.mockRejectedValue(new Error('Network Error'));

      const service = new WebhookService();
      const payload = basePayload();

      const sendOp = service.send(payload);

      for (let i = 0; i < 20; i += 1) {
        await jest.runOnlyPendingTimersAsync();
      }

      await sendOp;

      expect(service.getDLQ().length).toBe(1);
      expect(service.getDLQ()[0].id).toBe('123');
    } finally {
      jest.useRealTimers();
    }
  });

  describe('metrics instrumentation', () => {
    it('records success outcome on successful delivery', async () => {
      mockedAxios.post.mockResolvedValue({ status: 200 });
      const metrics = makeMetrics();
      const service = new WebhookService(metrics as unknown as MetricsServiceLike);

      await service.send(basePayload());

      expect(metrics.recordWebhookDelivery).toHaveBeenCalledWith('success');
    });

    it('records failure outcome on transient error (before max retries)', async () => {
      jest.useFakeTimers();
      try {
        mockedAxios.post.mockRejectedValue(new Error('timeout'));
        const metrics = makeMetrics();
        const service = new WebhookService(metrics as unknown as MetricsServiceLike);

        const sendOp = service.send({ ...basePayload(), retryCount: 0 });
        await jest.runOnlyPendingTimersAsync();
        await sendOp;

        expect(metrics.recordWebhookDelivery).toHaveBeenCalledWith('failure');
      } finally {
        jest.useRealTimers();
      }
    });

    it('records dlq outcome and sets DLQ depth when max retries exceeded', async () => {
      jest.useFakeTimers();
      try {
        mockedAxios.post.mockRejectedValue(new Error('Network Error'));
        const metrics = makeMetrics();
        const service = new WebhookService(metrics as unknown as MetricsServiceLike);

        const sendOp = service.send(basePayload());

        for (let i = 0; i < 20; i += 1) {
          await jest.runOnlyPendingTimersAsync();
        }
        await sendOp;

        expect(metrics.recordWebhookDelivery).toHaveBeenCalledWith('dlq');
        expect(metrics.setWebhookDlqDepth).toHaveBeenCalledWith(1);
      } finally {
        jest.useRealTimers();
      }
    });

    it('does not throw when no metrics service provided', async () => {
      mockedAxios.post.mockResolvedValue({ status: 200 });
      const service = new WebhookService();
      await expect(service.send(basePayload())).resolves.not.toThrow();
    });
  });
});
