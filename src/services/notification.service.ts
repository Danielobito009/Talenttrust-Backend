import { KeyEscrowEvent, EmailPayload, WebPayload } from '../types/notification.types';
import { NotificationTransport, ConsoleTransport, NotificationResult, SMTPTransport, SESTransport, SendGridTransport } from './notification.transport';
import { NotificationRepository } from '../repositories/notificationRepository';
import { getDb } from '../db/database';
import { validateEnv } from '../config/env.schema';
import { logger } from '../logger';

/**
 * @title NotificationService
 * @notice Service responsible for dispatching email and web push notifications.
 * @dev Transport layers are pluggable via `NotificationTransport`. Web notifications
 * are persisted using `NotificationRepository` so they survive restarts. Methods
 * return typed results to allow callers to react to partial failures.
 */
export class NotificationService {
  private emailTransport: NotificationTransport;
  private webTransport: NotificationTransport;
  private repo: NotificationRepository;

  /**
   * Creates an email transport based on the environment configuration.
   */
  private static createEmailTransport(): NotificationTransport {
    const env = validateEnv();

    if (env.EMAIL_PROVIDER === 'smtp') {
      if (!env.SMTP_HOST || !env.SMTP_PORT || !env.SMTP_FROM) {
        logger.warn('[NotificationService] SMTP configuration incomplete, falling back to console');
        return ConsoleTransport;
      }
      return new SMTPTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        user: env.SMTP_USER,
        password: env.SMTP_PASSWORD,
        from: env.SMTP_FROM,
        secure: env.SMTP_SECURE,
      });
    } else if (env.EMAIL_PROVIDER === 'ses') {
      if (!env.SMTP_FROM) {
        logger.warn('[NotificationService] SES configuration incomplete, falling back to console');
        return ConsoleTransport;
      }
      return new SESTransport({
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        region: env.AWS_REGION,
        from: env.SMTP_FROM,
      });
    } else if (env.EMAIL_PROVIDER === 'sendgrid') {
      if (!env.SMTP_FROM) {
        logger.warn('[NotificationService] SendGrid configuration incomplete, falling back to console');
        return ConsoleTransport;
      }
      return new SendGridTransport({
        apiKey: env.SENDGRID_API_KEY,
        from: env.SMTP_FROM,
      });
    }
    return ConsoleTransport;
  }

  constructor(options?: {
    emailTransport?: NotificationTransport;
    webTransport?: NotificationTransport;
    repo?: NotificationRepository;
  }) {
    this.emailTransport = options?.emailTransport ?? NotificationService.createEmailTransport();
    this.webTransport = options?.webTransport ?? ConsoleTransport;
    this.repo = options?.repo ?? new NotificationRepository(getDb(process.env['DB_PATH'] ?? ':memory:'));
  }

  private isValidEmail(address: string): boolean {
    if (!address) return false;
    // Basic sanity check + header injection protection (no CR/LF)
    if (/[\r\n]/.test(address)) return false;
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(address);
  }

  /**
   * Sends an email notification to the specified recipient.
   * Returns a structured result instead of a bare boolean.
   */
  public async sendEmail(to: string, event: KeyEscrowEvent, data?: any): Promise<NotificationResult> {
    try {
      if (!this.isValidEmail(to)) {
        logger.warn('[NotificationService:Email] Invalid email address');
        throw new Error('Invalid email address');
      }

      const payload: EmailPayload = {
        to,
        subject: `Notification: ${event}`,
        body: `Event ${event} has occurred with data: ${JSON.stringify(data || {})}`,
      };

      if (this.emailTransport.sendEmail) {
        const res = await this.emailTransport.sendEmail(payload);
        if (!res.success) {
          logger.error('[NotificationService:Email] Transport failed', {
            toRedacted: `${to.slice(0, 2)}***@${to.split('@')[1]}`,
            message: res.message,
          });
        }
        return res;
      }

      // Fallback behaviour
      logger.info('[NotificationService:Email] No email transport configured, using console', {
        toRedacted: `${to.slice(0, 2)}***@${to.split('@')[1]}`,
      });
      return { success: true };
    } catch (error) {
      logger.error('[NotificationService:Email] Failed to send email', {
        event,
        err: error,
      });
      return { success: false, message: (error as Error).message };
    }
  }

  /**
   * @notice Sends a web push/in-app notification to the specified user.
   * @dev In production, this would persist to a database or use WebSockets/Firebase Push.
   * Security constraints: The `userId` must be authorized against the active session
   * to prevent IDOR vulnerabilities (one user pushing notifications to another).
   * 
   * @param userId The unique identifier of the target user.
   * @param event The Key Escrow event triggering this notification.
   * @param data Optional context data for the UI payload.
   * @return A boolean indicating whether the notification was dispatched successfully.
   */
  /**
   * Sends a web/in-app notification and persists it so UI consumers can fetch
   * missed notifications after restarts. Returns a structured result.
   */
  public async sendWebNotification(userId: string, event: KeyEscrowEvent, data?: any): Promise<NotificationResult> {
    try {
      if (!userId || /[\r\n]/.test(userId)) {
        logger.warn('[NotificationService:Web] Invalid user ID');
        throw new Error('Invalid user ID');
      }

      const payload: WebPayload = {
        userId,
        title: `Alert: ${event}`,
        message: `Details: ${JSON.stringify(data || {})}`,
      };

      // Persist so the UI can read past notifications
      try {
        this.repo.saveWebNotification(payload.userId, payload.title, payload.message);
      } catch (err: unknown) {
        logger.error('[NotificationService:Web] Failed to persist web notification', {
          err,
        });
      }

      if (this.webTransport.sendWebNotification) {
        const res = await this.webTransport.sendWebNotification(payload);
        if (!res.success) {
          logger.error('[NotificationService:Web] Transport failed', {
            userId,
            message: res.message,
          });
        }
        return res;
      }

      logger.info('[NotificationService:Web] No web transport configured, using console', {
        userId,
      });
      return { success: true };
    } catch (error) {
      logger.error('[NotificationService:Web] Failed to send web alert', {
        event,
        err: error,
      });
      return { success: false, message: (error as Error).message };
    }
  }
}

export const notificationService = new NotificationService();
