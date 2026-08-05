/**
 * Driver registry (Pillar 1) — the assembly point where driver instances are
 * registered and looked up. Keeps modules decoupled from any concrete driver.
 *
 * In production the registry is populated at boot (or from DB-backed merchant
 * gateway config); in the sandbox it ships pre-registered with the mock.
 */
import type { GatewayDriver } from "./driver";

export class GatewayRegistry {
  private readonly drivers = new Map<string, GatewayDriver>();

  register(driver: GatewayDriver): this {
    this.drivers.set(driver.id, driver);
    return this;
  }

  /** The default driver for a given environment (mock for sandbox). */
  defaultFor(environment: "test" | "live"): GatewayDriver | undefined {
    // Sandbox defaults to mock; live has no default until a driver is configured.
    return environment === "test" ? this.drivers.get("mock") : undefined;
  }

  get(id: string): GatewayDriver | undefined {
    return this.drivers.get(id);
  }

  list(): GatewayDriver[] {
    return [...this.drivers.values()];
  }

  size(): number {
    return this.drivers.size;
  }
}

/** A global registry preloaded with the mock driver (single-process dev). */
export const defaultRegistry = new GatewayRegistry();
