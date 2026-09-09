import type { ExtensionConfigurationSchema } from "./package-manifest";

export const PLUGIN_ADAPTER_PROTOCOL_VERSION = 1 as const;

export type PluginAdapterExecutionMode = "native_capability" | "isolated_plugin";
export type PluginAdapterReadinessState = "ready" | "blocked";
export type PluginAdapterCredentialState = "configured" | "missing" | "revoked" | "unknown";

export interface PluginAdapterIdentity {
  pluginId: string;
  version: string;
  checksum: string;
  protocolVersion: typeof PLUGIN_ADAPTER_PROTOCOL_VERSION;
}

export interface PluginAdapterReadinessContext {
  configuration: Readonly<Record<string, unknown>>;
  credentials: Readonly<Record<string, PluginAdapterCredentialState>>;
  disabled?: boolean;
}

export interface PluginAdapterReadinessResult {
  state: PluginAdapterReadinessState;
  blockers: readonly string[];
}

export interface PluginAdapterHealthContext {
  probe: (capabilityId: string) => Promise<void>;
}

export interface PluginAdapterHealthResult {
  status: "healthy" | "unhealthy";
  code?: string;
}

export interface PluginAdapterInvocationContext {
  capabilityId: string;
  input: unknown;
  invokeCapability: (capabilityId: string, input: unknown) => Promise<unknown>;
}

export interface PluginAdapter {
  readonly identity: PluginAdapterIdentity;
  readonly executionMode: PluginAdapterExecutionMode;
  readonly capabilityIds: readonly string[];
  readonly connectorIds: readonly string[];
  readonly requiredCredentialRefs: readonly string[];
  readonly configurationSchema?: ExtensionConfigurationSchema;
  readonly checkReadiness: (context: PluginAdapterReadinessContext) => PluginAdapterReadinessResult;
  readonly checkHealth: (context: PluginAdapterHealthContext) => Promise<PluginAdapterHealthResult>;
  readonly invoke: (context: PluginAdapterInvocationContext) => Promise<unknown>;
}

type AdapterCatalogIdentity = {
  id: string;
  version: string;
  checksum: string;
};

function adapterKey(identity: AdapterCatalogIdentity): string {
  return `${identity.id}:${identity.version}:${identity.checksum.toLowerCase()}`;
}

function nativeReadiness(context: PluginAdapterReadinessContext, credentialRef: string): PluginAdapterReadinessResult {
  if (context.disabled) return { state: "blocked", blockers: ["disabled"] };
  if (!credentialRef) return { state: "ready", blockers: [] };
  const credential = context.credentials[credentialRef] ?? "unknown";
  if (credential === "missing") return { state: "blocked", blockers: ["credential_missing"] };
  if (credential === "revoked") return { state: "blocked", blockers: ["credential_revoked"] };
  if (credential === "unknown") return { state: "blocked", blockers: ["credential_state_unknown"] };
  return { state: "ready", blockers: [] };
}

function createNativeCapabilityAdapter(input: {
  identity: Omit<PluginAdapterIdentity, "protocolVersion">;
  capabilityIds: readonly string[];
  connectorIds: readonly string[];
  requiredCredentialRefs: readonly string[];
}): PluginAdapter {
  const capabilityIds = Object.freeze([...input.capabilityIds]);
  const connectorIds = Object.freeze([...input.connectorIds]);
  const requiredCredentialRefs = Object.freeze([...input.requiredCredentialRefs]);
  return Object.freeze({
    identity: Object.freeze({ ...input.identity, protocolVersion: PLUGIN_ADAPTER_PROTOCOL_VERSION }),
    executionMode: "native_capability" as const,
    capabilityIds,
    connectorIds,
    requiredCredentialRefs,
    configurationSchema: Object.freeze({ type: "object" as const, properties: Object.freeze({}), additionalProperties: false }),
    checkReadiness: (context: PluginAdapterReadinessContext) => nativeReadiness(context, requiredCredentialRefs[0] ?? ""),
    checkHealth: async (context: PluginAdapterHealthContext): Promise<PluginAdapterHealthResult> => {
      try {
        for (const capabilityId of capabilityIds) await context.probe(capabilityId);
        return { status: "healthy" };
      } catch {
        return { status: "unhealthy", code: "capability_probe_failed" };
      }
    },
    invoke: ({ capabilityId, input: invocationInput, invokeCapability }: PluginAdapterInvocationContext) => {
      if (!capabilityIds.includes(capabilityId)) {
        return Promise.reject(new Error("PLUGIN_ADAPTER_CAPABILITY_UNSUPPORTED"));
      }
      return invokeCapability(capabilityId, invocationInput);
    },
  });
}

/**
 * Native adapters are deliberately registered in code, not inferred from the
 * reviewed catalogue. Each entry must pin the exact reviewed artifact it can
 * safely expose through KasiTek's own capability surface.
 */
export const REGISTERED_PLUGIN_ADAPTERS: readonly PluginAdapter[] = Object.freeze([
  createNativeCapabilityAdapter({
    identity: {
      pluginId: "hermes.plugin.web.tavily",
      version: "1.0.0",
      checksum: "1cc7c2e133b0a9ca45c43816bfa0c109da308a7e988999021dff38787372a6cb",
    },
    capabilityIds: ["kasitek.web.search"],
    connectorIds: ["tavily.search"],
    requiredCredentialRefs: ["tavily.search"],
  }),
]);

const ADAPTERS_BY_KEY = new Map(REGISTERED_PLUGIN_ADAPTERS.map((adapter) => [adapterKey({
  id: adapter.identity.pluginId,
  version: adapter.identity.version,
  checksum: adapter.identity.checksum,
}), adapter]));

export function getPluginAdapter(identity: AdapterCatalogIdentity): PluginAdapter | undefined {
  return ADAPTERS_BY_KEY.get(adapterKey(identity));
}

export function getPluginAdapterStatus(identity: AdapterCatalogIdentity): "metadata_only" | "supported" {
  return getPluginAdapter(identity) ? "supported" : "metadata_only";
}

export function listPluginAdapters(): readonly PluginAdapter[] {
  return REGISTERED_PLUGIN_ADAPTERS;
}
