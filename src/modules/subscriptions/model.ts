/**
 * Subscriptions pillar DTOs (TypeBox schemas + derived types).
 *
 * T3 (T06 subscription engine): `price` (per_unit / metered / tiered, one
 * mechanism) + `subscription`/`subscription_item` + `usage_record` + the
 * period-close automation that rolls the cycle and produces the invoice via the
 * invoicing service.
 *
 * Money is minor-units `int` (`Money` / `CURRENCY_EXPONENT` — never float).
 * `price.unit_amount` is the per-unit RATE for per_unit/seat AND metered (the
 * design's "no unit_amount for metered" refers to no fixed per-seat charge; the
 * per-unit rate still lives here); tiers handle `tiered`.
 */
import { t } from "elysia";
import type { Static } from "typebox";

/** ISO-4217 currencies supported by the engine (matches shared/constants). */
export const Currency = t.Union([
  t.Literal("BHD"),
  t.Literal("USD"),
  t.Literal("SAR"),
  t.Literal("AED"),
  t.Literal("KWD"),
  t.Literal("QAR"),
  t.Literal("OMR"),
]);
export type Currency = Static<typeof Currency>;

export const BillingScheme = t.Union([
  t.Literal("per_unit"),
  t.Literal("metered"),
  t.Literal("tiered"),
]);
export type BillingScheme = Static<typeof BillingScheme>;

/** Recurrence schedule (D2): interval + interval_count — no raw cron in v1. */
export const PricePeriod = t.Object({
  interval: t.Union([t.Literal("day"), t.Literal("week"), t.Literal("month"), t.Literal("year")]),
  interval_count: t.Optional(t.Number({ minimum: 1, default: 1 })),
});
export type PricePeriod = Static<typeof PricePeriod>;

/** One tier bucket: `up_to` (cumulative ceiling) + flat and/or unit price. */
export const Tier = t.Object({
  up_to: t.Optional(t.Number({ minimum: 1 })),
  flat_amount: t.Optional(t.Number({ minimum: 0 })),
  unit_amount: t.Optional(t.Number({ minimum: 0 })),
});
export type Tier = Static<typeof Tier>;

export const TieredConfig = t.Object({
  mode: t.Union([t.Literal("graduated"), t.Literal("volume")]),
  tiers: t.Array(Tier, { minItems: 1 }),
});
export type TieredConfig = Static<typeof TieredConfig>;

/** Body for POST /v1/prices. */
export const CreatePrice = t.Object({
  nickname: t.Optional(t.String({ maxLength: 256 })),
  currency: Currency,
  billing_scheme: BillingScheme,
  /** Required for per_unit + metered (the per-unit rate); absent for tiered. */
  unit_amount: t.Optional(t.Number({ minimum: 0 })),
  /** Required when billing_scheme = tiered. */
  tiered: t.Optional(TieredConfig),
  period: PricePeriod,
  active: t.Optional(t.Boolean()),
  metadata: t.Optional(t.Record(t.String(), t.String(), { maxProperties: 20 })),
});
export type CreatePrice = Static<typeof CreatePrice>;

/** Body for PATCH /v1/prices/:id — partial, immutable billing_scheme/currency. */
export const UpdatePrice = t.Object({
  nickname: t.Optional(t.String({ maxLength: 256 })),
  unit_amount: t.Optional(t.Number({ minimum: 0 })),
  tiered: t.Optional(TieredConfig),
  period: t.Optional(PricePeriod),
  active: t.Optional(t.Boolean()),
  metadata: t.Optional(t.Record(t.String(), t.String(), { maxProperties: 20 })),
});
export type UpdatePrice = Static<typeof UpdatePrice>;

export const PriceResource = t.Object({
  id: t.String(),
  object: t.Literal("price"),
  nickname: t.Optional(t.String()),
  currency: Currency,
  billing_scheme: BillingScheme,
  unit_amount: t.Optional(t.Number()),
  tiered: t.Optional(TieredConfig),
  period: PricePeriod,
  active: t.Boolean(),
  metadata: t.Optional(t.Record(t.String(), t.String())),
  created: t.String(),
  environment: t.Union([t.Literal("test"), t.Literal("live")]),
});
export type PriceResource = Static<typeof PriceResource>;

/** POST /v1/subscriptions item input. */
export const SubscriptionItemInput = t.Object({
  price: t.String({ minLength: 1, maxLength: 128 }),
  quantity: t.Optional(t.Number({ minimum: 1, default: 1 })),
});
export type SubscriptionItemInput = Static<typeof SubscriptionItemInput>;

/** Body for POST /v1/subscriptions. */
export const CreateSubscription = t.Object({
  customer: t.String({ minLength: 1, maxLength: 128 }),
  items: t.Array(SubscriptionItemInput, { minItems: 1 }),
  trial_period_days: t.Optional(t.Number({ minimum: 1 })),
  collection_method: t.Optional(
    t.Union([t.Literal("send_invoice"), t.Literal("charge_automatically")]),
  ),
  billing_cycle_anchor: t.Optional(t.String()),
  metadata: t.Optional(t.Record(t.String(), t.String(), { maxProperties: 20 })),
});
export type CreateSubscription = Static<typeof CreateSubscription>;

