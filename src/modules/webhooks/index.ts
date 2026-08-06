/**
 * Webhooks pillar — Elysia plugin (module).
 *
 * Registers the T07 webhook surface under the versioned router's `/v1` prefix:
 *   - `webhook_endpoint` CRUD (secret returned once, masked on every read)
 *   - canonical event reads in the Stripe v1 envelope (`/events`, `/events/:id`)
 *   - the queryable delivery log (`/event_deliveries`) — streamer seam (T07 D8)
 *   - replay (`/webhook_endpoints/:id/events/:event_id/redeliver`)
 *   - inbound gateway webhook ingest + dedup (`/gateway/webhooks/:driver`)
 *
 * Authenticated via the shared `core.auth` derive (named, deduped). The outbox
 * drainer runs an in-process `setInterval` tick for the monolith (autostart;
 * tests pass `{ autostart: false }` and drive the drainer directly).
 */
import { Elysia, t } from "elysia";
import type { Surreal } from "surrealdb";
import { createContextAuth } from "../../core/context";
import type { MerchantContext } from "../../core/context";
import { namespaceIdempotencyKey, SurrealIdempotencyStore, problem } from "../../core/idempotency";
import { defaultRegistry } from "../../core/gateway";
import { MockGatewayDriver } from "../../core/gateway/mock";
import { drainAll } from "./drainer";
import { WebhooksService } from "./service";
import { CreateWebhookEndpoint, UpdateWebhookEndpoint } from "./model";

// Ensure the sandbox mock normalizer is reachable for the inbound path.
if (!defaultRegistry.get("mock")) defaultRegistry.register(new MockGatewayDriver());

const TICK_MS = 5_000;

export interface WebhooksModuleOptions {
  /** Start the in-process drainer tick (monolith default true; tests disable). */
  autostart?: boolean;
  /** Tick interval in ms. */
  tickMs?: number;
}

export function createWebhooksModule(db: Surreal, opts: WebhooksModuleOptions = {}) {
  const { tickMs = TICK_MS } = opts;
  const idempotency = new SurrealIdempotencyStore(db);
  const service = new WebhooksService(db);

  let timer: ReturnType<typeof setInterval> | undefined;

  const module = new Elysia({ name: "modules.webhooks", prefix: "/v1" })
    .state("idempotencyStore", idempotency)
    .use(createContextAuth(db))

    // POST /v1/webhook_endpoints — create; Idempotency-Key supported.
    .post(
      "/webhook_endpoints",
      {
        body: CreateWebhookEndpoint,
        headers: t.Object({
          "idempotency-key": t.Optional(t.String({ minLength: 8, maxLength: 128 })),
        }),
      },
      async ({ body, merchantId, environment, role, scopes, traceId, headers, set }) => {
        const ctx: MerchantContext = { merchantId, environment, role, scopes, traceId };
        const rawKey = headers["idempotency-key"];
        const nsKey = rawKey
          ? namespaceIdempotencyKey(merchantId, environment, "/v1/webhook_endpoints", rawKey)
          : undefined;

        if (nsKey) {
          const outcome = await idempotency.claim({ merchantId, environment }, nsKey);
          if (outcome === "replay") {
            const cached = await idempotency.get({ merchantId, environment }, nsKey);
            if (cached) return new Response(cached.body, { status: cached.status });
          }
          if (outcome === "conflict") {
            throw problem(
              "idempotency_conflict",
              "Concurrent request with the same Idempotency-Key is in progress.",
            );
          }
        }

        const resource = await service.createEndpoint(ctx, body);
        set.status = 201;

        if (nsKey) {
          await idempotency.commit({ merchantId, environment }, nsKey, {
            status: 201,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(resource),
          });
        }
        return resource;
      },
    )
    .get("/webhook_endpoints", async ({ merchantId, environment, role, scopes, traceId }) => {
      return service.listEndpoints({ merchantId, environment, role, scopes, traceId });
    })
    .get(
      "/webhook_endpoints/:id",
      { params: t.Object({ id: t.String() }) },
      async ({ params, merchantId, environment, role, scopes, traceId }) => {
        return service.getEndpoint({ merchantId, environment, role, scopes, traceId }, params.id);
      },
    )
    .patch(
      "/webhook_endpoints/:id",
      {
        body: UpdateWebhookEndpoint,
        params: t.Object({ id: t.String() }),
      },
      async ({ params, body, merchantId, environment, role, scopes, traceId }) => {
        return service.patchEndpoint(
          { merchantId, environment, role, scopes, traceId },
          params.id,
          body,
        );
      },
    )
    .delete(
      "/webhook_endpoints/:id",
      { params: t.Object({ id: t.String() }) },
      async ({ params, merchantId, environment, role, scopes, traceId }) => {
        return service.deleteEndpoint(
          { merchantId, environment, role, scopes, traceId },
          params.id,
        );
      },
    )

    // ---- canonical events + delivery log ----
    .get("/events", async ({ merchantId, environment, role, scopes, traceId }) => {
      return service.listEvents({ merchantId, environment, role, scopes, traceId });
    })
    .get(
      "/events/:id",
      { params: t.Object({ id: t.String() }) },
      async ({ params, merchantId, environment, role, scopes, traceId }) => {
        return service.getEvent({ merchantId, environment, role, scopes, traceId }, params.id);
      },
    )
    .get("/event_deliveries", async ({ merchantId, environment, role, scopes, traceId }) => {
      return service.listDeliveries({ merchantId, environment, role, scopes, traceId });
    })

    // ---- replay (re-send stored envelope, no recompute) ----
    .post(
      "/webhook_endpoints/:id/events/:event_id/redeliver",
      { params: t.Object({ id: t.String(), event_id: t.String() }) },
      async ({ params, merchantId, environment, role, scopes, traceId }) => {
        return service.redeliverEndpointEvent(
          { merchantId, environment, role, scopes, traceId },
          params.id,
          params.event_id,
        );
      },
    )

    // ---- inbound gateway webhook (dedup + canonical emit) ----
    .post(
      "/gateway/webhooks/:driver",
      {
        params: t.Object({ driver: t.String() }),
        body: t.Object({
          id: t.Optional(t.String()),
          reference: t.Optional(t.String()),
          type: t.Optional(t.String()),
        }),
      },
      async ({ params, body, request, merchantId, environment, role, scopes, traceId }) => {
        const ctx: MerchantContext = { merchantId, environment, role, scopes, traceId };
        // The mock normalizer re-parses JSON; real drivers will verify the raw
        // body signature once per-driver raw HMAC lands (mock ignores it).
        const rawBody = JSON.stringify(body);
        const headers: Record<string, string | undefined> = {};
        for (const [k, v] of request.headers.entries()) headers[k] = v;
        const result = await service.ingestInboundWebhook(ctx, params.driver, rawBody, headers);
        // First flight AND replay both reply 200 (T07 D6); the body carries the
        // dedup signal for the caller.
        return { handled: true, replayed: result.replayed, event_id: result.eventId ?? null };
      },
    )
    .cleanup(() => {
      if (timer) clearInterval(timer);
      timer = undefined;
    })
    .as("plugin");

  // Outbox drainer ticker for the monolith (opt-in; tests pass autostart:false).
  if (opts.autostart !== false) {
    timer = setInterval(() => {
      drainAll(db, { respectBackoff: true }).catch((err) => {
        console.error("[webhooks] drain tick failed", err);
      });
    }, tickMs);
  }

  return module;
}
