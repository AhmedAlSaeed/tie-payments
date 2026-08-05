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
 * Persistence lands in the SurrealDB layer (T001). Here we ship the interface
 * plus an in-memory store so the API surface + one endpoint run end-to-end.
 * The IdempotencyStore contract IS the durable seam to be implemented later.
 */
import { problem } from "./errors";

export interface IdempotencyRecord {
  /** Namespaced key: `hash(merchantId::env::route::key)`. */
  namespacedKey: string;
  /** Awaiting the request's thread to set these once it succeeds. */
  status: number;
  headers: Record<string, string>;
  body: string;
}

export type ClaimResult = "claimed" | "replay" | "conflict";

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
  claim(key: string): "claimed" | "replay" | "conflict";
  /** Persist the result of a claim we owned. */
  commit(key: string, record: Omit<IdempotencyRecord, "namespacedKey">): void;
  /** Read a previously committed record (after 'replay'). */
  get(key: string): IdempotencyRecord | undefined;
}

/**
 * In-memory store suitable for the prototype + single-process dev.
 * Replace `claim`/`commit` with SurrealDB UNIQUE + outbox-in-transaction (T001).
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly committed = new Map<string, IdempotencyRecord>();
  private readonly inFlight = new Set<string>();

  claim(key: string): "claimed" | "replay" | "conflict" {
    if (this.committed.has(key)) return "replay";
    if (this.inFlight.has(key)) return "conflict";
    this.inFlight.add(key);
    return "claimed";
  }

  commit(key: string, record: Omit<IdempotencyRecord, "namespacedKey">): void {
    this.inFlight.delete(key);
    this.committed.set(key, { ...record, namespacedKey: key });
  }

  get(key: string): IdempotencyRecord | undefined {
    return this.committed.get(key);
  }
}

export { problem };
