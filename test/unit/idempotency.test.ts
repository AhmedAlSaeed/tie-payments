import { describe, expect, it } from "bun:test";
import {
  CLAIM_TTL_SECONDS,
  InMemoryIdempotencyStore,
  namespaceIdempotencyKey,
} from "../../src/core/idempotency";

const scope = { merchantId: "merchant:1", environment: "test" as const };

describe("namespaceIdempotencyKey", () => {
  it("separates tenants, environments, and routes", () => {
    const base = ["merchant:1", "test", "/payments", "req-1"];
    expect(namespaceIdempotencyKey(...base)).not.toBe(
      namespaceIdempotencyKey("merchant:2", "test", "/payments", "req-1"),
    );
    expect(namespaceIdempotencyKey(...base)).not.toBe(
      namespaceIdempotencyKey("merchant:1", "live", "/payments", "req-1"),
    );
    expect(namespaceIdempotencyKey(...base)).not.toBe(
      namespaceIdempotencyKey("merchant:1", "test", "/invoices", "req-1"),
    );
    expect(namespaceIdempotencyKey(...base)).not.toBe(
      namespaceIdempotencyKey("merchant:1", "test", "/payments", "req-2"),
    );
  });

  it("is deterministic for the same inputs", () => {
    expect(namespaceIdempotencyKey("merchant:1", "test", "/payments", "req-1")).toBe(
      namespaceIdempotencyKey("merchant:1", "test", "/payments", "req-1"),
    );
  });
});

describe("InMemoryIdempotencyStore", () => {
  it("claims, commits, then replays", async () => {
    const store = new InMemoryIdempotencyStore();
    expect(await store.claim(scope, "a")).toBe("claimed");
    await store.commit(scope, "a", { status: 201, headers: {}, body: "{}" });

    expect(await store.claim(scope, "a")).toBe("replay");
    expect(await store.get(scope, "a")).toMatchObject({ namespacedKey: "a", status: 201 });
  });

  it("flags concurrent in-flight requests as conflicts", async () => {
    const store = new InMemoryIdempotencyStore();
    expect(await store.claim(scope, "a")).toBe("claimed");
    expect(await store.claim(scope, "a")).toBe("conflict");
  });

  it("re-claims a stale in-flight key after the TTL window", async () => {
    const store = new InMemoryIdempotencyStore();
    expect(await store.claim(scope, "a")).toBe("claimed");
    // Age the in-flight claim past its TTL (frozen now → treated as stale).
    const frozen = Date.now() - (CLAIM_TTL_SECONDS + 1) * 1000;
    store["inFlight"].set(`${scope.merchantId}::${scope.environment}::a`, frozen);
    expect(await store.claim(scope, "a")).toBe("claimed");
  });

  it("keeps keys scoped to their merchant and environment", async () => {
    const store = new InMemoryIdempotencyStore();
    await store.commit(scope, "a", { status: 201, headers: {}, body: "{}" });
    expect(await store.claim({ ...scope, merchantId: "merchant:2" }, "a")).toBe("claimed");
    expect(
      await store.claim({ ...scope, environment: "live" }, "a"),
    ).toBe("claimed");
  });
});
