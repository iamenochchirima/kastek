import type { Pool } from "pg";
import { PlatformError, connectedToolAuthorityIds, type AgentConfiguration } from "../../contracts/contracts";
import { capabilityBindingSchema, type CapabilityBinding } from "../../contracts/capability-catalog";

export interface ServiceReadinessPorts {
  pool: Pool;
  documentRuntime?: { available(embeddingRelease: string): Promise<boolean> };
  connected?: { assertAvailable(bindings: readonly CapabilityBinding[]): void };
  objects?: unknown;
  actionServices?: unknown;
  sandbox?: { available(): Promise<boolean> };
  assertDependencies(bindings: readonly CapabilityBinding[]): void;
}

/** Configuration bindings and optional services required before an agent can run. */
export function createServiceReadiness(options: ServiceReadinessPorts) {
  async function assertBindings(configuration: AgentConfiguration): Promise<void> {
    if (configuration.retrievalProfile.kind === "hybrid-v1" &&
        (!options.documentRuntime || !await options.documentRuntime.available(configuration.retrievalProfile.embeddingRelease))) {
      throw new PlatformError("RETRIEVAL_BACKEND_UNAVAILABLE", 503, "The selected semantic search profile is unavailable");
    }
    const connectedAuthority = connectedToolAuthorityIds(configuration);
    if (connectedAuthority.length) {
      if (!options.connected) throw new PlatformError("CONNECTED_TOOLS_UNAVAILABLE", 503, "Connected tools are unavailable");
      const rows = (await options.pool.query("SELECT binding FROM agents_platform.capability_bindings WHERE id=ANY($1::uuid[])", [connectedAuthority])).rows;
      if (rows.length !== connectedAuthority.length) throw new PlatformError("ADAPTER_RELEASE_UNAVAILABLE", 503, "A selected tool binding is unavailable");
      const bindings = rows.map(row => capabilityBindingSchema.parse(row.binding));
      options.assertDependencies(bindings.filter(binding => configuration.connectedToolBindingIds.includes(binding.id)));
      options.connected.assertAvailable(bindings);
    }
  }

  async function assertServices(configuration: AgentConfiguration): Promise<void> {
    await assertBindings(configuration);
    if ((configuration.capabilities.sandbox.enabled || configuration.capabilities.workflows.enabled) && !options.objects)
      throw new PlatformError("OBJECT_STORE_UNAVAILABLE", 503, "Private storage is unavailable");
    if (configuration.capabilities.workflows.enabled && !options.actionServices)
      throw new PlatformError("ACTIONS_UNAVAILABLE", 503, "Report delivery is unavailable");
    if (configuration.capabilities.sandbox.enabled && (!options.sandbox || !await options.sandbox.available()))
      throw new PlatformError("SANDBOX_UNAVAILABLE", 503, "Analysis is unavailable");
  }

  return { assertBindings, assertServices };
}
