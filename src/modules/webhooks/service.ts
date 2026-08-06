/**
 * Webhooks service — business logic (Elysia-free).
 *
 * Owns: webhook_endpoint CRUD (secret returned once, masked thereafter),
 * canonical event + Stripe-v1-envelope reads, the inbound gateway-webhook dedup
 * + canonical emit path, and the redeliver path. Delivery dispatch is delegated
 * to the shared `attemptDelivery` in drainer.ts.
 */
import type { Surreal } from "surrealdb";
import { defaultRegistry } from "../../core/gateway";
import { problem } from "../../core/errors";
import type { MerchantContext } from "../../core/context";
import { attemptDelivery } from "./drainer";
import { toStripeEvent, type StripeV1Event, type WebhookEndpointResource } from "./model";
import { WebhooksRepository, type EndpointRow, type Scope } from "./repository";

const iso = (d: Date | string): string => (d instanceof Date ? d.toISOString() : String(d));

function scopeOf(ctx: MerchantContext): Scope {
  return { merchantId: ctx.merchantId, environment: ctx.environment };
}

function toResource(row: EndpointRow): WebhookEndpointResource {
  return {
    id: row.id,
    object: "webhook_endpoint",
    url: row.url,
    events: row.events,
    enabled: row.enabled,
    max_attempts: row.max_attempts,
    created: iso(row.created_at),
  };
}

export class WebhooksService {
  constructor(
    private readonly db: Surreal,
    private readonly repo = new WebhooksRepository(db),
  ) {}

  // ---------------------------------------------------------------------------
  // webhook_endpoint CRUD
  // ---------------------------------------------------------------------------

  async createEndpoint(
    ctx: MerchantContext,
    body: { url: string; events: string[]; enabled?: boolean; max_attempts?: number },
  ): Promise<WebhookEndpointResource & { secret: string }> {
    const secret = `whsec_${crypto.randomUUID().replace(/-/g, "")}`;
    const row: EndpointRow = {
      id: `wh_${crypto.randomUUID()}`,
      url: body.url,
      secret,
      enabled: body.enabled ?? true,
      events: body.events,
      max_attempts: body.max_attempts ?? 3,
      created_at: new Date(),
    };
    await this.repo.createEndpoint({
      id: row.id,
      scope: scopeOf(ctx),
      url: row.url,
      secret,
      enabled: row.enabled,
      events: row.events,
      maxAttempts: row.max_attempts,
    });
    // Secret is held on the returned resource ONLY at creation time; every
    // read path (`toResource`) omits it, so reads never leak the secret.
    return { ...toResource(row), secret };
  }

  async listEndpoints(ctx: MerchantContext): Promise<WebhookEndpointResource[]> {
    return (await this.repo.listEndpoints(scopeOf(ctx))).map(toResource);
  }

  async getEndpoint(ctx: MerchantContext, id: string): Promise<WebhookEndpointResource> {
    const row = await this.repo.findEndpoint(scopeOf(ctx), id);
    if (!row) throw problem("resource_not_found", "Webhook endpoint not found.");
    return toResource(row);
  }

  async patchEndpoint(
    ctx: MerchantContext,
    id: string,
    patch: Partial<Pick<EndpointRow, "url" | "enabled" | "events" | "max_attempts">>,
  ): Promise<WebhookEndpointResource> {
    if (patch.events !== undefined && patch.events.length === 0) {
      throw problem("validation_error", "events must contain at least one event type.");
    }
    const existing = await this.repo.findEndpoint(scopeOf(ctx), id);
    if (!existing) throw problem("resource_not_found", "Webhook endpoint not found.");
    await this.repo.updateEndpoint(scopeOf(ctx), id, patch);
    const updated = await this.repo.findEndpoint(scopeOf(ctx), id);
    if (!updated) throw problem("resource_not_found", "Webhook endpoint not found.");
    return toResource(updated);
  }

  async deleteEndpoint(ctx: MerchantContext, id: string): Promise<{ id: string }> {
    const ok = await this.repo.deleteEndpoint(scopeOf(ctx), id);
    if (!ok) throw problem("resource_not_found", "Webhook endpoint not found.");
    return { id };
  }

  // ---------------------------------------------------------------------------
  // Canonical event reads (Stripe v1 envelope)
  // ---------------------------------------------------------------------------

