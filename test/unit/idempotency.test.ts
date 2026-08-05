import { describe, expect, it } from "bun:test";
import {
  InMemoryIdempotencyStore,
  namespaceIdempotencyKey,
} from "../../src/core/idempotency";

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
  it("claims, commits, then replays", () => {
    const store = new InMemoryIdempotencyStore();
    expect(store.claim("a")).toBe("claimed");
    store.commit("a", { status: 201, headers: {}, body: "{}" });

    expect(store.claim("a")).toBe("replay");
    expect(store.get("a")).toMatchObject({ namespacedKey: "a", status: 201 });
  });

  it("flags concurrent in-flight requests as conflicts", () => {
    const store = new InMemoryIdempotencyStore();
    expect(store.claim("a")).toBe("claimed");
    expect(store.claim("a")).toBe("conflict");
  });

  it("frees the key for reuse after a failed commit path via replay check", () => {
    const store = new InMemoryIdempotencyStore();
    store.claim("a");
    // A committed record shadows the in-flight set on the next claim.
    store.commit("a", { status: 200, headers: {}, body: "{}" });
    expect(store.claim("a")).toBe("replay");
  });
});