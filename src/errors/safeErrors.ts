/**
 * @module safeErrors
 * @description Safe, non-leaking error factories for webhook signature verification.
 *
 * All messages are intentionally vague to avoid oracle attacks — callers never
 * learn *why* verification failed (expired vs. replayed vs. bad signature).
 */

import { AppError } from './appError';

/** Returned when HMAC signature verification fails for any reason. */
export class WebhookSignatureError extends AppError {
  constructor() {
    super(401, 'webhook_signature_invalid', 'Webhook signature verification failed');
  }
}

/** Returned when the webhook timestamp is outside the tolerance window. */
export class WebhookTimestampError extends AppError {
  constructor() {
    super(401, 'webhook_timestamp_invalid', 'Webhook timestamp is outside the allowed window');
  }
}

/** Returned when a previously seen signature is replayed. */
export class WebhookReplayError extends AppError {
  constructor() {
    super(401, 'webhook_replay_detected', 'Webhook replay detected');
  }
}
