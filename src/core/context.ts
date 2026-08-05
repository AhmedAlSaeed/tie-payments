/**
 * Request context — bound to every authenticated request via `derive`.
 *
 * Derives, from the Bearer key alone:
 *   - environment (test/live) — the source of truth, never overridable from body
 *   - role (secret vs publishable) and allowed scopes
 *   - merchant identity (from key lookup; stub here until the key store lands)
 *   - traceId for log correlation and Problem Details `instance`
 *
 * This is an Elysia 2.0 `derive` (replaces 1.x `resolve`).
 */
import { Elysia } from "elysia";
import { ApiKeyError, parseBearer } from "./apikey";
import { ProblemError } from "./errors";

export interface MerchantContext {
  merchantId: string;
  environment: "test" | "live";
  role: "secret" | "publishable";
  scopes: string[];
  traceId: string;
}

export const auth = new Elysia({ name: "core.auth" })
  .derive(({ request }) => {
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

    // Stub key→merchant resolution: hash of the key stands in for the merchant id.
    // T001/T04-later: look up api_key table, bind merchant record id, revoked/active.
    return {
      merchantId: `merchant::${key.hash}`,
      environment: key.env,
      role: key.role,
      scopes: key.scopes,
      traceId,
    } satisfies MerchantContext;
  })
  .as("plugin");
