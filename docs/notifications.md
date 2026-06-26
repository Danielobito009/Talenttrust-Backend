# Notifications

This document describes the pluggable notification transports and retry/persistence semantics.

## Transports
- `NotificationTransport` is the pluggable interface implemented by providers.
- `ConsoleTransport` is the default local/dev fallback (default).
- `WebhookTransport` uses `WebhookService` to sign and retry deliveries to external HTTP endpoints.
- `SMTPTransport` sends emails via SMTP (requires nodemailer in production).
- `SESTransport` sends emails via AWS SES (requires @aws-sdk/client-ses in production).
- `SendGridTransport` sends emails via SendGrid (requires @sendgrid/mail in production).

## Configuration
Use environment variables to configure email transports:

| Variable | Description | Default |
|----------|-------------|---------|
| `EMAIL_PROVIDER` | Email provider to use (`console`, `smtp`, `ses`, `sendgrid`) | `console` |
| `SMTP_HOST` | SMTP server hostname | - |
| `SMTP_PORT` | SMTP server port | - |
| `SMTP_USER` | SMTP username (optional) | - |
| `SMTP_PASSWORD` | SMTP password (optional) | - |
| `SMTP_FROM` | From email address | - |
| `SMTP_SECURE` | Use TLS (true/false) | - |
| `AWS_ACCESS_KEY_ID` | AWS access key for SES (optional) | - |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key for SES (optional) | - |
| `AWS_REGION` | AWS region for SES (optional) | - |
| `SENDGRID_API_KEY` | SendGrid API key (optional) | - |

## Persistence
- Web/in-app notifications are persisted to the `notifications` table so UI clients can fetch missed messages after restarts.

## Failure semantics
- Transport methods return a `NotificationResult` with `success: boolean` and optional `message`.
- WebhookTransport reuses `WebhookService` which implements bounded retry and DLQ fallback.

## Security
- Email `to` addresses are validated with a strict sanity check and header-injection (CR/LF) is rejected.
- Web notifications validate `userId` for basic sanity; authorization (session matching) should be enforced by callers to prevent IDOR.
- Email addresses are redacted in logs to avoid leaking PII.
- Secrets and API keys are redacted in logs.
