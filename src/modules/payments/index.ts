/**
 * Payments pillar — Elysia plugin (module).
 *
 * Registers `/payments` routes under the versioned router's `/v1` prefix.
 * Named instance so Elysia's plugin dedup runs it once even if mounted in
 * multiple scopes (app + future test harness share the module instance).
 *
 * Routing (T03-smart-routing): a per-request switch selects the gateway
 * driver from the T03 registry by currency/method/amount rules; the mock is
 * the sandbox default. The chosen driver is passed to the PaymentService so
 * the service stays Elysia- and registry-free.
 */
import { Elysia, t } from "elysia";
import { auth } from "../../core/context";
import { InMemoryIdempotencyStore, namespaceIdempotencyKey, problem } from "../../core/idempotency";
import {
  defaultRegistry,
  defaultSandboxRules,
  type GatewayDriver,
  matchRule,
  MockGatewayDriver,
  resolveDriver,
} from "../../core/gateway";
import { CreatePayment, PaymentResource } from "./model";
import { PaymentService } from "./service";

const store = new InMemoryIdempotencyStore();
// T03: driver assembly at boot. Sandbox pre-activates the mock (SPEC 4.2),
// so a fresh tenant gets working payments with no external credentials.
defaultRegistry.register(new MockGatewayDriver());
const service = new PaymentService({
  insert: async (payment) => payment,
});

/** Route to a gateway driver for a request, defaulting to the sandbox mock. */
export function routeDriver(
  environment: "test" | "live",
  currency: string,
  amountMinor: number,
  method?: string,
): GatewayDriver {
  // TODO(T05/T08): when per-merchant routing rules are DB-backed, load them
  // here instead of the sandbox default set.
  const id = matchRule(defaultSandboxRules, {
    environment,
    currency,
    amountMinor,
    method,
    drivers: defaultRegistry.list(),
  });
  const driver =
    (id ? resolveDriver(id, defaultRegistry) : undefined) ??
    defaultRegistry.defaultFor(environment);
  if (!driver) {
    throw problem("gateway_error", `No gateway driver configured for ${environment} environment.`);
  }
  return driver;
}

export const payments = new Elysia({ name: "modules.payments", prefix: "/payments" })
  .state("paymentStore", store)
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

      // Choose the gateway driver for this request (T03 smart-routing).
      const gateway = routeDriver(environment, body.currency, body.amountMinor, body.method);
      const resource = await service.createPayment(
        { merchantId, environment, role, scopes, traceId },
        body,
        gateway,
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
