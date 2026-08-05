import { describe, expect, it } from "bun:test";
import {
  ApiKeyError,
  generateKey,
  parseBearer,
  parseKey,
} from "../../src/core/apikey";

describe("generateKey", () => {
  it("produces keys matching the type_env_<40hex> format", () => {
    for (const type of ["sk", "pk"] as const) {
      for (const env of ["test", "live"] as const) {
        const key = generateKey(type, env);
        expect(key).toMatch(new RegExp(`^${type}_${env}_[0-9a-f]{40}$`));
      }
    }
  });

  it("is unique across calls", () => {
    expect(generateKey("sk", "test")).not.toBe(generateKey("sk", "test"));
  });
});

describe("parseKey", () => {
  it("derives env from the prefix", () => {
    expect(parseKey(generateKey("sk", "test")).env).toBe("test");
    expect(parseKey(generateKey("sk", "live")).env).toBe("live");
  });

  it("maps sk -> secret role with write scopes", () => {
    const key = parseKey(generateKey("sk", "test"));
    expect(key.role).toBe("secret");
    expect(key.scopes).toContain("payments:write");
  });

  it("maps pk -> publishable role with token scopes", () => {
    const key = parseKey(generateKey("pk", "live"));
    expect(key.role).toBe("publishable");
    expect(key.scopes).toEqual(["tokens:create"]);
  });
});

describe("parseBearer", () => {
  it("accepts a well-formed bearer header", () => {
    const key = parseBearer(`Bearer ${generateKey("sk", "test")}`);
    expect(key.env).toBe("test");
  });

  it("rejects a missing header", () => {
    expect(() => parseBearer(undefined)).toThrow(ApiKeyError);
    expect(() => parseBearer(undefined)).toThrow(/Missing Authorization/);
  });

  it("rejects a non-bearer scheme", () => {
    expect(() => parseBearer(`Token ${generateKey("sk", "test")}`)).toThrow(/must be "Bearer/);
  });

  it("rejects a malformed key", () => {
    expect(() => parseBearer("Bearer garbage")).toThrow(/malformed/);
    expect(() => parseBearer(`Bearer ${generateKey("sk", "test")} extra`)).toThrow(/must be "Bearer/);
  });
});