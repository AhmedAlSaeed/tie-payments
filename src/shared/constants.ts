/**
 * Shared domain constants and scalar types for the tie-payments kernel.
 * This module has no pillar (module/) dependencies — it is the shared kernel.
 */

/** RFC 4217 money type. SurrealDB stores money as `decimal`; always carry exponent. */
export interface Money {
  /** Raw value in minor units (BHD: 1000 fils; USD: 100 cents). */
  amountMinor: number;
  /** ISO-4217 currency code, uppercased. */
  currency: "BHD" | "USD" | "SAR" | "AED" | "KWD" | "QAR" | "OMR";
}

/** Currency exponent map: how many minor units make one major unit. */
export const CURRENCY_EXPONENT: Record<Money["currency"], number> = {
  BHD: 3, // Bahrain — 1000 fils per dinar
  KWD: 3,
  USD: 2,
  SAR: 2,
  AED: 2,
  QAR: 2,
  OMR: 2,
};

/** Sandbox vs live environment. Always derived from the API key prefix, never from the body. */
export type Environment = "test" | "live";
export const ENVIRONMENTS: readonly Environment[] = ["test", "live"] as const;
