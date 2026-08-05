import { describe, expect, it } from "bun:test";
import { MockGatewayDriver } from "../../src/core/gateway/mock";
import { GatewayError, GatewayRegistry } from "../../src/core/gateway";
import { matchRule, defaultSandboxRules, resolveDriver } from "../../src/core/gateway/routing";

const money = (amountMinor: number, currency: string) => ({ amountMinor, currency });
const base = {
  amountMinor: 100,
  currency: "BHD",
  environment: "test" as const,
  captureMode: "automatic" as const,
};

describe("MockGatewayDriver (SPEC 4.3 matrix)", () => {
  const driver = new MockGatewayDriver();

  it("succeeds for a card ending in 4242", async () => {
    const r = await driver.createPayment({ ...base, method: "tok_mock_4242" }, money(100, "BHD"));
    expect(r.status).toBe("succeeded");
    expect(r.action.kind).toBe("none");
    expect(r.authorizedAmountMinor).toBe(100);
  });

  it("declines a card ending in 0002 with a non-retryable error", async () => {
    await expect(
      driver.createPayment({ ...base, method: "tok_mock_0002" }, money(100, "BHD")),
    ).rejects.toMatchObject({ code: "card_declined", retryable: false });
  });

  it("throws a retryable processing_error for a 9999 timeout", async () => {
    await expect(
      driver.createPayment({ ...base, method: "tok_mock_9999" }, money(100, "BHD")),
    ).rejects.toMatchObject({ code: "processing_error", retryable: true });
  });

  it("returns requires_action + redirect for a 3D01 3DS challenge", async () => {
    const r = await driver.createPayment({ ...base, method: "tok_mock_3d01" }, money(100, "BHD"));
    expect(r.status).toBe("requires_action");
    expect(r.action.kind).toBe("redirect");
  });

  it("returns a QR action for BenefitPay-style QR methods", async () => {
    const r = await driver.createPayment({ ...base, method: "qr_fawri" }, money(100, "BHD"));
    expect(r.status).toBe("requires_action");
    expect(r.action.kind).toBe("qr");
  });

  it("honors the currency exponent (BHD minor units pass through)", async () => {
    const r = await driver.createPayment(
      { ...base, amountMinor: 250, currency: "BHD", method: "tok_mock_4242" },
      money(250, "BHD"),
    );
    expect(r.authorizedAmountMinor).toBe(250);
  });

  it("tokenize produces a mock token with the PAN last-4", async () => {
    const { token } = await driver.tokenize({
      environment: "test",
      type: "card",
      payload: { pan: "4000056655665556", expMonth: 12, expYear: 2030 },
    });
    expect(token).toMatch(/^tok_mock_5556_/);
  });
});

describe("GatewayRegistry", () => {
  it("defaults the sandbox to the mock driver", () => {
    const reg = new GatewayRegistry().register(new MockGatewayDriver());
    expect(reg.defaultFor("test")?.id).toBe("mock");
    expect(reg.defaultFor("live")).toBeUndefined();
  });

  it("returns undefined for an unknown driver", () => {
    expect(new GatewayRegistry().get("nope")).toBeUndefined();
  });
});

describe("routing", () => {
  it("routes sandbox to mock via the default rule set", () => {
    const id = matchRule(defaultSandboxRules, {
      environment: "test",
      currency: "BHD",
      amountMinor: 100,
      drivers: [],
    });
    expect(id).toBe("mock");
  });

  it("matches on currency and respects rule order", () => {
    const rules = [
      { id: "bhd-tap", if: { currency: ["BHD"] }, driver: "tap" },
      { id: "fallback-mock", if: {}, driver: "mock" },
    ];
    expect(
      matchRule(rules, { environment: "test", currency: "BHD", amountMinor: 1, drivers: [] }),
    ).toBe("tap");
    expect(
      matchRule(rules, { environment: "test", currency: "USD", amountMinor: 1, drivers: [] }),
    ).toBe("mock");
  });

  it("resolveDriver finds a driver by id in a registry", () => {
    const reg = new GatewayRegistry().register(new MockGatewayDriver());
    expect(resolveDriver("mock", reg)?.id).toBe("mock");
  });

  it("GatewayError is an Error with normalized fields", () => {
    const e = new GatewayError("insufficient_funds", "nope", { providerCode: "51" });
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("insufficient_funds");
    expect(e.retryable).toBe(false);
    expect(e.providerCode).toBe("51");
  });
});
