/**
 * Subscriptions pillar — Elysia plugin (module).
 *
 * Registers `/prices`, `/subscriptions`, `/usage_records` routes (T3) which the
 * versioned router mounts under `/v1`. Built by a factory so tests wire an
 * isolated SurrealDB connection. Mounted centrally in app.ts later (not this
 * ticket).
 *
 * Period-close invokes the T1 InvoiceService in-process (create + finalize the
 * cycle invoice) rather than over HTTP — the module builds its own
 * InvoiceService over the shared repository + seeded tax rate.
 *
 * Idempotency (F0/T1 pattern): POST /prices and POST /subscriptions claim an
 * `Idempotency-Key` namespaced to their route; replays return the cached
 * response.
 */
import { Elysia, t } from "elysia";
import type { Surreal } from "surrealdb";
import { createContextAuth } from "../../core/context";
import type { MerchantContext } from "../../core/context";
import { namespaceIdempotencyKey, SurrealIdempotencyStore, problem } from "../../core/idempotency";
import type { IdempotencyScope } from "../../core/idempotency";
import { GatewayError } from "../../core/gateway";
import { InvoiceService } from "../invoicing/service";
import type { ChargeViaGateway } from "../invoicing/service";
import { InvoiceRepository } from "../invoicing/repository";
import { ensureDefaultTaxRate } from "../invoicing/seed";
import { PaymentService } from "../payments/service";
import { PaymentsRepository } from "../payments/repository";
import { routeDriver } from "../payments";
import {
  CancelSubscription,
  ChangeItemQuantity,
  CreatePrice,
  CreateSubscription,
  CreateUsageRecord,
  DunningRunResult,
  FailedChargeResult,
  OnFailedCharge,
  PriceResource,
  SubscriptionResource,
  UpdatePrice,
  UpdateSubscription,
  UsageRecordResource,
} from "./model";
import { SubscriptionsRepository } from "./repository";
import { SubscriptionService } from "./service";
import type { SubscriptionInvoicing } from "./service";

export interface SubscriptionsModuleOptions {
  /** Start the in-process dunning/maintenance tick (monolith default true). */
  autostart?: boolean;
  /** Tick interval in ms (tests disable via autostart:false). */
  tickMs?: number;
}

/** Shared subscription service deps (module factory + runDunningTick). */
function createSubscriptionsService(db: Surreal) {
  const repository = new SubscriptionsRepository(db);

  // In-process invoicing seam for period-close (reuses T1's service + seed).
  const invoiceRepository = new InvoiceRepository(db);
  const seedTaxRate = async (ctx: MerchantContext) => {
    const rate = await ensureDefaultTaxRate(db, ctx.merchantId, ctx.environment);
    return {
      percentage: rate.percentage,
      inclusive: rate.inclusive,
      jurisdiction: rate.jurisdiction,
    };
  };

  // Charge seam for the invoicing service (allows auto collection on finalized
  // `charge_automatically` invoices). Mirrors the invoicing module's wiring;
  // also enables the `/charge` route registered on the invoicing module and the
  // dunning re-charge (T4).
  const paymentsRepository = new PaymentsRepository(db);
  const paymentService = new PaymentService(paymentsRepository);
  const chargeGateway: ChargeViaGateway = async ({ ctx, method, amountMinor, currency }) => {
    const gateway = routeDriver(ctx.environment, currency, amountMinor, method);
    try {
      const payment = await paymentService.createPayment(
        ctx,
        {
          amountMinor,
          currency: currency as "BHD" | "USD" | "SAR" | "AED" | "KWD" | "QAR" | "OMR",
          method,
        },
        gateway,
      );
      return payment.status === "requires_action"
        ? { kind: "requires_action", status: payment.status, action: payment.action }
        : { kind: "succeeded", status: payment.status };
    } catch (error) {
      if (error instanceof GatewayError) {
        return {
          kind: "gateway_error",
          code: error.code,
          retryable: error.retryable,
          message: error.message,
        };
      }
      throw error;
    }
  };

  const invoicing = new InvoiceService(
    invoiceRepository,
    seedTaxRate,
    chargeGateway,
  ) as unknown as SubscriptionInvoicing;
  const service = new SubscriptionService(repository, invoicing);

  return { repository, service };
}

/**
 * Monolith dunning/maintenance tick — scan EVERY scope for due `pending`
 * dunning attempts, `trial_will_end` flags and run each. Standalone (dedicated
 * Effector of the module) so a deployable host can wire it on a timer; tests
 * disable the module ticker (`autostart:false`) and call `runDunning` directly.
 */
