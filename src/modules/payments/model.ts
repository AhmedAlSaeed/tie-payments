/** Payments pillar DTOs (TypeBox schemas + derived types). */
import { t } from "elysia";
import type { Static } from "typebox";

export const CreatePayment = t.Object({
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
  /** Unified payment-method token (`tok_…`); sandbox defaults to mock's 4242. */
  method: t.Optional(t.String({ pattern: "^tok_" })),
  description: t.Optional(t.String({ maxLength: 256 })),
  metadata: t.Optional(t.Record(t.String(), t.String(), { maxProperties: 20 })),
});
export type CreatePayment = Static<typeof CreatePayment>;

export const PaymentAction = t.Union([
  t.Object({ kind: t.Literal("redirect"), url: t.String() }),
  t.Object({ kind: t.Literal("qr"), code: t.String(), mime: t.String() }),
  t.Object({ kind: t.Literal("client_secret"), clientSecret: t.String() }),
  t.Object({ kind: t.Literal("hosted_page"), url: t.String() }),
  t.Object({ kind: t.Literal("none") }),
]);
export type PaymentAction = Static<typeof PaymentAction>;

export const PaymentResource = t.Object({
  id: t.String(),
  object: t.Literal("payment"),
  status: t.Union([
    t.Literal("requires_action"),
    t.Literal("processing"),
    t.Literal("succeeded"),
    t.Literal("failed"),
    t.Literal("refunded"),
  ]),
  amountMinor: t.Number(),
  currency: t.String(),
  action: t.Optional(PaymentAction),
  providerReference: t.Optional(t.String()),
  created: t.String(),
  environment: t.Union([t.Literal("test"), t.Literal("live")]),
  idempotencyKey: t.Optional(t.String()),
});
export type PaymentResource = Static<typeof PaymentResource>;
