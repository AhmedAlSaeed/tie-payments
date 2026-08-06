/**
 * Modular monolith assembly.
 *
 * `createApp(db)` builds the whole app from a SurrealDB connection — identity
 * (Better Auth), the API-key-authenticated versioned router, and the
 * session-authenticated console seam. Tests call `createApp` with an isolated
 * database; production exports the `app` wired to the shared `getDb()`.
 *
 * Versioning policy: all current routes live behind `/v1`; a new major is a
 * second router with its own prefix, keeping old majors live until sunset.
 * `/health` and the `/api/auth` identity surface live outside versioning.
 */
import { Elysia } from "elysia";
import type { Surreal } from "surrealdb";
import { errorHandling } from "./core/errors-plugin";
import { createContextAuth } from "./core/context";
import { getDb } from "./core/db";
import { createAuth, createIdentity, createSessionAuth } from "./auth";
import { createPaymentsModule } from "./modules/payments";
import { createInvoicingModule } from "./modules/invoicing";
import { createWebhooksModule } from "./modules/webhooks";
import { createCustomizationModule } from "./modules/customization";

export function createApp(db: Surreal) {
  const identityAuth = createAuth(db);
  const identity = createIdentity(identityAuth);
  const sessionAuth = createSessionAuth(identityAuth);

  const auth = createContextAuth(db);

  const v1 = new Elysia({ prefix: "/v1" })
    .use(errorHandling)
    .use(auth)
    .get("/me", ({ merchantId, environment, role, scopes, traceId }) => ({
      merchantId,
      environment,
      role,
      scopes,
      traceId,
    }))
    .use(createPaymentsModule(db))
    .use(createInvoicingModule(db))
    .use(createWebhooksModule(db))
    .use(createCustomizationModule(db));
  // Pillars to land with their tickets, mounted on the same versioned router:
  //   .use(subscriptions) (T06)

  // Human-facing platform surface — session-authenticated (Better Auth), NOT
  // API-key auth. Seam for the merchant portal + operator console endpoints.
  const consoleRoutes = new Elysia({ prefix: "/console" })
    .use(sessionAuth)
    .get("/me", ({ user, session }) => ({
      user: { id: user.id, email: user.email, name: user.name },
      session: session.id,
    }));

  return new Elysia()
    .use(errorHandling)
    .get("/health", () => ({ status: "ok" }))
    .use(v1)
    .use(consoleRoutes)
    .use(identity);
}

export const app = createApp(await getDb());
