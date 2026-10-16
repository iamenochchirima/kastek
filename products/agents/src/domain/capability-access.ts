import { projectEffectiveAccess, type EffectiveAccessProjection } from "./effective-access";

/**
 * Inputs owned by the product entitlement and provider-control surfaces.
 *
 * The Agent Platform deliberately does not invent subscription state. A
 * deployment can inject this source from the owning product service; until it
 * does, the fields remain unknown and the effective-access projection says so
 * explicitly.
 */
export type CapabilityAccessDependency = {
  registryRegistered?: boolean;
  entitled?: boolean;
  providerAvailability?: "available" | "not_configured" | "unhealthy";
  featureEnabled?: boolean;
};

export interface CapabilityAccessSource {
  getForCapabilities(input: {
    organizationId: string;
    capabilityNames: readonly string[];
  }): Promise<ReadonlyMap<string, CapabilityAccessDependency>>;
}

/** Safe default for installations that have not wired the owning product source yet. */
export class UnknownCapabilityAccessSource implements CapabilityAccessSource {
  public async getForCapabilities(input: { organizationId: string; capabilityNames: readonly string[] }): Promise<ReadonlyMap<string, CapabilityAccessDependency>> {
    void input;
    return new Map();
  }
}

/** Useful for contract tests and small deployments that have a static policy snapshot. */
export class StaticCapabilityAccessSource implements CapabilityAccessSource {
  private readonly values: ReadonlyMap<string, CapabilityAccessDependency>;

  public constructor(values: ReadonlyMap<string, CapabilityAccessDependency> | Record<string, CapabilityAccessDependency>) {
    this.values = values instanceof Map ? new Map(values) : new Map(Object.entries(values));
  }

  public async getForCapabilities(input: { organizationId: string; capabilityNames: readonly string[] }): Promise<ReadonlyMap<string, CapabilityAccessDependency>> {
    void input.organizationId;
    return new Map(input.capabilityNames.flatMap((name) => {
      const value = this.values.get(name);
      return value ? [[name, { ...value }] as const] : [];
    }));
  }
}

export function dependencyAvailability(
  dependency: CapabilityAccessDependency | undefined,
  manifestAvailability?: string,
): string | undefined {
  return dependency?.providerAvailability ?? manifestAvailability;
}

export function dependencyProjection(
  dependency: CapabilityAccessDependency | undefined,
  input: Omit<Parameters<typeof projectEffectiveAccess>[0], "availability" | "entitled" | "featureEnabled" | "registryRegistered">,
  manifestAvailability?: string,
): EffectiveAccessProjection {
  // Kept as a small adapter so every transport passes the same dependency
  // precedence: product-owned values override registry defaults, while absent
  // values remain unknown in the projection.
  return projectEffectiveAccess({
    ...input,
    availability: dependencyAvailability(dependency, manifestAvailability),
    entitled: dependency?.entitled,
    featureEnabled: dependency?.featureEnabled,
    registryRegistered: dependency?.registryRegistered,
  });
}
