/**
 * Gateway abstraction (Pillar 1) — public surface.
 *
 * Modules (payments, invoicing, webhooks) depend on *this kernel*, never on a
 * driver directly. Re-export types + the registry + routing + token helpers so
 * callers import from one place.
 */
export * from "./types";
export * from "./driver";
export * from "./registry";
export * from "./routing";
export * from "./token";
export { MockGatewayDriver } from "./mock";
