import { describe, expect, it } from "bun:test";
import { problem, ProblemError } from "../../src/core/errors";

describe("problem factory", () => {
  it("builds a ProblemError with the mapped status", () => {
    const err = problem("invalid_api_key", "bad key");
    expect(err).toBeInstanceOf(ProblemError);
    expect(err.status).toBe(401);
    expect(err.code).toBe("invalid_api_key");
  });

  it("carries per-field errors when provided", () => {
    const err = problem("validation_error", "Invalid body", [
      { field: "amountMinor", message: "must be >= 1" },
    ]);
    expect(err.errors).toEqual([{ field: "amountMinor", message: "must be >= 1" }]);
  });
});

describe("ProblemError.toResponse", () => {
  it("emits the RFC 9457 envelope with application/problem+json", () => {
    const res = problem("rate_limited", "Slow down.").toResponse();
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    expect(res.json()).resolves.toMatchObject({
      type: "urn:tie:problem:rate_limited",
      title: "Too many requests",
      status: 429,
      detail: "Slow down.",
      code: "rate_limited",
    });
  });
});