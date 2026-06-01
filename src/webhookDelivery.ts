/**
 * @module webhookDelivery
 *
 * Outbound webhook delivery with per-provider circuit breakers.
 *
 * ## Circuit-breaker behaviour
 *
 * Each provider gets its own {@link CircuitBreaker} instance, keyed by the
 * sanitized provider label (e.g. `"stripe"`, `"github"`, `"generic"`).
 * The state machine follows the standard CLOSED → OPEN → HALF_OPEN → CLOSED
 * cycle:
 *
 * ```
 * CLOSED ──(failures ≥ threshold)──► OPEN
 * OPEN   ──(cooldown elapsed)    ──► HALF_OPEN
 * HALF_OPEN ──(probe succeeds)   ──► CLOSED
 * HALF_OPEN ──(probe fails)      ──► OPEN
 * ```
 *
 * While OPEN, `deliver()` **short-circuits to the DLQ** without making an
 * HTTP call, records `reason: 'circuit_open'` in the delivery counter, and
 * updates the `webhook_breaker_state` gauge.
 *
 * ## Retry / backoff coordination
 *
 * The circuit breaker counts *consecutive* failures at the delivery layer.
 * Retry backoff (exponential, with jitter) is applied by the queue layer
 * *before* calling `deliver()` again, so each call to `deliver()` represents
 * one real attempt.  The breaker and the retry policy therefore do not
 * double-count: the breaker trips when `failureThreshold` consecutive
 * *attempts* fail, regardless of how many retries the queue has scheduled.
 *
 * ## Security assumptions
 *
 * - `payload.url` is validated upstream (SSRF guard) before reaching this
 *   service; this module does not re-validate it to avoid duplicating policy.
 * - `payload.body` is treated as opaque; no PII is logged — only the error
 *   code is captured on failure.
 * - `webhookSecret` is never stored in plain text or returned in API
 *   responses; the DLQ layer handles redaction.
 * - Provider labels are sanitized to a finite allow-list to prevent metric
 *   cardinality explosion.
 * - Idempotency is enforced by the DLQ's SHA-256 dedupe key; duplicate
 *   circuit-open fast-paths for the same payload are silently deduplicated.
 */

import { Registry } from 'prom-client';
import {
  CircuitBreaker,
  CircuitBreakerOptions,
  CircuitOpenError,
  CircuitState,
} from './circuit-breaker';
import {
  BREAKER_STATE_VALUES,
  createWebhookMetrics,
  getLabelValues,
  Provider,
  PROVIDERS,
  WebhookMetrics,
} from './webhookMetrics';
import type { WebhookRetryConfig } from './appConfiguration';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Input payload for a single webhook delivery attempt. */
export interface DeliveryPayload {
  /** Raw provider name — will be sanitized to a finite allow-list. */
  provider: string;
  /** Target URL. Must have been SSRF-validated by the caller. */
  url: string;
  /** Opaque JSON body forwarded to the provider. */
  body: Record<string, unknown>;
}

/** Result returned by {@link WebhookDeliveryService.deliver}. */
export interface DeliveryResult {
  /** `true` only when the HTTP response was 2xx. */
  success: boolean;
  /** HTTP status code, if a response was received. */
  statusCode?: number;
  /** Wall-clock seconds spent on the attempt (0 for circuit-open fast-path). */
  durationSeconds: number;
  /**
   * `true` when the circuit was OPEN and the delivery was routed directly to
   * the DLQ without making an HTTP call.
   */
  circuitOpen?: boolean;
}

/**
 * Configuration for the per-provider circuit breakers.
 * All fields are optional; sensible defaults are applied.
 */
