/**
 * Mock Gateway driver — the sandbox default (SPEC section 4.3).
 *
 * Implements the full T03 driver seam with no real HTTP. It simulates the
 * SPEC 4.3 testing matrix on the `method` (unified token) the merchant uses:
 *
 *   | ends in 4242  → success           | returns `none` + succeeded
 *   | ends in 0002  → insufficient      | returns `none` + failed (retryable=false)
 *   | ends in 9999  → gateway timeout   | throws  GatewayError(processing_error)
 *   | ends in 3D01  → 3DS challenge     | returns `redirect` + requires_action
 *   | starts with QR → BenefitPay QR    | returns `qr` + requires_action (scan)
 *
 * Because the platform normalizes money to minor units + a currency exponent,
 * the mock honors the exact currency to prove exponent safety (BHD=3 fils).
 */
import type { GatewayDriver, TokenizeInput } from "./driver";
import type { CaptureResult, VoidResult } from "./driver";
import type {
  CaptureRequest,
  ChargeRequest,
  ChargeResult,
  MoneyInput,
  RefundRequest,
  RefundResult,
  RevokeRequest,
} from "./types";
import { GatewayError } from "./types";

/** Stripe-style test PANs: all in a known range; the last-4 / prefix decides. */
function classifyMethod(token: string): "success" | "decline" | "timeout" | "3ds" | "qr" {
  const t = token.toLowerCase();
  if (t.startsWith("qr_")) return "qr";
  if (t.endsWith("3d01")) return "3ds";
  if (t.endsWith("0002")) return "decline";
  if (t.endsWith("9999")) return "timeout";
  if (t.endsWith("4242")) return "success";
  // Unknown method: treat as success for forward-compat with future cards.
  return "success";
}

export class MockGatewayDriver implements GatewayDriver {
  readonly id = "mock";
  readonly label = "Mock Gateway (sandbox)";

  readonly capabilities = {
    supportedCurrencies: ["BHD", "USD", "SAR", "AED", "KWD", "QAR", "OMR"],
    supportedMethods: ["card", "qr"],
    supports3ds: true,
    supportsManualCapture: true,
    supportsTokenization: true,
  } as const;

  async createPayment(request: ChargeRequest, money: MoneyInput): Promise<ChargeResult> {
    // Simulated network latency keeps the test experience realistic.
    await new Promise((r) => setTimeout(r, 30));

    const method = request.method ?? "card_4242";
    const kind = classifyMethod(method);

    if (kind === "timeout") {
      throw new GatewayError("processing_error", "Simulated gateway timeout (card 9999).", {
        retryable: true,
        providerCode: "mock_timeout",
      });
    }

    if (kind === "decline") {
      throw new GatewayError("card_declined", "Simulated insufficient funds (card 0002).", {
        providerCode: "insufficient_funds",
      });
    }

    if (kind === "3ds") {
      // requires_action with a redirect to the mock 3DS challenge.
      return {
        status: "requires_action",
        providerReference: `mock_3ds_${money.amountMinor}_${money.currency}`,
        authorizedAmountMinor: 0,
        action: {
          kind: "redirect",
          url: `/mock/3ds/${encodeURIComponent(method)}`,
        },
        raw: { mock: true, scenario: "3ds" },
      };
    }

    if (kind === "qr") {
      // BenefitPay QR "Simulate Scan & Pay".
      return {
        status: "requires_action",
        providerReference: `mock_qr_${money.amountMinor}_${money.currency}`,
        authorizedAmountMinor: 0,
        action: {
          kind: "qr",
          code: `mock-fawri:${money.amountMinor}:${money.currency}`,
          mime: "image/svg+xml",
        },
        raw: { mock: true, scenario: "qr" },
      };
    }

    // Success path.
    return {
      status: "succeeded",
      providerReference: `mock_pay_${money.amountMinor}_${money.currency}`,
      authorizedAmountMinor: money.amountMinor,
      action: { kind: "none" },
      raw: { mock: true, scenario: "success" },
    };
  }

  async tokenize(input: TokenizeInput): Promise<{ token: string; raw: unknown }> {
    // Mock tokenize echoes the PAN's last-4 into the token so the createPayment
    // matrix can classify it — this is what lets 4242/0002/9999/3D01 work.
    const last4 = input.payload.pan.slice(-4);
    const token = `tok_mock_${last4}_${crypto.randomUUID().slice(0, 8)}`;
    return { token, raw: { mock: true, last4 } };
  }

  async capture(request: CaptureRequest, money: MoneyInput): Promise<CaptureResult> {
    return {
      providerReference: request.providerReference,
      status: "succeeded",
      capturedAmountMinor: money.amountMinor,
      raw: { mock: true, op: "capture" },
    };
  }

  async refund(request: RefundRequest, money: MoneyInput): Promise<RefundResult> {
    return {
      providerReference: request.providerReference,
      status: "succeeded",
      raw: { mock: true, op: "refund", amountMinor: money.amountMinor },
    };
  }

  async void(request: RevokeRequest): Promise<VoidResult> {
    return {
      providerReference: request.providerReference,
      status: "succeeded",
      raw: { mock: true, op: "void" },
    };
  }

  normalizeWebhook(raw: { body: string; headers: Record<string, string | undefined> }) {
    // The mock driver trusts its own environment; real drivers verify HMAC.
    const parsed = JSON.parse(raw.body) as { id?: string; reference?: string; type?: string };
    return {
      gatewayEventId: parsed.id ?? "mock_evt_unknown",
      providerReference: parsed.reference ?? "mock_ref_unknown",
      type: parsed.type === "refund" ? ("refund" as const) : ("payment" as const),
    };
  }
}
