/**
 * Gateway driver contract (Pillar 1 seam).
 *
 * A `GatewayDriver` is one normalized adapter to a single PSP (Tap, Stripe,
 * Moyasar, mock, …) implementing the T02 abstraction seams:
 *   ① createPayment → action     (redirect / QR / client_secret / hosted_page)
 *   ② tokenize (client-side)     (publishable-key hosted fields → unified token)
 *   ③ capture / refund / void
 *   ④ normalizeWebhook           (raw gateway event → platform event)
 *
 * Drivers are injected via a small registry (see `registry.ts`) so the
 * payment/invoice modules depend on ports here — never on a driver directly.
 * This is the seam `PaymentService.deps.insert`-style wiring plugs into.
 */
import type {
  CaptureRequest,
  ChargeRequest,
  ChargeResult,
  GatewayErrorCode,
  MoneyInput,
  RefundRequest,
  RefundResult,
  RevokeRequest,
} from "./types";

export interface CaptureResult {
  providerReference: string;
  status: "succeeded" | "pending" | "failed";
  capturedAmountMinor: number;
  raw: unknown;
}

export interface VoidResult {
  providerReference: string;
  status: "succeeded" | "failed";
  raw: unknown;
}

/**
 * A traffic-light, gateway-agnostic health signal. Not a network ping —
 * it is the gateway's *declared capability* so routing (T03-route) and the
 * sandbox mock can reason about availability without real HTTP.
 */
export interface GatewayCapabilities {
  supportedCurrencies: readonly string[];
  supportedMethods: ReadonlyArray<"card" | "app" | "qr" | "wallet">;
  supports3ds: boolean;
  supportsManualCapture: boolean;
  supportsTokenization: boolean;
}

/** All methods a driver MUST implement to be usable in v1. */
export interface GatewayDriver {
  /** Stable driver id, e.g. `tap`, `stripe`, `moyasar`, `mock`. */
  readonly id: string;

  readonly capabilities: GatewayCapabilities;

  /**
   * Create a payment. Returns a `ChargeResult` whose `action` tells the
   * caller how to continue (redirect, QR, client_secret, or hosted_page).
   * Throws `GatewayError` on failure (normalized codes, `retryable` flags).
   */
  createPayment(request: ChargeRequest, money: MoneyInput): Promise<ChargeResult>;

  /** Create a client-side token and return a cross-gateway unified token id. */
  tokenize?(input: TokenizeInput): Promise<{ token: string; raw: unknown }>;

  /** Capture an authorization (for `captureMode: manual`). */
  capture?(request: CaptureRequest, money: MoneyInput): Promise<CaptureResult>;

  /** Refund (full or partial) a captured charge. */
  refund?(request: RefundRequest, money: MoneyInput): Promise<RefundResult>;

  /** Void / cancel an uncaptured authorization. */
  void?(request: RevokeRequest): Promise<VoidResult>;

  /**
   * Normalize a raw gateway webhook into a platform event. Implementations
   * MUST verify the gateway signature (raw-body HMAC / in-payload HMAC) and
   * return the provider reference; callers re-key on it for idempotency.
   */
  normalizeWebhook?(raw: { body: string; headers: Record<string, string | undefined> }): {
    gatewayEventId: string;
    providerReference: string;
    type: "payment" | "refund";
  };

  /**
   * Human label for logs / admin. Prefer a constant, not DNS / config.
   */
  readonly label: string;
}

/** Input to the optional client-side tokenize seam. */
export interface TokenizeInput {
  /** Publishable-key-only environment flag (client ops never use secret). */
  environment: "test" | "live";
  /** The payment-type token type: `card` for card number+exp+cvc. */
  type: "card";
  /** Data is a server-verified PAN/token — never raw PAN in logs. */
  payload: { pan: string; expMonth: number; expYear: number; cvc?: string };
  /** Metadata to stamp onto the unified token (customer id, etc.). */
  metadata?: Record<string, string>;
}

/** Maps a GatewayErrorCode down to a retryable judgment if a driver omits it. */
export function isRetryableCode(code: GatewayErrorCode): boolean {
  return (
    code === "gateway_timeout" ||
    code === "gateway_unavailable" ||
    code === "rate_limited" ||
    code === "processing_error"
  );
}
