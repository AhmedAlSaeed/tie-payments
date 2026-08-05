/**
 * Payments pillar — Elysia plugin (module).
 *
 * Registers `/payments` routes under the versioned router's `/v1` prefix.
 * Named instance so Elysia's plugin dedup runs it once even if mounted in
 * multiple scopes (app + future test harness share the module instance).
 */
import { Elysia, t } from "elysia";
import { auth } from "../../core/context";
import { InMemoryIdempotencyStore, namespaceIdempotencyKey, problem } from "../../core/idempotency";
import { CreatePayment, PaymentResource } from "./model";
import { PaymentService } from "./service";

const store = new InMemoryIdempotencyStore();
const service = new PaymentService({
  insert: async (payment) => {
    // T001: persist to SurrealDB here; prototype keeps the record in memory.
    return payment;
  },
});

export const payments = new Elysia({ name: "modules.payments", prefix: "/payments" })
  .use(auth)
  .post(
    "/",
    {
      body: CreatePayment,
      response: {
        201: PaymentResource,
      },
      headers: t.Object({
        "idempotency-key": t.Optional(t.String({ minLength: 8, maxLength: 128 })),
      }),
    },
    async ({ body, merchantId, environment, role, scopes, traceId, headers, set }) => {
      const rawKey = headers["idempotency-key"];
      const nsKey = rawKey
        ? namespaceIdempotencyKey(merchantId, environment, "/payments", rawKey)
        : undefined;

      if (nsKey) {
        const outcome = store.claim(nsKey);
        if (outcome === "replay") {
          const cached = store.get(nsKey);
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

      const resource = await service.createPayment(
        { merchantId, environment, role, scopes, traceId },
        body,
        rawKey,
      );

      set.status = 201;

      if (nsKey) {
        store.commit(nsKey, {
          status: 201,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(resource),
        });
      }

      return resource;
    },
  )
  .get("/:id", { params: t.Object({ id: t.String() }) }, () =>
    problem("resource_not_found", "Payment lookup lands with the SurrealDB store."),
  );
