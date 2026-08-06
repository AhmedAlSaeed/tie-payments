/**
 * Idempotency-Key semantics.
 *
 * Client sends `Idempotency-Key: <key>` on mutating methods. The key is
 * namespaced by (merchant, environment, route) so keys never collide across
 * tenants or endpoints. Semantics:
 *   - First request claims the key and runs; its response is cached.
 *   - A replay with the same key returns the cached response exactly.
 *   - A concurrent same-key request (still in flight) returns 409
 *     idempotency_conflict — the client should retry once the original finishes.
 *
 * The `IdempotencyStore` contract is implemented two ways:
 *   - `SurrealIdempotencyStore` — durable, backed by the `idempotency` table
 *     (F0). The claim is gated by a UNIQUE (merchant, environment,
 *     namespaced_key) index; commit marks it completed with the cached
 *     response. Survives process restart (T01 pattern).
 *   - `InMemoryIdempotencyStore` — reference/unit-test double.
 */
import { problem } from "./errors";
import { recordIdOf } from "./records";
import type { Surreal } from "surrealdb";

export interface IdempotencyRecord {
  /** Namespaced key: `hash(merchantId::env::route::key)`. */
  namespacedKey: string;
  /** Awaiting the request's thread to set these once it succeeds. */
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type ClaimResult = "claimed" | "replay" | "conflict";

/** Tenant scope an idempotency key lives in (merchant record id + env). */
export interface IdempotencyScope {
  merchantId: string;
  environment: "test" | "live";
}

/** Shape of an `idempotency` table row as read back from SurrealDB. */
interface IdempotencyRow {
  merchant: string;
  environment: string;
  namespaced_key: string;
  status: "in_progress" | "completed";
  response_status?: number;
  response_headers?: Record<string, string>;
  response_body?: string;
  expires_at: string;
  created_at: string;
}

/** How long an in-flight claim may stay open before it can be re-claimed. */
export const CLAIM_TTL_SECONDS = 60;

/** Namespace an inbound Idempotency-Key within merchant+env+route scope. */
export function namespaceIdempotencyKey(
  merchantId: string,
  env: string,
  route: string,
  key: string,
): string {
  return Bun.hash.xxHash32(`${merchantId}::${env}::${route}::${key}`).toString(36);
}

export interface IdempotencyStore {
  /**
   * Claim a namespaced key. Returns:
   *   'claimed'  — caller owns it and should execute then commit(key, result)
   *   'replay'   — already succeeded; caller returns cached result (from get)
   *   'conflict' — another request is currently executing it
   */
  claim(scope: IdempotencyScope, key: string): Promise<ClaimResult>;
  /** Persist the result of a claim we owned. */
  commit(
    scope: IdempotencyScope,
    key: string,
    record: Omit<IdempotencyRecord, "namespacedKey">,
  ): Promise<void>;
  /** Read a previously committed record (after 'replay'). */
  get(scope: IdempotencyScope, key: string): Promise<IdempotencyRecord | undefined>;
}

/**
 * SurrealDB-backed idempotency store (F0). The UNIQUE index on
 * (merchant, environment, namespaced_key) is the atomic claim gate (T01).
 * A claim writes an `in_progress` row; commit flips it to `completed` with the
 * cached response. Expired in-progress rows (e.g. a crashed request) can be
 * re-claimed after `CLAIM_TTL_SECONDS`.
 */
export class SurrealIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: Surreal) {}

  async claim(scope: IdempotencyScope, key: string): Promise<ClaimResult> {
    const params = {
      merchant: recordIdOf(scope.merchantId),
      env: scope.environment,
      key,
    };
    try {
      await this.db.query(
        `INSERT INTO idempotency {
          merchant: $merchant,
          environment: $env,
          namespaced_key: $key,
          status: "in_progress",
          expires_at: time::now() + ${CLAIM_TTL_SECONDS}s,
          created_at: time::now()
        }`,
        params,
      );
      return "claimed";
    } catch {
      // Unique violation on (merchant, env, namespaced_key): inspect the row.
      const [rows] = await this.db
        .query(
          "SELECT * FROM idempotency WHERE merchant = $merchant AND environment = $env AND namespaced_key = $key LIMIT 1",
          params,
        )
        .collect<[Array<IdempotencyRow>]>();
      const row = rows?.[0];
      if (!row) return "conflict";
      if (row.status === "completed") return "replay";
      if (new Date(row.expires_at).getTime() > Date.now()) return "conflict";
      // Stale in-flight claim (crashed request) — re-claim it.
      await this.db.query(
        `UPDATE idempotency SET status = "in_progress", expires_at = time::now() + ${CLAIM_TTL_SECONDS}s
         WHERE merchant = $merchant AND environment = $env AND namespaced_key = $key`,
        params,
      );
      return "claimed";
    }
  }

  async commit(
    scope: IdempotencyScope,
    key: string,
    record: Omit<IdempotencyRecord, "namespacedKey">,
  ): Promise<void> {
    await this.db.query(
      `UPDATE idempotency SET
         status = "completed",
         response_status = $status,
         response_headers = $headers,
         response_body = $body
       WHERE merchant = $merchant AND environment = $env AND namespaced_key = $key`,
      {
        merchant: recordIdOf(scope.merchantId),
        env: scope.environment,
        key,
        status: record.status,
        headers: record.headers,
        body: record.body,
      },
    );
  }

  async get(scope: IdempotencyScope, key: string): Promise<IdempotencyRecord | undefined> {
    const [rows] = await this.db
      .query(
        "SELECT * FROM idempotency WHERE merchant = $merchant AND environment = $env AND namespaced_key = $key LIMIT 1",
        { merchant: recordIdOf(scope.merchantId), env: scope.environment, key },
      )
      .collect<[Array<IdempotencyRow>]>();
    const row = rows?.[0];
    if (!row || row.status !== "completed") return undefined;
    return {
      namespacedKey: row.namespaced_key,
      status: row.response_status ?? 200,
      headers: row.response_headers ?? {},
      body: row.response_body ?? "",
    };
  }
}

/**
 * In-memory store suitable as a reference double and for unit tests.
 * Mirrors the SurrealDB store's claim/commit/get contract.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly committed = new Map<string, IdempotencyRecord>();
  private readonly inFlight = new Map<string, number>();

  async claim(scope: IdempotencyScope, key: string): Promise<ClaimResult> {
    const fullKey = `${scope.merchantId}::${scope.environment}::${key}`;
    if (this.committed.has(fullKey)) return "replay";
    const deadline = this.inFlight.get(fullKey);
    if (deadline !== undefined && deadline > Date.now()) return "conflict";
    this.inFlight.set(fullKey, Date.now() + CLAIM_TTL_SECONDS * 1000);
    return "claimed";
  }

  async commit(
    scope: IdempotencyScope,
    key: string,
    record: Omit<IdempotencyRecord, "namespacedKey">,
  ): Promise<void> {
    const fullKey = `${scope.merchantId}::${scope.environment}::${key}`;
    this.inFlight.delete(fullKey);
    this.committed.set(fullKey, { ...record, namespacedKey: key });
  }

  async get(scope: IdempotencyScope, key: string): Promise<IdempotencyRecord | undefined> {
    const fullKey = `${scope.merchantId}::${scope.environment}::${key}`;
    return this.committed.get(fullKey);
  }
}

export { problem };
