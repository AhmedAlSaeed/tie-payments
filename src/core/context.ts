/**
 * Request context — bound to every authenticated request via `derive`.
 *
 * Derives, from the Bearer key alone:
 *   - environment (test/live) — the source of truth, never overridable from body
 *   - role (secret vs publishable) and allowed scopes
 *   - merchant identity (resolved from the `api_key` row by its hash)
 *   - traceId for log correlation and Problem Details `instance`
 *
 * Tenancy note (F0): the DB row-level `PERMISSIONS` clauses on the schema encode
 * the intended isolation (WHERE merchant = $auth.merchant AND environment =
 * $auth.environment), but the SurrealDB build currently shipped (`surrealdb:
 * latest` nightly) does not reliably enforce write permissions for record
 * sessions. Every store therefore ALSO scopes its queries by merchant +
 * environment derived from this context — that query-layer scope is the F0
 * isolation guarantee.
 *
 * This is an Elysia 2.0 `derive` (replaces 1.x `resolve`).
 */
import { Elysia } from "elysia";
import type { Surreal } from "surrealdb";
import { ApiKeyError, parseBearer } from "./apikey";
import { ProblemError } from "./errors";
import { recordIdToString } from "./records";

export interface MerchantContext {
  /** Merchant record id (`merchant:...`) the key resolved to. */
  merchantId: string;
  environment: "test" | "live";
  role: "secret" | "publishable";
  scopes: string[];
  traceId: string;
}

export function createContextAuth(db: Surreal) {
  return new Elysia({ name: "core.auth" })
    .derive(async ({ request }) => {
      const traceId = crypto.randomUUID();
      // Read the raw Authorization header from the underlying Request: a route's
      // `headers` schema replaces `context.headers` with only its declared keys
      // (e.g. `idempotency-key`), which would drop `authorization` entirely.
      const rawKey = request.headers.get("authorization") ?? undefined;

      let key: ReturnType<typeof parseBearer>;
      try {
        key = parseBearer(rawKey);
      } catch (e) {
        if (e instanceof ApiKeyError) {
          throw new ProblemError(e.code, e.message);
        }
        throw e;
      }

      // api_key → merchant resolution (F0): the hash is the only stored secret
      // material; the row supplies merchant + env. A missing or inactive key is
      // rejected outright.
      const [rows] = await db
        .query("SELECT merchant, environment, active FROM api_key WHERE hash = $hash LIMIT 1", {
          hash: key.hash,
        })
        .collect<[Array<{ merchant: string; environment: string; active: boolean }>]>();
      const row = rows?.[0];
      if (!row || row.active === false) {
        throw new ProblemError("invalid_api_key", "API key is invalid or has been revoked.");
      }

      return {
        merchantId: recordIdToString(row.merchant),
        // Environment is ALWAYS taken from the key prefix — never from the body.
        environment: key.env,
        role: key.role,
        scopes: key.scopes,
        traceId,
      } satisfies MerchantContext;
    })
    .as("plugin");
}
