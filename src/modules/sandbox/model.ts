/**
 * Sandbox module DTOs (TypeBox schemas + derived types).
 *
 * Currencies mirror the platform `Money` set; the exponent is carried by the
 * currency, never hardcoded. The `method` here deliberately accepts any token
 * (`tok_mock_*` for the card matrix AND `qr_*` for the BenefitPay QR) unlike
 * `CreatePayment`'s `^tok_`-only pattern, so the mock 4.3 matrix — including
 * `qr_...` — can be exercised through `test_pay`.
 */
import { t } from "elysia";
import type { Static } from "typebox";

export const SandboxTestPayBody = t.Object({
  amountMinor: t.Number({ minimum: 1 }),
  currency: t.Union([
    t.Literal("BHD"),
    t.Literal("USD"),
    t.Literal("SAR"),
    t.Literal("AED"),
    t.Literal("KWD"),
    t.Literal("QAR"),
    t.Literal("OMR"),
  ]),
  /** Mock matrix trigger: `tok_mock_4242|0002|9999|3d01` or `qr_*`. */
  method: t.Optional(t.String({ minLength: 3, maxLength: 64 })),
  description: t.Optional(t.String({ maxLength: 256 })),
  metadata: t.Optional(t.Record(t.String(), t.String(), { maxProperties: 20 })),
});
export type SandboxTestPayBody = Static<typeof SandboxTestPayBody>;

/** Complete a mock QR payment (`qr_`-method) through the real inbound path. */
export const QrCompleteBody = t.Object({
  payment_id: t.String({ minLength: 4, maxLength: 128 }),
});
export type QrCompleteBody = Static<typeof QrCompleteBody>;

/** Query params the guarded mock 3DS challenge page accepts. */
export const Mock3dsQuery = t.Object({
  token: t.Optional(t.String({ minLength: 3, maxLength: 128 })),
  amount: t.Optional(t.Number({ minimum: 1 })),
  currency: t.Optional(
    t.Union([
      t.Literal("BHD"),
      t.Literal("USD"),
      t.Literal("SAR"),
      t.Literal("AED"),
      t.Literal("KWD"),
      t.Literal("QAR"),
      t.Literal("OMR"),
    ]),
  ),
  payment: t.Optional(t.String({ minLength: 4, maxLength: 128 })),
});
export type Mock3dsQuery = Static<typeof Mock3dsQuery>;

/** JSON body the /mock/3ds/confirm handler accepts (from the challenge page). */
export const Mock3dsConfirmBody = t.Object({
  payment_id: t.Optional(t.String({ minLength: 4, maxLength: 128 })),
  token: t.Optional(t.String({ minLength: 3, maxLength: 128 })),
  amount: t.Optional(t.Number({ minimum: 1 })),
  currency: t.Optional(t.String({ minLength: 3, maxLength: 8 })),
});
export type Mock3dsConfirmBody = Static<typeof Mock3dsConfirmBody>;

/**
 * `GET /v1/sandbox/onboarding` payload.
 *
 * `test_keys` carries RAW secrets on the merchant's first-ever read
 * (`secrets_shown: false`) and masked prefixes thereafter. Raw secrets are
 * never persisted — they surface only in the one-time provisioning read.
 */
export const OnboardingResource = t.Object({
  merchant_id: t.String(),
  environment: t.Literal("test"),
  test_keys: t.Object({
    sk_test: t.String(),
    pk_test: t.String(),
  }),
  /** `false` on the first read (raw secrets shown); `true` once masked. */
  secrets_shown: t.Boolean(),
  snippet: t.String(),
});
export type OnboardingResource = Static<typeof OnboardingResource>;