export async function runDunningTick(
  db: Surreal,
): Promise<Array<{ subscriptionId: string; outcome: string; error?: string }>> {
  const { repository, service } = createSubscriptionsService(db);
  const due = await repository.findDueDunning(new Date().toISOString());
  const results: Array<{ subscriptionId: string; outcome: string; error?: string }> =
    await Promise.all(
      due.map(async (attempt) => {
        const ctx: MerchantContext = {
          merchantId: attempt.merchantId,
          environment: attempt.environment as "test" | "live",
          role: "secret",
          scopes: [],
          traceId: `tick-${attempt.id}`,
        };
        try {
          const r = await service.runDunning(ctx, attempt.subscriptionId);
          return { subscriptionId: attempt.subscriptionId, outcome: r.outcome };
        } catch (error) {
          return {
            subscriptionId: attempt.subscriptionId,
            outcome: "error",
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
  return results;
}

export function createSubscriptionsModule(db: Surreal, opts: SubscriptionsModuleOptions = {}) {
  const idempotencyStore = new SurrealIdempotencyStore(db);
  const { service } = createSubscriptionsService(db);

  let timer: ReturnType<typeof setInterval> | undefined;

  const module = new Elysia({ name: "modules.subscriptions" })
    .state("subIdempotencyStore", idempotencyStore)
    .use(createContextAuth(db))
    .cleanup(() => {
      if (timer) clearInterval(timer);
      timer = undefined;
    })

    // ---- Prices -------------------------------------------------------
    .post(
      "/prices",
      {
        body: CreatePrice,
        response: { 201: PriceResource },
        headers: t.Object({
          "idempotency-key": t.Optional(t.String({ minLength: 8, maxLength: 128 })),
        }),
      },
      async ({ body, merchantId, environment, role, scopes, traceId, headers, set }) => {
        const nsKey = idempotencyKey(headers, merchantId, environment, "/prices", idempotencyStore);
        const replay = await maybeReplay(nsKey, idempotencyStore, {
          merchantId,
          environment,
        } as IdempotencyScope);
        if (replay) return replay;
        const resource = await service.createPrice(
          { merchantId, environment, role, scopes, traceId },
          body,
        );
        set.status = 201;
        await commit(
          nsKey,
          idempotencyStore,
          { merchantId, environment } as IdempotencyScope,
          201,
          resource,
        );
        return resource;
      },
    )
    .get(
      "/prices",
      { response: t.Array(PriceResource) },
      async ({ merchantId, environment, role, scopes, traceId }) =>
        service.listPrices({ merchantId, environment, role, scopes, traceId }),
    )
    .get(
      "/prices/:id",
      { params: t.Object({ id: t.String() }), response: PriceResource },
      async ({ params, merchantId, environment, role, scopes, traceId }) => {
        const resource = await service.getPrice(
          { merchantId, environment, role, scopes, traceId },
          params.id,
        );
        if (!resource) throw problem("resource_not_found", "Price not found.");
        return resource;
      },
    )
    .patch(
      "/prices/:id",
      { params: t.Object({ id: t.String() }), body: UpdatePrice, response: PriceResource },
      async ({ params, body, merchantId, environment, role, scopes, traceId }) =>
        service.updatePrice({ merchantId, environment, role, scopes, traceId }, params.id, body),
    )
    .delete(
      "/prices/:id",
      { params: t.Object({ id: t.String() }) },
      async ({ params, merchantId, environment, role, scopes, traceId }) =>
        service.deletePrice({ merchantId, environment, role, scopes, traceId }, params.id),
    )

    // ---- Subscriptions ------------------------------------------------
    .post(
      "/subscriptions",
      {
        body: CreateSubscription,
        response: { 201: SubscriptionResource },
        headers: t.Object({
          "idempotency-key": t.Optional(t.String({ minLength: 8, maxLength: 128 })),
        }),
      },
      async ({ body, merchantId, environment, role, scopes, traceId, headers, set }) => {
        const nsKey = idempotencyKey(
          headers,
          merchantId,
          environment,
          "/subscriptions",
          idempotencyStore,
        );
        const replay = await maybeReplay(nsKey, idempotencyStore, {
          merchantId,
          environment,
        } as IdempotencyScope);
        if (replay) return replay;
        const resource = await service.createSubscription(
          { merchantId, environment, role, scopes, traceId },
          body,
        );
        set.status = 201;
        await commit(
          nsKey,
          idempotencyStore,
          { merchantId, environment } as IdempotencyScope,
          201,
          resource,
        );
        return resource;
      },
    )
    .get(
      "/subscriptions",
      { response: t.Array(SubscriptionResource) },
      async ({ merchantId, environment, role, scopes, traceId }) =>
        service.listSubscriptions({ merchantId, environment, role, scopes, traceId }),
    )
    .get(
      "/subscriptions/:id",
      { params: t.Object({ id: t.String() }), response: SubscriptionResource },
      async ({ params, merchantId, environment, role, scopes, traceId }) => {
        const resource = await service.getSubscription(
          { merchantId, environment, role, scopes, traceId },
          params.id,
        );
        if (!resource) throw problem("resource_not_found", "Subscription not found.");
        return resource;
      },
    )
    .patch(
      "/subscriptions/:id",
      {
        params: t.Object({ id: t.String() }),
        body: UpdateSubscription,
        response: SubscriptionResource,
      },
      async ({ params, body, merchantId, environment, role, scopes, traceId }) =>
        service.updateSubscription(
          { merchantId, environment, role, scopes, traceId },
          params.id,
          body,
        ),
    )
    .post(
      "/subscriptions/:id/close_period",
      { params: t.Object({ id: t.String() }), response: SubscriptionResource },
      async ({ params, merchantId, environment, role, scopes, traceId }) =>
        service.closePeriod({ merchantId, environment, role, scopes, traceId }, params.id),
    )

    // ---- Dunning (T4) ------------------------------------------------
    .post(
      "/subscriptions/:id/dunning/on_failed_charge",
      {
        params: t.Object({ id: t.String() }),
        body: OnFailedCharge,
        response: { 201: FailedChargeResult },
      },
      async ({ params, body, merchantId, environment, role, scopes, traceId, set }) => {
        const result = await service.recordFailedCharge(
          { merchantId, environment, role, scopes, traceId },
          params.id,
          body,
        );
        set.status = 201;
        return result;
      },
    )
    .post(
      "/subscriptions/:id/dunning/run",
      {
        params: t.Object({ id: t.String() }),
        response: DunningRunResult,
      },
      async ({ params, merchantId, environment, role, scopes, traceId }) =>
        service.runDunning({ merchantId, environment, role, scopes, traceId }, params.id),
    )
    .post(
      "/subscriptions/:id/cancel",
      {
        params: t.Object({ id: t.String() }),
        body: CancelSubscription,
        response: SubscriptionResource,
      },
      async ({ params, body, merchantId, environment, role, scopes, traceId }) =>
        service.cancelSubscription(
          { merchantId, environment, role, scopes, traceId },
          params.id,
          body,
        ),
    )
    .post(
      "/subscriptions/:id/items/:item_id/quantity",
      {
        params: t.Object({ id: t.String(), item_id: t.String() }),
        body: ChangeItemQuantity,
        response: SubscriptionResource,
      },
      async ({ params, body, merchantId, environment, role, scopes, traceId }) =>
        service.changeItemQuantity(
          { merchantId, environment, role, scopes, traceId },
          params.id,
          params.item_id,
          body,
        ),
    )
    .post(
      "/subscriptions/:id/maintain",
      { params: t.Object({ id: t.String() }), response: SubscriptionResource },
      async ({ params, merchantId, environment, role, scopes, traceId }) =>
        service.maintain({ merchantId, environment, role, scopes, traceId }, params.id),
    )

    // ---- Usage --------------------------------------------------------
    .post(
      "/usage_records",
      { body: CreateUsageRecord, response: { 201: UsageRecordResource } },
      async ({ body, merchantId, environment, role, scopes, traceId, set }) => {
        const resource = await service.recordUsage(
          { merchantId, environment, role, scopes, traceId },
          body,
        );
        set.status = 201;
        return resource;
      },
    );

  // In-process dunning/maintenance ticker for the monolith (opt-in; tests pass
  // `autostart: false` and call runDunning / POST maintain directly). Mirrors
  // the webhooks drainer ticker.
  if (opts.autostart !== false) {
    const tickMs = opts.tickMs ?? 5_000;
    timer = setInterval(() => {
      runDunningTick(db).catch((err) => {
        console.error("[subscriptions] dunning tick failed", err);
      });
    }, tickMs);
  }

  return module;
}

// ---- Idempotency wiring (mirrors payments/invoicing modules) -------------

function idempotencyKey(
  headers: Record<string, string | undefined>,
  merchantId: string,
  environment: string,
  route: string,
  _store: SurrealIdempotencyStore,
): string | undefined {
  const raw = headers["idempotency-key"];
  return raw ? namespaceIdempotencyKey(merchantId, environment, route, raw) : undefined;
}

/** If the key was already committed, return the cached response (replay). */
async function maybeReplay(
  nsKey: string | undefined,
  store: SurrealIdempotencyStore,
  scope: IdempotencyScope,
): Promise<Response | undefined> {
  if (!nsKey) return undefined;
  const outcome = await store.claim(scope, nsKey);
  if (outcome === "replay") {
    const cached = await store.get(scope, nsKey);
    if (cached)
      return new Response(cached.body, { status: cached.status, headers: cached.headers });
  }
  if (outcome === "conflict") {
    throw problem(
      "idempotency_conflict",
      "Concurrent request with the same Idempotency-Key is in progress.",
    );
  }
  return undefined;
}

async function commit(
  nsKey: string | undefined,
  store: SurrealIdempotencyStore,
  scope: IdempotencyScope,
  status: number,
  body: unknown,
): Promise<void> {
  if (!nsKey) return;
  await store.commit(scope, nsKey, {
    status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
