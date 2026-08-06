/**
 * Webhooks pillar DTOs (TypeBox schemas + derived types) and the Stripe v1
 * canonical envelope builder.
 *
 * The envelope (T07 D7) is `{ id, type, api_version, created_at, livemode,
 * account, data: { object_type, object_id, object } }` — the same shape the
 * webhook delivery drainer POSTs to merchant endpoints. Building it here keeps
 * the query handlers and the drainer reading from one source of truth.
 */
import { t } from "elysia";
import type { Static } from "typebox";

export const API_VERSION = "2026-08-01";

/** Publishable shape of a webhook_endpoint (reads; secret is masked = omitted). */
export const WebhookEndpointResource = t.Object({
  id: t.String(),
  object: t.Literal("webhook_endpoint"),
  url: t.String(),
  events: t.Array(t.String()),
  enabled: t.Boolean(),
  max_attempts: t.Number(),
  created: t.String(),
});
export type WebhookEndpointResource = Static<typeof WebhookEndpointResource>;

/** Create response — the plaintext secret is returned exactly once. */
export const WebhookEndpointCreated = t.Intersect([
  WebhookEndpointResource,
  t.Object({ secret: t.String() }),
]);
export type WebhookEndpointCreated = Static<typeof WebhookEndpointCreated>;

export const CreateWebhookEndpoint = t.Object({
  url: t.String({ maxLength: 2048 }),
  events: t.Array(t.String(), { minItems: 1 }),
  enabled: t.Optional(t.Boolean()),
  max_attempts: t.Optional(t.Number({ minimum: 1, maximum: 10 })),
});
export type CreateWebhookEndpoint = Static<typeof CreateWebhookEndpoint>;

/** PATCH body — every field optional (partial update). */
export const UpdateWebhookEndpoint = t.Object({
  url: t.Optional(t.String({ maxLength: 2048 })),
  events: t.Optional(t.Array(t.String(), { minItems: 1 })),
  enabled: t.Optional(t.Boolean()),
  max_attempts: t.Optional(t.Number({ minimum: 1, maximum: 10 })),
});
export type UpdateWebhookEndpoint = Static<typeof UpdateWebhookEndpoint>;

/** Stripe v1 event envelope as exposed by `GET /v1/events`. */
export const StripeV1Event = t.Object({
  id: t.String(),
  type: t.String(),
  api_version: t.String(),
  created_at: t.String(),
  livemode: t.Boolean(),
  account: t.String(),
  data: t.Object({
    object_type: t.String(),
    object_id: t.String(),
    object: t.Any(),
  }),
});
export type StripeV1Event = Static<typeof StripeV1Event>;

/** Row shape of an `outbox_event` read back from SurrealDB. */
export interface OutboxEventRow {
  id: string;
  merchant: string;
  environment: "test" | "live";
  type: string;
  object_type: string;
  object_id: string;
  object: Record<string, unknown>;
  created_at: Date | string;
}

const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : String(d));

/**
 * Build the Stripe v1 delivery/read envelope from a stored outbox row.
 * `object` is the persisted full snapshot — never recomputed at read/replay time
 * (T07 D8: replay re-sends the stored envelope, no aggregate re-computation).
 */
export function toStripeEvent(row: OutboxEventRow, account: string): StripeV1Event {
  return {
    id: row.id.replace(/^outbox_event:/, ""),
    type: row.type,
    api_version: API_VERSION,
    created_at: iso(row.created_at),
    livemode: row.environment === "live",
    account,
    data: {
      object_type: row.object_type,
      object_id: row.object_id,
      object: row.object ?? {},
    },
  };
}
