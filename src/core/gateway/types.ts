/**
 * Unified gateway abstraction — normalized types (Pillar 1).
 *
 * Every driver (mock, Tap, Stripe, Moyasar, …) speaks these payloads; the
 * per-gateway *differences* live inside each driver, not in the API layer.
 *
 * Design rules (T02/T03):
 *  - Money is always carried as minor units + an explicit `currency` whose
 *    exponent the middleware derives from CURRENCY_EXPONENT (BHD=3 fils).
 *    The abstraction NEVER hardcodes ×100.
 *  - A charge results in an `action` the caller must perform (redirect / QR /
 *    client secret / hosted page), or `none` when the outcome is terminal.
 *  - Gateway machine codes are normalized to a small closed set; every
 *    normalized error is retryable-or-not so the routing layer and dunning
 *    (T06) can decide failover/retry without knowing gateway internals.
 */
import type { Money } from "../../shared/constants";

/** Every token the platform answers a gateway with. */
export interface ChargeRequest {
  /** Minor units, exponent fixed by `currency`. */
  amountMinor: number;
  currency: string;
  /** Unified (cross-gateway) payment-method token produced by `tokenize`. */
  method?: string;
  /** Sandbox vs live — always set by the caller from the API-key prefix. */
  environment: "test" | "live";
  /** Capture model: `automatic` (sale) vs `manual` (pre-auth, capture later). */
  captureMode: "automatic" | "manual";
  description?: string;
  metadata?: Record<string, string>;
}

/** All the ways a gateway can hand control back to the caller. */
export type ChargeAction =
  | { kind: "redirect"; url: string }
  | { kind: "qr"; code: string; mime: "image/png" | "image/svg+xml" }
  | { kind: "client_secret"; clientSecret: string }
  | { kind: "hosted_page"; url: string }
  | { kind: "none" };

export type PaymentStatus = "succeeded" | "processing" | "requires_action" | "failed";

/** Normalized outcome of initiating (or confirming) a payment. */
export interface ChargeResult {
  /** Platform payment status the resource exposes. */
  status: PaymentStatus;
  /** Terminal outcome (matched to a gateway id like `gateway_...`). */
  providerReference?: string;
  /** First-capture amount actually authorized (0 if fully declined). */
  authorizedAmountMinor: number;
  action: ChargeAction;
  /**
   * Provider original payload — kept verbatim for audit + the raw webhook
   * normalizer (T07). Never the source of truth for decisions.
   */
  raw: unknown;
}

export interface CaptureRequest {
  providerReference: string;
  amountMinor?: number;
}

export interface RefundRequest {
  providerReference: string;
  amountMinor?: number;
  reason?: string;
}

export type RevokeRequest = { providerReference: string; amountMinor?: number };

export interface RefundResult {
  providerReference: string;
  status: "succeeded" | "pending" | "failed";
  raw: unknown;
}

/**
 * Normalized gateway error. `retryable` drives failover/routing and dunning:
 *  - true  → safe to retry (network blip, timeout, 5xx, processing)
 *  - false → deterministic decline (card declined, expired, invalid)
 */
export class GatewayError extends Error {
  readonly code: GatewayErrorCode;
  readonly retryable: boolean;
  readonly providerCode?: string;

  constructor(
    code: GatewayErrorCode,
    message: string,
    opts: { retryable?: boolean; providerCode?: string } = {},
  ) {
    super(message);
    this.name = "GatewayError";
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.providerCode = opts.providerCode;
  }
}

/** Closed set of normalized gateway failure codes. */
export type GatewayErrorCode =
  | "card_declined"
  | "insufficient_funds"
  | "expired_card"
  | "invalid_card"
  | "card_3ds_required" // returnable as requires_action, not an error
  | "gateway_timeout"
  | "gateway_unavailable"
  | "invalid_request"
  | "authentication_failed"
  | "rate_limited"
  | "amount_mismatch"
  | "processing_error";

export interface MoneyInput {
  amountMinor: number;
  currency: string;
}
export type MoneyLike = Money | MoneyInput;
