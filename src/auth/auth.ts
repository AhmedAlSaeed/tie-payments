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

/** A freshly-created Better Auth user (surfaced to sandbox provisioning). */
export interface AuthUserRef {
  id: string;
  email: string;
  name?: string | null;
}

export interface CreateAuthOptions {
  /**
   * Called after a user record is created (any sign-up path). The sandbox uses
   * this to auto-provision a `merchant` + test API keys + default mock routing
   * rule. Errors are caught + logged here so a provisioning failure NEVER
   * fails the sign-up itself (T08 D1: onboarding must not block account).
   */
  onUserCreated?: (user: AuthUserRef) => void | Promise<void>;
}

export function createAuth(db: Surreal, opts: CreateAuthOptions = {}) {
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
    // better-auth 1.6 database hook — fires after the `user` row is created by
    // any sign-up (email/password or OAuth); runs inside the adapter layer so
    // the created user's `id` is usable as the `merchant.auth_user` link.
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            try {
              await opts.onUserCreated?.({ id: user.id, email: user.email, name: user.name });
            } catch (error) {
              // Provisioning is best-effort: log + continue, never fail signup.
              console.error("[auth] sandbox provisioning failed for user", user.id, error);
            }
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;
export type Session = Awaited<ReturnType<Auth["api"]["getSession"]>>;
