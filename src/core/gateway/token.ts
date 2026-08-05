/**
 * Cross-gateway token mapping (SPEC Pillar 1).
 *
 * A *unified* token `tok_…` is the platform's one token a merchant stores. A
 * unified token may carry multiple gateway-specific tokens (tap_…, stripe_…),
 * so a single customer payment method works across every routed gateway.
 * `mapping` is a driverId → gateway-token field; the routing service picks the
 * right one when dispatching to that driver.
 *
 * This lives in-memory in the prototype; a durable store (T001 / TokenMapping
 * store) will persist it keyed by the unified token id.
 */
export interface GatewayToken {
  driverId: string;
  /** The driver-scoped token (e.g. Stripe `tok_…`, Tap `src_…`). */
  token: string;
  /** Optional: last-4 for card display / the mock's scenario classification. */
  last4?: string;
}

export interface UnifiedToken {
  /** Stable id merchants reference, `tok_<ulid>`. */
  id: string;
  /** Driver id the token was originally created with. */
  primaryDriver: string;
  /** Gateway-scoped tokens per driver. */
  mapping: GatewayToken[];
  /** When it was created (ISO-8601). */
  createdAt: string;
}

/** Attach or refresh a gateway token on a unified token. */
export function upsertGatewayToken(
  token: UnifiedToken,
  driverId: string,
  gatewayToken: Omit<GatewayToken, "driverId">,
): UnifiedToken {
  const other = token.mapping.filter((m) => m.driverId !== driverId);
  return { ...token, mapping: [...other, { driverId, ...gatewayToken }] };
}

/** Look up the gateway-scoped token for a driver id (undefined if not held). */
export function tokenForDriver(token: UnifiedToken, driverId: string): GatewayToken | undefined {
  return token.mapping.find((m) => m.driverId === driverId);
}
