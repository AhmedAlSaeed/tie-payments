/**
 * API key model — `pk_/sk_` namespacing and environment partitioning.
 *
 * Key format: `<type>_<env>_<secret>` where
 *   type = pk|sk, env = test|live, secret = 40 hex chars.
 * e.g. `sk_test_1vLk9wQz...` / `pk_live_...`
 *
 * The environment is ALWAYS parsed from the prefix and injected per-request;
 * callers can never request an environment independent of the key they used.
 */
import type { Environment } from "../shared/constants";

export type ApiKeyType = "sk" | "pk";
export type ApiKeyRole = "secret" | "publishable";

const PREFIX_RE = /^(sk|pk)_(test|live)_([0-9a-fA-F]{40})$/;

export interface ParsedApiKey {
  raw: string;
  type: ApiKeyType;
  role: ApiKeyRole;
  env: Environment;
  /** Hashed digest used as the storage key (never store raw secrets). */
  hash: string;
  /** Operation scopes this key authorizes (stub — enforced by permissions later). */
  scopes: string[];
}

/** Create a new key of a given type+env with a fresh random secret. */
export function generateKey(type: ApiKeyType, env: Environment): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const secret = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${type}_${env}_${secret}`;
}

/** Always-hashed lookup value so raw secrets never touch the DB (SHA-256 hex). */
export function hashSecret(raw: string): string {
  return new Bun.CryptoHasher("sha256").update(raw).digest("hex");
}

/** Parse+validate a raw bearer key into its typed structure, or throw ApiKeyError. */
export function parseKey(token: string): ParsedApiKey {
  const m = PREFIX_RE.exec(token);
  if (!m) throw new ApiKeyError("invalid_api_key", "API key is malformed or unknown.");

  const type = m[1] as ApiKeyType;
  const env = m[2] as Environment;
  const secret = m[3];

  return {
    raw: token,
    type,
    role: type === "sk" ? "secret" : "publishable",
    env,
    hash: hashSecret(secret),
    scopes:
      type === "sk" ? ["payments:read", "payments:write", "invoices:read"] : ["tokens:create"],
  };
}

/** Parse from an Authorization header value `Bearer <key>`. Throws on absent/invalid. */
export function parseBearer(header: string | undefined): ParsedApiKey {
  if (!header) throw new ApiKeyError("unauthenticated", "Missing Authorization header.");
  const [scheme, token, ...rest] = header.trim().split(/\s+/);
  if (scheme.toLowerCase() !== "bearer" || !token || rest.length) {
    throw new ApiKeyError("invalid_api_key", 'Authorization must be "Bearer <sk_...|pk_...>".');
  }
  return parseKey(token);
}

export class ApiKeyError extends Error {
  readonly code: "invalid_api_key" | "unauthenticated";
  constructor(code: ApiKeyError["code"], message: string) {
    super(message);
    this.code = code;
  }
}
