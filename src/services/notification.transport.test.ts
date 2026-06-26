import { ConsoleTransport, SMTPTransport, SESTransport, SendGridTransport } from './notification.transport';
import { setWriteRecordImpl } from '../logger';
import { EmailPayload } from '../types/notification.types';

describe('Notification Transports', () => {
  const testPayload: EmailPayload = {
    to: 'test@example.com',
    subject: 'Test Subject',
    body: 'Test Body',
  };

  let logRecords: any[] = [];

  beforeEach(() => {
    logRecords = [];
    setWriteRecordImpl((record: any) => logRecords.push(record));
  });

  afterEach(() => {
    setWriteRecordImpl(() => {});
  });

  describe('ConsoleTransport', () => {
    it('should send email and log redacted address', async () => {
      const result = await ConsoleTransport.sendEmail!(testPayload);
      expect(result.success).toBe(true);
      expect(logRecords.some(r => r.message.includes('[ConsoleTransport:Email] Sending'))).toBe(true);
    });
  });

  describe('SMTPTransport', () => {
    const transport = new SMTPTransport({
      host: 'smtp.example.com',
      port: 587,
      user: 'user',
      password: 'pass',
      from: 'noreply@example.com',
    });

    it('should send email successfully', async () => {
      const result = await transport.sendEmail!(testPayload);
      expect(result.success).toBe(true);
    });

    it('should reject emails with header injection attempts', async () => {
      const badPayload: EmailPayload = {
        ...testPayload,
        to: 'test@example.com\r\nBcc: spam@example.com',
      };
      const result = await transport.sendEmail!(badPayload);
      expect(result.success).toBe(false);
      expect(result.message).toBe('Unsafe email payload');
    });
  });

  describe('SESTransport', () => {
    const transport = new SESTransport({
      accessKeyId: 'AKIAxxx',
      secretAccessKey: 'secret',
      region: 'us-east-1',
      from: 'noreply@example.com',
    });

    it('should send email successfully', async () => {
      const result = await transport.sendEmail!(testPayload);
      expect(result.success).toBe(true);
    });
  });

  describe('SendGridTransport', () => {
    const transport = new SendGridTransport({
      apiKey: 'SG.xxx',
      from: 'noreply@example.com',
    });

    it('should send email successfully', async () => {
      const result = await transport.sendEmail!(testPayload);
      expect(result.success).toBe(true);
    });
  });
});