export interface WebhookCircuitBreakerConfig {
  /**
   * Consecutive failures before the circuit trips to OPEN.
   * @default 5
   */
  failureThreshold?: number;
  /**
   * Consecutive successes in HALF_OPEN before closing the circuit.
   * @default 1
   */
  successThreshold?: number;
  /**
   * Milliseconds to wait in OPEN before transitioning to HALF_OPEN.
   * Should be ≥ the maximum retry backoff delay to avoid the breaker
   * re-opening immediately on the first probe.
   * @default 60_000
   */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Sanitizes a raw provider string to a known finite value, preventing label
 * cardinality explosion in Prometheus metrics.
 *
 * @param raw - Arbitrary provider string from the caller.
 * @returns A value from the {@link PROVIDERS} allow-list, or `'generic'`.
 */
function sanitizeProvider(raw: string): Provider {
  const normalized = raw.toLowerCase() as Provider;
  return PROVIDERS.includes(normalized) ? normalized : 'generic';
}

/**
 * Maps a {@link CircuitState} to its numeric gauge value.
 *
 * @param state - Current circuit state.
 * @returns Numeric encoding for the `webhook_breaker_state` gauge.
 */
function stateToGaugeValue(state: CircuitState): number {
  return BREAKER_STATE_VALUES[state];
}

// ---------------------------------------------------------------------------
// WebhookDeliveryService
// ---------------------------------------------------------------------------

/**
 * Delivers outbound webhooks with per-provider circuit breakers.
 *
 * Instantiate once per application and reuse — the circuit breaker state is
 * held in memory on the instance.
 *
 * @example
 * ```ts
 * const service = new WebhookDeliveryService(registry, {
 *   failureThreshold: 5,
 *   timeoutMs: 60_000,
 * });
 *
 * const result = await service.deliver(payload, axiosHttpClient);
 * if (result.circuitOpen) {
 *   // delivery was fast-pathed to DLQ — no HTTP call was made
 * }
 * ```
 */
export class WebhookDeliveryService {
  private readonly metrics: WebhookMetrics;
  private readonly breakerOptions: CircuitBreakerOptions;
  /** Per-provider circuit breaker instances, keyed by sanitized provider name. */
  private readonly breakers = new Map<Provider, CircuitBreaker>();

