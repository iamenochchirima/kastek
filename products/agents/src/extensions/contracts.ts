/**
 * Declarative extension contracts are intentionally independent from storage,
 * Temporal, and tool handlers. A caller supplies one pinned definition and
 * receives a resolved, immutable snapshot that can be attached to a run.
 */
export type ExtensionKind = "skill" | "plugin" | "connector" | "mcp_capability";

/**
 * Kinds accepted by an AgentSpec package selection. `mcp_adapter` is kept in
 * this type so the storage boundary can reject it explicitly until the
 * persisted extension model has a first-class representation for adapters.
 */
export type ExtensionPackageSelectionKind = ExtensionKind | "mcp_adapter";

/** The next admission gate that is not satisfied; `ready` means all gates passed. */
export type ExtensionReadinessState = "available" | "installed" | "configured" | "granted" | "ready";

export type ExtensionReadinessBlockerCode =
  | "not_available"
  | "not_installed"
  | "not_configured"
  | "not_granted"
  | "dependency_not_found"
  | "dependency_not_ready";

export interface ExtensionReadinessBlocker {
  code: ExtensionReadinessBlockerCode;
  dependency?: { kind: ExtensionKind; id: string };
}

export interface ExtensionReadiness {
  /**
   * The first gate that still needs to be satisfied. This deliberately uses
   * the same vocabulary for an unavailable declaration and a ready one.
   */
  state: ExtensionReadinessState;
  available: boolean;
  installed: boolean;
  configured: boolean;
  granted: boolean;
  ready: boolean;
  blockers: readonly ExtensionReadinessBlocker[];
}

/** Gates controlled by the declaration or its environment binding. */
export interface ExtensionDeclarationGates {
  available: boolean;
  installed: boolean;
  configured: boolean;
}

export interface ExtensionDeclarationBase extends ExtensionDeclarationGates {
  id: string;
  version: string;
  checksum: string;
  name?: string;
}

export interface SkillExtensionDeclaration extends ExtensionDeclarationBase {
  kind: "skill";
  requiredCapabilityIds?: readonly string[];
  requiredConnectorIds?: readonly string[];
}

/**
 * Plugins are declarative packages. They describe requirements and supplied
 * extension references; this contract never accepts executable plugin code.
 */
export interface PluginExtensionDeclaration extends ExtensionDeclarationBase {
  kind: "plugin";
  skillIds?: readonly string[];
  capabilityIds?: readonly string[];
  connectorIds?: readonly string[];
  mcpCapabilityIds?: readonly string[];
}

export interface ConnectorExtensionDeclaration extends ExtensionDeclarationBase {
  kind: "connector";
}

export interface McpCapabilityDeclaration extends ExtensionDeclarationBase {
  kind: "mcp_capability";
  providerId: string;
  toolName: string;
  requiredConnectorIds?: readonly string[];
}

export interface ExtensionGrantSnapshot {
  skillIds: readonly string[];
  pluginIds: readonly string[];
  connectorIds: readonly string[];
  capabilityIds: readonly string[];
}

/**
 * Immutable provenance for a package selected by the canonical AgentSpec.
 * The package row is the authority for identity and lifecycle; configuration
 * and permissions are the exact values selected by the version.
 */
export interface SelectedExtensionPackage {
  organizationId: string;
  packageVersionId: string;
  kind: ExtensionPackageSelectionKind;
  id: string;
  version: string;
  checksum: string;
  status: "published" | "deprecated";
  configuration: Readonly<Record<string, unknown>>;
  grantedPermissions: readonly string[];
}

export interface ExtensionResolverInput {
  agentVersionId: string;
  skills?: readonly SkillExtensionDeclaration[];
  plugins?: readonly PluginExtensionDeclaration[];
  connectors?: readonly ConnectorExtensionDeclaration[];
  mcpCapabilities?: readonly McpCapabilityDeclaration[];
  grants: ExtensionGrantSnapshot;
  selectedPackages?: readonly SelectedExtensionPackage[];
}

export interface ResolvedExtension<TDeclaration extends ExtensionDeclarationBase = ExtensionDeclarationBase> {
  kind: ExtensionKind;
  declaration: Readonly<TDeclaration>;
  readiness: Readonly<ExtensionReadiness>;
}

export interface ExtensionSnapshot {
  id: string;
  checksum: string;
  agentVersionId: string;
  skills: readonly ResolvedExtension<SkillExtensionDeclaration>[];
  plugins: readonly ResolvedExtension<PluginExtensionDeclaration>[];
  connectors: readonly ResolvedExtension<ConnectorExtensionDeclaration>[];
  mcpCapabilities: readonly ResolvedExtension<McpCapabilityDeclaration>[];
  selectedPackages?: readonly SelectedExtensionPackage[];
}