  async listEvents(ctx: MerchantContext): Promise<StripeV1Event[]> {
    return (await this.repo.listEvents(scopeOf(ctx))).map((r) => toStripeEvent(r, ctx.merchantId));
  }

  async getEvent(ctx: MerchantContext, id: string): Promise<StripeV1Event> {
    const row = await this.repo.findEvent(scopeOf(ctx), id);
    if (!row) throw problem("resource_not_found", "Event not found.");
    return toStripeEvent(row, ctx.merchantId);
  }

  async listDeliveries(ctx: MerchantContext): Promise<Array<Record<string, unknown>>> {
    const rows = await this.repo.listDeliveries(scopeOf(ctx));
    return rows.map((r) => ({
      id: r.id,
      event: r.event,
      endpoint: r.endpoint,
      attempt: r.attempt,
      delivered_at: r.delivered_at ? iso(r.delivered_at) : null,
      deadlettered_at: r.deadlettered_at ? iso(r.deadlettered_at) : null,
      response_status: r.response_status ?? null,
      signature: r.signature,
    }));
  }

  // ---------------------------------------------------------------------------
  // Inbound gateway webhook (T07 D6): normalize → dedup → emit canonical event
  // ---------------------------------------------------------------------------

  async ingestInboundWebhook(
    ctx: MerchantContext,
    driverId: string,
    rawBody: string,
    headers: Record<string, string | undefined>,
  ): Promise<{ replayed: boolean; eventId?: string }> {
    const driver = defaultRegistry.get(driverId) ?? defaultRegistry.get("mock");
    if (!driver) {
      throw problem("gateway_error", `Unknown gateway driver: ${driverId}`);
    }
    if (!driver.normalizeWebhook) {
      throw problem("gateway_error", `Driver '${driverId}' has no webhook normalizer.`);
    }

    const normalized = driver.normalizeWebhook({ body: rawBody, headers });
    const canonicalType = normalized.type === "refund" ? "payment.refunded" : "payment.succeeded";
    const eventId = `evt_${crypto.randomUUID()}`;

    const created = await this.repo.ingestInboundAndEmit({
      scope: scopeOf(ctx),
      driver: driverId,
      gatewayEventId: normalized.gatewayEventId,
      providerReference: normalized.providerReference,
      canonicalType,
      event: {
        id: eventId,
        type: canonicalType,
        objectType: "payment",
        objectId: normalized.providerReference,
        object: {
          reference: normalized.providerReference,
          gateway_event_id: normalized.gatewayEventId,
          type: canonicalType,
        },
      },
    });

    if (!created) return { replayed: true }; // dedup hit → 200 no-op
    return { replayed: false, eventId };
  }

  // ---------------------------------------------------------------------------
  // Replay (T07 D8): re-send the STORED envelope — no aggregate recompute.
  // ---------------------------------------------------------------------------

  async redeliverEndpointEvent(
    ctx: MerchantContext,
    endpointId: string,
    eventId: string,
  ): Promise<{ delivery: Awaited<ReturnType<typeof attemptDelivery>>; envelope: StripeV1Event }> {
    const scope = scopeOf(ctx);
    const endpoint = await this.repo.findEndpoint(scope, endpointId);
    if (!endpoint) throw problem("resource_not_found", "Webhook endpoint not found.");

    const eventRow = await this.repo.findEvent(scope, eventId);
    if (!eventRow) throw problem("resource_not_found", "Event not found.");

    let delivery = await this.repo.findDeliveryFor(scope, eventRow.id, endpoint.id);
    if (!delivery) {
      delivery = (await this.repo.createDelivery(scope, eventRow.id, endpoint.id)) ?? undefined;
    }
    if (!delivery) throw problem("internal_error", "Could not create delivery for replay.");

    // Reset the stored at-least-once row then re-send the STORED envelope.
    await this.repo.resetForReplay(scope, delivery.id);
    const fresh = await this.repo.findDeliveryById(scope, delivery.id);
    if (!fresh) throw problem("internal_error", "Could not load delivery for replay.");

    const outcome = await attemptDelivery(this.db, scope, fresh, eventRow, endpoint);
    return { delivery: outcome, envelope: toStripeEvent(eventRow, ctx.merchantId) };
  }
}
