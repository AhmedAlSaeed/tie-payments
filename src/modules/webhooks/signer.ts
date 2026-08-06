/**
 * Webhook payload signing (T07 D3) — Svix/Stripe scheme.
 *
 * The raw body is HMAC-SHA256 signed with the endpoint's secret over
 * `<unix-seconds>.<body>`. The endpoint secret is never sent anywhere — it is
 * minted on endpoint creation, returned once, then masked. On delivery the
 * drainer attaches two headers:
 *   tie-timestamp: <unix seconds>
 *   tie-signature: t=<ts>,v1=<hex>
 * A merchant verifies by recomputing the HMAC over `ts.body` and by checking
 * the timestamp is within a tolerance window (anti-replay).
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export const TIMESTAMP_HEADER = "tie-timestamp";
export const SIGNATURE_HEADER = "tie-signature";

/** HMAC-SHA256 hex digest of `data` keyed with `secret`. */
export function hmacHex(secret: string, data: string): string {
  return createHmac("sha256", String(secret)).update(data).digest("hex");
}

export interface SignedHeaders {
  "tie-timestamp": string;
  "tie-signature": string;
}

/**
 * Sign `body` with `secret`. `timestampOverride` lets tests pin the timestamp
 * for determinism; production derives it from the current wall clock.
 */
export function signPayload(
  secret: string,
  body: string,
  timestampOverride?: string,
): { timestamp: string; signature: string; headers: SignedHeaders } {
  const timestamp = timestampOverride ?? Math.floor(Date.now() / 1000).toString(10);
  const digest = hmacHex(secret, `${timestamp}.${body}`);
  const signature = `t=${timestamp},v1=${digest}`;
  return {
    timestamp,
    signature,
    headers: {
      "tie-timestamp": timestamp,
      "tie-signature": signature,
    },
  };
}

/** Pull the `v1=<hex>` value out of a `t=<ts>,v1=<hex>` header. */
export function parseSignatureV1(signature: string): string | undefined {
  const v1 = String(signature)
    .split(",")
    .find((part) => part.startsWith("v1="));
  return v1 ? v1.slice(3) : undefined;
}

/**
 * Verify a signed delivery. Returns true iff the `v1` digest in `signature`
 * equals the recomputed HMAC over `<timestamp>.<body>` AND the timestamp is
 * within `toleranceSeconds` of now (Stamp/T7 anti-replay).
 */
export function verifySignature(
  secret: string,
  body: string,
  timestamp: string,
  signature: string,
  toleranceSeconds = 300,
): boolean {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > toleranceSeconds) return false;

  const provided = parseSignatureV1(signature);
  if (!provided) return false;
  const expected = hmacHex(secret, `${String(ts)}.${body}`);

  const a = Buffer.from(provided, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
