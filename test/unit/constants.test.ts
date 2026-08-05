import { describe, expect, it } from "bun:test";
import { CURRENCY_EXPONENT, ENVIRONMENTS } from "../../src/shared/constants";

describe("CURRENCY_EXPONENT", () => {
  it("uses 3 minor units for the Gulf dinar currencies", () => {
    expect(CURRENCY_EXPONENT.BHD).toBe(3);
    expect(CURRENCY_EXPONENT.KWD).toBe(3);
  });

  it("uses 2 minor units for the rest", () => {
    for (const currency of ["USD", "SAR", "AED", "QAR", "OMR"] as const) {
      expect(CURRENCY_EXPONENT[currency]).toBe(2);
    }
  });

  it("covers every supported currency", () => {
    const supported = new Set([
      "BHD",
      "KWD",
      "USD",
      "SAR",
      "AED",
      "QAR",
      "OMR",
    ]);
    expect(Object.keys(CURRENCY_EXPONENT).length).toBe(supported.size);
    for (const key of Object.keys(CURRENCY_EXPONENT)) {
      expect(supported.has(key)).toBe(true);
    }
  });
});

describe("ENVIRONMENTS", () => {
  it("only allows test and live", () => {
    expect(ENVIRONMENTS).toEqual(["test", "live"]);
  });
});