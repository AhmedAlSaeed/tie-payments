/**
 * Invoicing pillar — Elysia plugin (module).
 *
 * Registers `/invoices` routes (T1 invoice lifecycle: create draft → finalize).
 * Built by a factory so tests wire an isolated SurrealDB connection. Mounted on
 * the versioned router's `/v1` prefix in app.ts (done centrally, later).
 *
 * Tenancy: every route `.use(createContextAuth(db))` so handlers receive
 * `merchantId, environment, role, scopes, traceId`; the repository scopes every
 * query by merchant+environment derived from the key (F0 guarantee).
 *
 * Idempotency (T1, mirroring F0): POST /invoices claims an `Idempotency-Key`
 * namespaced to `/invoices`; a replay after a restart returns the cached
 * response. The default per-tenant Bahrain VAT rate is seeded lazily by
 * `seed.ensureDefaultTaxRate` on the first (merchant, environment) write.
 */
import { Elysia, t } from "elysia";
import type { Surreal } from "surrealdb";
import { createContextAuth } from "../../core/context";
import type { MerchantContext } from "../../core/context";
import { namespaceIdempotencyKey, SurrealIdempotencyStore, problem } from "../../core/idempotency";
import { GatewayError } from "../../core/gateway";
import { PaymentService } from "../payments/service";
import { PaymentsRepository } from "../payments/repository";
import { routeDriver } from "../payments";
import { ChargeInvoice, CreateInvoice, InvoiceResource, UpdateInvoice } from "./model";
import { InvoiceService, type ChargeViaGateway } from "./service";
import { InvoiceRepository } from "./repository";
import { ensureDefaultTaxRate } from "./seed";

export function createInvoicingModule(db: Surreal) {
  const idempotencyStore = new SurrealIdempotencyStore(db);
  const repository = new InvoiceRepository(db);

  // Resolve (and lazily seed) the tenant's default tax rate from the authed
  // context each write, so the service stays db-free.
  const seedTaxRate = async (ctx: MerchantContext) => {
    const rate = await ensureDefaultTaxRate(db, ctx.merchantId, ctx.environment);
    return {
      percentage: rate.percentage,
      inclusive: rate.inclusive,
      jurisdiction: rate.jurisdiction,
    };
  };

  // T2 collection: charge through the same routed-gateway seam as the payments
  // pillar (T03). `routeDriver` picks the mock in sandbox; `PaymentService`
  // persists the `payment` row and normalizes the outcome.
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

  const service = new InvoiceService(repository, seedTaxRate, chargeGateway);

  return new Elysia({ name: "modules.invoicing", prefix: "/invoices" })
    .state("invoiceIdempotencyStore", idempotencyStore)
    .use(createContextAuth(db))
    .post(
      "/",
      {
        body: CreateInvoice,
        response: {
          201: InvoiceResource,
        },
        headers: t.Object({
          "idempotency-key": t.Optional(t.String({ minLength: 8, maxLength: 128 })),
        }),
      },
      async ({ body, merchantId, environment, role, scopes, traceId, headers, set }) => {
        const rawKey = headers["idempotency-key"];
        const nsKey = rawKey
          ? namespaceIdempotencyKey(merchantId, environment, "/invoices", rawKey)
          : undefined;

        if (nsKey) {
          const outcome = await idempotencyStore.claim({ merchantId, environment }, nsKey);
          if (outcome === "replay") {
            const cached = await idempotencyStore.get({ merchantId, environment }, nsKey);
            if (cached) {
              return new Response(cached.body, { status: cached.status, headers: cached.headers });
            }
          }
          if (outcome === "conflict") {
            throw problem(
              "idempotency_conflict",
              "Concurrent request with the same Idempotency-Key is in progress.",
            );
          }
        }

        const resource = await service.createInvoice(
          { merchantId, environment, role, scopes, traceId },
          body,
        );

        set.status = 201;

        if (nsKey) {
          await idempotencyStore.commit({ merchantId, environment }, nsKey, {
            status: 201,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(resource),
          });
        }

        return resource;
      },
    )
    .get(
      "/:id",
      { params: t.Object({ id: t.String() }) },
      async ({ params, merchantId, environment }) => {
        const resource = await service.getById(merchantId, environment, params.id);
        if (!resource) {
          throw problem("resource_not_found", "Invoice not found.");
        }
        return resource;
      },
    )
    .patch(
      "/:id",
      { body: UpdateInvoice, params: t.Object({ id: t.String() }) },
      async ({ params, body, merchantId, environment, role, scopes, traceId }) => {
        return service.updateDraft(
          { merchantId, environment, role, scopes, traceId },
          params.id,
          body,
        );
      },
    )
    .delete(
      "/:id",
      { params: t.Object({ id: t.String() }) },
      async ({ params, merchantId, environment }) => {
        return service.deleteDraft(merchantId, environment, params.id);
      },
    )
    .post(
      "/:id/finalize",
      { params: t.Object({ id: t.String() }), response: InvoiceResource },
      async ({ params, merchantId, environment, role, scopes, traceId }) => {
        return service.finalize({ merchantId, environment, role, scopes, traceId }, params.id);
      },
    )
    .post(
      "/:id/charge",
      { params: t.Object({ id: t.String() }), body: ChargeInvoice, response: InvoiceResource },
      async ({ params, body, merchantId, environment, role, scopes, traceId }) => {
        return service.charge({ merchantId, environment, role, scopes, traceId }, params.id, body);
      },
    )
    .post(
      "/:id/void",
      { params: t.Object({ id: t.String() }), response: InvoiceResource },
      async ({ params, merchantId, environment, role, scopes, traceId }) => {
        return service.voidInvoice({ merchantId, environment, role, scopes, traceId }, params.id);
      },
    )
    .post(
      "/:id/mark_uncollectible",
      { params: t.Object({ id: t.String() }), response: InvoiceResource },
      async ({ params, merchantId, environment, role, scopes, traceId }) => {
        return service.markUncollectible(
          { merchantId, environment, role, scopes, traceId },
          params.id,
        );
      },
    );
}
