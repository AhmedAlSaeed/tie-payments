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
  description: t.Optional(t.String({ maxLength: 256 })),
  metadata: t.Optional(t.Record(t.String(), t.String(), { maxProperties: 20 })),
});
export type CreatePayment = Static<typeof CreatePayment>;

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
  created: t.String(),
  environment: t.Union([t.Literal("test"), t.Literal("live")]),
  idempotencyKey: t.Optional(t.String()),
});
export type PaymentResource = Static<typeof PaymentResource>;