  /**
   * @param registry       - Prometheus registry for metric registration.
   * @param breakerConfig  - Optional circuit-breaker thresholds/cooldown.
   */
  constructor(
    private readonly registry: Registry,
    breakerConfig: WebhookCircuitBreakerConfig = {},
  ) {
    this.metrics = createWebhookMetrics(registry);
    this.breakerOptions = {
      failureThreshold: breakerConfig.failureThreshold ?? 5,
      successThreshold: breakerConfig.successThreshold ?? 1,
      timeout: breakerConfig.timeoutMs ?? 60_000,
    };
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Attempts to deliver `payload` to its target URL.
   *
   * If the per-provider circuit breaker is **OPEN**, the call is short-circuited:
   * no HTTP request is made, the result has `circuitOpen: true`, and the caller
   * is responsible for routing the payload to the DLQ.
   *
   * @param payload    - Webhook delivery payload (provider, url, body).
   * @param httpClient - Injected HTTP transport; must resolve with `{ statusCode }`.
   * @returns          A {@link DeliveryResult} describing the outcome.
   *
   * @remarks
   * The `httpClient` parameter is injected rather than hard-coded so that tests
   * can supply a mock without patching module internals.  In production, pass
   * an Axios-based adapter that enforces a request timeout.
   */
  async deliver(
    payload: DeliveryPayload,
    httpClient: (url: string, body: Record<string, unknown>) => Promise<{ statusCode: number }>,
  ): Promise<DeliveryResult> {
    const provider = sanitizeProvider(payload.provider);
    const breaker = this.getOrCreateBreaker(provider);

    // Emit current breaker state before attempting delivery so dashboards
    // always have an up-to-date reading even when no delivery is in flight.
    this.emitBreakerState(provider, breaker);

    // ── Circuit-open fast-path ──────────────────────────────────────────────
    if (breaker.getState() === 'OPEN') {
      this.metrics.deliveryAttemptsTotal.inc({
        status: 'failure',
        provider,
        reason: 'circuit_open',
      });
      // Gauge already emitted above; emit again to capture any OPEN→HALF_OPEN
      // transition that getState() may have triggered internally.
      this.emitBreakerState(provider, breaker);
      return { success: false, durationSeconds: 0, circuitOpen: true };
    }

    // ── Normal delivery path ────────────────────────────────────────────────
    const endTimer = this.metrics.deliveryLatencySeconds.startTimer({ provider });

    // Retry loop: attempt up to maxAttempts times
    while (attemptNumber < this.retryConfig.maxAttempts) {
      const endTimer = this.metrics.deliveryLatencySeconds.startTimer({ provider });
      lastStatusCode = undefined;
      lastErrorType = undefined;

    try {
      // Wrap the HTTP call in the circuit breaker so failures are counted and
      // the breaker transitions correctly.  CircuitOpenError is re-thrown if
      // a concurrent probe is already in-flight (HALF_OPEN + probeInFlight).
      //
      // Non-2xx responses are treated as logical failures by throwing inside
      // the breaker's execute() callback — this ensures the breaker counts
      // them without a second execute() call (which would double-count in
      // HALF_OPEN and risk a premature re-open).
      const response = await breaker.execute(async () => {
        const res = await httpClient(payload.url, payload.body);
        if (res.statusCode < 200 || res.statusCode >= 300) {
          // Throw so the breaker records a failure; the error code lets
          // getLabelValues() map it to the correct reason label.
          throw Object.assign(
            new Error(`HTTP ${res.statusCode}`),
            { code: res.statusCode >= 500 ? '5xx_server_error' : '4xx_client_error', statusCode: res.statusCode },
          );
        }
        return res;
      });
      statusCode = response.statusCode;
    } catch (err: unknown) {
      if (err instanceof CircuitOpenError) {
        // A concurrent probe was in-flight; treat as circuit-open fast-path.
        const durationSeconds = endTimer({ status: 'failure' });
        this.metrics.deliveryAttemptsTotal.inc({
          status: 'failure',
          provider,
          reason: 'circuit_open',
        });
        this.emitBreakerState(provider, breaker);
        return { success: false, durationSeconds, circuitOpen: true };
      }
      // Recover the HTTP status code from the thrown error if present (non-2xx path).
      const errWithStatus = err as NodeJS.ErrnoException & { statusCode?: number };
      if (errWithStatus.statusCode !== undefined) {
        statusCode = errWithStatus.statusCode;
      } else {
        // Network-level error — extract only the error code, never raw messages.
        errorType = errWithStatus.code ?? 'unknown';
      }
    }

    const { status, reason } = getLabelValues(statusCode, errorType);
    const durationSeconds = endTimer({ status });

    this.metrics.deliveryAttemptsTotal.inc({ status, provider, reason });
    this.emitBreakerState(provider, breaker);

    return {
      success: false,
      durationSeconds: 0,
    };
  }

  /**
   * Returns the current {@link CircuitState} for a given provider.
   * Useful for health-check endpoints and admin dashboards.
   *
   * @param provider - Raw provider name (will be sanitized).
   */
  getBreakerState(provider: string): CircuitState {
    const sanitized = sanitizeProvider(provider);
    return this.getOrCreateBreaker(sanitized).getState();
  }

  /**
   * Force-resets the circuit breaker for a provider back to CLOSED.
   *
   * **Admin / test use only.** In production, protect any endpoint that calls
   * this behind an authenticated admin route.
   *
   * @param provider - Raw provider name (will be sanitized).
   */
  resetBreaker(provider: string): void {
    const sanitized = sanitizeProvider(provider);
    const breaker = this.breakers.get(sanitized);
    if (breaker) {
      breaker.reset();
      this.emitBreakerState(sanitized, breaker);
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Returns the existing {@link CircuitBreaker} for `provider`, or creates and
   * registers a new one with the configured thresholds.
   */
  private getOrCreateBreaker(provider: Provider): CircuitBreaker {
    if (!this.breakers.has(provider)) {
      this.breakers.set(
        provider,
        new CircuitBreaker({ name: `webhook-${provider}`, ...this.breakerOptions }),
      );
    }
    return this.breakers.get(provider)!;
  }

  /**
   * Updates the `webhook_breaker_state` gauge for `provider` to reflect the
   * breaker's current state.
   *
   * Called before and after every delivery attempt so the gauge is always
   * current, even when no delivery is in progress.
   */
  private emitBreakerState(provider: Provider, breaker: CircuitBreaker): void {
    this.metrics.webhookBreakerState.set(
      { provider },
      stateToGaugeValue(breaker.getState()),
    );
  }
}

// ---------------------------------------------------------------------------
// Inbound webhook HMAC verification (re-exported for webhook route handlers)
// ---------------------------------------------------------------------------

/**
 * @module webhookDelivery/signatureVerification
 *
 * Inbound webhook authenticity checks. Implementation lives in
 * {@link ./utils/webhook-signing.util | webhook-signing.util}; symbols are
 * re-exported here so consumers colocated with delivery/DLQ code import a
 * single module.
 *
 * @security
 * - Signatures are compared with `crypto.timingSafeEqual` on decoded digests.
 * - Failure messages are sanitized via {@link ./errors/safeErrors | safeErrors}.
 * - Secrets and raw signatures must never appear in logs or API responses.
 */
export {
  WEBHOOK_SIGNATURE_HEX_LENGTH,
  WEBHOOK_SIGNATURE_MAX_AGE_MS,
  WEBHOOK_VERIFICATION_CODES,
  constantTimeCompareHex,
  createWebhookSignature,
  generateSignature,
  normalizeSignatureHeader,
  verifySignature,
  verifyWebhookSignature,
} from './utils/webhook-signing.util';

export type {
  WebhookSignature,
  WebhookVerificationCode,
  WebhookVerificationResult,
} from './utils/webhook-signing.util';
