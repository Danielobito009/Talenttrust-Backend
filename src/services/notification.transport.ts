import { EmailPayload, WebPayload } from '../types/notification.types';
import { WebhookService } from './webhook.service';
import { logger } from '../logger';
import { redactSecret } from '../utils/redact';

/**
 * Result returned by transports to indicate success/failure and optional message.
 */
export interface NotificationResult {
  success: boolean;
  message?: string;
}

/**
 * Pluggable transport interface for sending notifications.
 *
 * Implementations may support one or both methods depending on capabilities.
 */
export interface NotificationTransport {
  sendEmail?: (payload: EmailPayload) => Promise<NotificationResult>;
  sendWebNotification?: (payload: WebPayload) => Promise<NotificationResult>;
}

/**
 * Simple console transport used as the default fallback in tests and local dev.
 */
export const ConsoleTransport: NotificationTransport = {
  async sendEmail(payload: EmailPayload) {
    logger.info('[ConsoleTransport:Email] Sending', {
      toRedacted: redactEmail(payload.to),
    });
    return { success: true };
  },

  async sendWebNotification(payload: WebPayload) {
    logger.info('[ConsoleTransport:Web] Sending', {
      userIdRedacted: payload.userId,
    });
    return { success: true };
  },
};

/**
 * Webhook transport reuses the WebhookService to sign and retry deliveries.
 * The transport sends the provided payload to the configured `url`.
 */
export class WebhookTransport implements NotificationTransport {
  private webhookService: WebhookService;
  private url: string;
  private secret?: string;

  constructor(webhookService: WebhookService, url: string, secret?: string) {
    this.webhookService = webhookService;
    this.url = url;
    this.secret = secret;
  }

  async sendWebNotification(payload: WebPayload) {
    const id = `${payload.userId}:${Date.now()}`;
    try {
      await this.webhookService.send({
        id,
        url: this.url,
        data: payload,
        retryCount: 0,
        webhookSecret: this.secret,
      });
      return { success: true };
    } catch (err: unknown) {
      return { success: false, message: (err as Error).message };
    }
  }
}

/**
 * Redacts an email address for logging by replacing the local part.
 */
function redactEmail(email: string): string {
  if (!email) return '[REDACTED]';
  const atIndex = email.indexOf('@');
  if (atIndex === -1) return '[REDACTED]';
  return `[REDACTED]@${email.slice(atIndex + 1)}`;
}

/**
 * Guards against email header injection by checking for CRLF characters.
 */
function isSafeEmail(payload: EmailPayload): boolean {
  const unsafeChars = /[\r\n]/;
  return !(
    unsafeChars.test(payload.to) ||
    (payload.subject && unsafeChars.test(payload.subject)) ||
    (payload.body && unsafeChars.test(payload.body))
  );
}

/**
 * SMTP-based email transport using nodemailer (placeholder implementation).
 * In a real implementation, install nodemailer and use it here.
 */
export class SMTPTransport implements NotificationTransport {
  private config: {
    host: string;
    port: number;
    user?: string;
    password?: string;
    from: string;
    secure?: boolean;
  };

  constructor(config: {
    host: string;
    port: number;
    user?: string;
    password?: string;
    from: string;
    secure?: boolean;
  }) {
    this.config = config;
  }

  async sendEmail(payload: EmailPayload): Promise<NotificationResult> {
    logger.debug('[SMTPTransport] Preparing email', {
      toRedacted: redactEmail(payload.to),
      fromRedacted: redactEmail(this.config.from),
    });

    if (!isSafeEmail(payload)) {
      logger.warn('[SMTPTransport] Rejected email with unsafe characters (header injection attempt)');
      return { success: false, message: 'Unsafe email payload' };
    }

    try {
      // TODO: In production, install and use nodemailer here
      // import nodemailer from 'nodemailer';
      // const transporter = nodemailer.createTransport({...});
      // await transporter.sendMail({
      //   from: this.config.from,
      //   to: payload.to,
      //   subject: payload.subject,
      //   text: payload.body,
      // });
      
      logger.info('[SMTPTransport] Sending email (placeholder)', {
        toRedacted: redactEmail(payload.to),
      });

      return { success: true };
    } catch (err: unknown) {
      logger.error('[SMTPTransport] Failed to send email', {
        err,
        toRedacted: redactEmail(payload.to),
      });
      return { success: false, message: (err as Error).message };
    }
  }
}

/**
 * AWS SES email transport (placeholder implementation).
 */
export class SESTransport implements NotificationTransport {
  private config: {
    accessKeyId?: string;
    secretAccessKey?: string;
    region?: string;
    from: string;
  };

  constructor(config: {
    accessKeyId?: string;
    secretAccessKey?: string;
    region?: string;
    from: string;
  }) {
    this.config = config;
  }

  async sendEmail(payload: EmailPayload): Promise<NotificationResult> {
    logger.debug('[SESTransport] Preparing email', {
      toRedacted: redactEmail(payload.to),
      fromRedacted: redactEmail(this.config.from),
      region: this.config.region,
    });

    if (!isSafeEmail(payload)) {
      logger.warn('[SESTransport] Rejected email with unsafe characters (header injection attempt)');
      return { success: false, message: 'Unsafe email payload' };
    }

    try {
      // TODO: In production, install and use @aws-sdk/client-ses
      // import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
      // const client = new SESClient({...});
      // await client.send(new SendEmailCommand({...}));
      
      logger.info('[SESTransport] Sending email (placeholder)', {
        toRedacted: redactEmail(payload.to),
      });

      return { success: true };
    } catch (err: unknown) {
      logger.error('[SESTransport] Failed to send email', {
        err,
        toRedacted: redactEmail(payload.to),
      });
      return { success: false, message: (err as Error).message };
    }
  }
}

/**
 * SendGrid email transport (placeholder implementation).
 */
export class SendGridTransport implements NotificationTransport {
  private config: {
    apiKey?: string;
    from: string;
  };

  constructor(config: {
    apiKey?: string;
    from: string;
  }) {
    this.config = config;
  }

  async sendEmail(payload: EmailPayload): Promise<NotificationResult> {
    logger.debug('[SendGridTransport] Preparing email', {
      toRedacted: redactEmail(payload.to),
      fromRedacted: redactEmail(this.config.from),
      apiKeyRedacted: redactSecret(this.config.apiKey),
    });

    if (!isSafeEmail(payload)) {
      logger.warn('[SendGridTransport] Rejected email with unsafe characters (header injection attempt)');
      return { success: false, message: 'Unsafe email payload' };
    }

    try {
      // TODO: In production, install and use @sendgrid/mail
      // import sgMail from '@sendgrid/mail';
      // sgMail.setApiKey(this.config.apiKey!);
      // await sgMail.send({...});
      
      logger.info('[SendGridTransport] Sending email (placeholder)', {
        toRedacted: redactEmail(payload.to),
      });

      return { success: true };
    } catch (err: unknown) {
      logger.error('[SendGridTransport] Failed to send email', {
        err,
        toRedacted: redactEmail(payload.to),
      });
      return { success: false, message: (err as Error).message };
    }
  }
}
