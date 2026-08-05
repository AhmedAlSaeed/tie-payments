/**
 * Smart rotation (routing) model (SPEC Pillar 1 "Rule Engine" + map "not yet
 * specified" smart-routing).
 *
 * A rule selects a driver from an eval context — currency, card type/BIN,
 * amount, or explicit driver. Rules are ordered; the first whose selector
 * matches wins. This is a bare-bones, dependency-free expression model:
 * no DSL, no interpreter dependency — just a serialisable selector that a
 * merchant config can persist and the routing service evaluates.
 */
import type { GatewayDriver } from "./driver";

/** Inputs the routing service can branch on (SPEC 1.1). */
export interface RoutingContext {
  currency: string;
  amountMinor: number;
  method?: string; // unified token, e.g. card_4242
  environment: "test" | "live";
  /** Driver id explicitly preferred by the merchant, if any. */
  preferredDriver?: string;
  /** Ordered list of known drivers (failover chain). */
  drivers: GatewayDriver[];
}

/** A routing rule body. `if` (all must match) → `then` driver id. */
export interface RoutingRule {
  id: string;
  /** Conditions on the context; empty object = match-all (catch-all rule). */
  if: {
    currency?: string[];
    methodPrefix?: string; // e.g. "card"
    amountMinorMax?: number;
    preferredDriver?: string;
  };
  /** Driver id to route to when matched. */
  driver: string;
  /** If the chosen driver errors, try the next matching rule (failover). */
  failover?: boolean;
  /** Human description for admin/logs. */
  description?: string;
}

/**
 * Evaluate a rule set against a context. Returns the first matched `then`
 * driver id, or undefined if nothing matches. Rules are evaluated in the
 * order they appear (caller controls precedence by ordering the array).
 */
export function matchRule(rules: RoutingRule[], ctx: RoutingContext): string | undefined {
  for (const rule of rules) {
    const cond = rule.if;
    if (cond.currency && !cond.currency.includes(ctx.currency)) continue;
    if (cond.methodPrefix && !ctx.method?.toLowerCase().startsWith(cond.methodPrefix.toLowerCase()))
      continue;
    if (cond.amountMinorMax !== undefined && ctx.amountMinor > cond.amountMinorMax) continue;
    if (cond.preferredDriver && cond.preferredDriver !== ctx.preferredDriver) continue;
    return rule.driver;
  }
  return ctx.preferredDriver;
}

/** Resolve a driver id to an instance from given drivers. */
export function resolveDriver(
  id: string,
  source: { list(): GatewayDriver[] } | GatewayDriver[],
): GatewayDriver | undefined {
  const drivers = Array.isArray(source) ? source : source.list();
  return drivers.find((d) => d.id === id);
}

/** Default sandbox rules: always the mock driver. */
export const defaultSandboxRules: RoutingRule[] = [
  {
    id: "sandbox-always-mock",
    if: {},
    driver: "mock",
    failover: false,
    description: "Sandbox routes everything to the Mock Gateway.",
  },
];
