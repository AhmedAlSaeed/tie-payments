/**
 * Better Auth identity — human users (merchants + platform operators).
 *
 * Factory (`createAuth`) so tests can point at an isolated SurrealDB without
 * the module connecting on import. Production wires it with the shared DB:
 * see `src/app.ts`.
 *
 * Distinct from `core/context.ts` API-key auth: Better Auth owns sessions
 * (cookies, email/password) for dashboard/console humans; the `sk|pk_` Bearer
 * keys keep authenticating the machine-to-machine payment API surface.
 *
 * Merchant = an `organization` (org plugin); platform staff = `admin` users.
 */
import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins/admin";
import { organization } from "better-auth/plugins/organization";
import { surrealAdapter } from "@surrealdb/better-auth";
import type { Surreal } from "surrealdb";

export function createAuth(db: Surreal) {
  return betterAuth({
    appName: "tie-payments",
    database: surrealAdapter({
      db,
      schemaMode: "schemafull",
    }),
    emailAndPassword: {
      enabled: true,
    },
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 60 * 5,
      },
    },
    plugins: [organization(), admin()],
  });
}

export type Auth = ReturnType<typeof createAuth>;
export type Session = Awaited<ReturnType<Auth["api"]["getSession"]>>;