export const SubscriptionItemResource = t.Object({
  id: t.String(),
  object: t.Literal("subscription_item"),
  price: t.String(),
  quantity: t.Number(),
  period_start: t.String(),
  period_end: t.String(),
});
export type SubscriptionItemResource = Static<typeof SubscriptionItemResource>;

export const SubscriptionResource = t.Object({
  id: t.String(),
  object: t.Literal("subscription"),
  customer: t.String(),
  status: t.Union([
    t.Literal("trialing"),
    t.Literal("active"),
    t.Literal("past_due"),
    t.Literal("incomplete"),
    t.Literal("canceled"),
  ]),
  collection_method: t.Union([t.Literal("send_invoice"), t.Literal("charge_automatically")]),
  billing_cycle_anchor: t.String(),
  current_period_start: t.String(),
  current_period_end: t.String(),
  trial_end: t.Optional(t.String()),
  cancel_at: t.Optional(t.String()),
  cancel_at_period_end: t.Boolean(),
  canceled_at: t.Optional(t.String()),
  items: t.Array(SubscriptionItemResource),
  metadata: t.Optional(t.Record(t.String(), t.String())),
  created: t.String(),
});
export type SubscriptionResource = Static<typeof SubscriptionResource>;

/** Body for PATCH /v1/subscriptions/:id (minimal per T3). */
export const UpdateSubscription = t.Object({
  metadata: t.Optional(t.Record(t.String(), t.String(), { maxProperties: 20 })),
  cancel_at_period_end: t.Optional(t.Boolean()),
});
export type UpdateSubscription = Static<typeof UpdateSubscription>;

/** Body for POST /v1/usage_records. */
export const CreateUsageRecord = t.Object({
  subscription_item: t.String({ minLength: 1, maxLength: 128 }),
  quantity: t.Number({ minimum: 1 }),
  recorded_at: t.Optional(t.String()),
});
export type CreateUsageRecord = Static<typeof CreateUsageRecord>;

export const UsageRecordResource = t.Object({
  id: t.String(),
  object: t.Literal("usage_record"),
  subscription_item: t.String(),
  quantity: t.Number(),
  recorded_at: t.String(),
});
export type UsageRecordResource = Static<typeof UsageRecordResource>;

/**
 * Body for POST /v1/subscriptions/:id/dunning/on_failed_charge — the durable
 * hook a failed recurring charge calls (T06 D10). `invoice_id` identifies the
 * OPEN cycle invoice to re-charge; `method` is the token to retry with (defaults
 * to the attempt's stored method on later retries).
 */
export const OnFailedCharge = t.Object({
  invoice_id: t.String({ minLength: 1 }),
  method: t.Optional(t.String()),
});
export type OnFailedCharge = Static<typeof OnFailedCharge>;

export const DunningState = t.Union([
  t.Literal("pending"),
  t.Literal("past_due"),
  t.Literal("canceled"),
]);
export type DunningState = Static<typeof DunningState>;

/** Dunning attempt resource returned by the dunning endpoints. */
export const DunningAttempt = t.Object({
  id: t.String(),
  subscription: t.String(),
  invoice: t.Optional(t.String()),
  method: t.Optional(t.String()),
  attempt: t.Number(),
  max_attempts: t.Number(),
  state: DunningState,
  due_at: t.String(),
});
export type DunningAttempt = Static<typeof DunningAttempt>;

/** Outcome of a single /dunning/run pass. */
export const DunningOutcome = t.Union([
  t.Literal("not_due"),
  t.Literal("succeeded"),
  t.Literal("retry_scheduled"),
  t.Literal("stopped"),
  t.Literal("requires_action"),
  t.Literal("canceled"),
]);
export type DunningOutcome = Static<typeof DunningOutcome>;

export const DunningRunResult = t.Object({
  subscription: SubscriptionResource,
  attempt: DunningAttempt,
  outcome: DunningOutcome,
});
export type DunningRunResult = Static<typeof DunningRunResult>;

/** Body for POST /v1/subscriptions/:id/dunning/on_failed_charge response. */
export const FailedChargeResult = t.Object({
  subscription: SubscriptionResource,
  attempt: DunningAttempt,
});
export type FailedChargeResult = Static<typeof FailedChargeResult>;

/** Body for POST /v1/subscriptions/:id/cancel — three cancel modes (D7). */
export const CancelSubscription = t.Object({
  mode: t.Union([t.Literal("immediate"), t.Literal("at_period_end"), t.Literal("at")]),
  /** Required when mode = "at": schedule cancellation at this datetime. */
  at: t.Optional(t.String()),
});
export type CancelSubscription = Static<typeof CancelSubscription>;

/** Body for POST /v1/subscriptions/:id/items/:item_id/quantity (D6 proration). */
export const ChangeItemQuantity = t.Object({
  quantity: t.Number({ minimum: 1, integer: true }),
});
export type ChangeItemQuantity = Static<typeof ChangeItemQuantity>;
