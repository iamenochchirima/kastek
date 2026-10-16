import type { CapabilityCatalog, CapabilityDescriptor, CapabilitySource, CapabilityToolsetDescriptor } from "./catalog";

export interface CapabilityIntegrationSource {
  id: string;
  version?: string;
  name: string;
  description: string;
  category: string;
  logo?: string;
  capabilityNames?: readonly string[];
  requiredScopes?: readonly string[];
  auth?: string;
  kind?: "tool" | "channel";
  runtime?: string;
}

export interface CapabilitySkillSource {
  id: string;
  version: string | number;
  name: string;
  description?: string | null;
  checksum: string;
  requiredCapabilities?: readonly string[];
  requiredConnectors?: readonly string[];
}

export interface CapabilityPluginSource {
  id: string;
  version: string;
  checksum: string;
  name?: string | null;
  description?: string | null;
  permissions?: readonly string[];
  capabilityIds?: readonly string[];
}

export interface CapabilityMcpToolSource {
  name: string;
  description?: string;
}

export interface CapabilityMcpServerSource {
  id: string;
  providerId: string;
  providerName: string;
  version: string | number;
  checksum: string;
  protocolVersion: string;
  tools: readonly CapabilityMcpToolSource[];
  timeoutMs?: number;
  credentialConfigured?: boolean;
}

export interface CapabilityUserToolSource {
  id: string;
  version: string;
  name: string;
  description: string;
  category?: string;
  logo?: string;
  checksum: string;
  requiredScopes?: readonly string[];
  credentialRequirements?: readonly string[];
}

function source(kind: CapabilitySource["kind"], id: string, version: string, checksum: string, trust: CapabilitySource["trust"]): CapabilitySource {
  return { kind, id, version, checksum, trust };
}

function addToolset(catalog: CapabilityCatalog, input: CapabilityToolsetDescriptor): void {
  if (!catalog.listToolsets().some((toolset) => toolset.id === input.id && toolset.version === input.version)) {
    catalog.registerToolset(input);
  }
}

/** Projects the product-owned connector directory into the shared capability catalog. */
export function registerIntegrationSources(
  catalog: CapabilityCatalog,
  entries: readonly CapabilityIntegrationSource[],
  registeredCapabilityIds: ReadonlySet<string> = new Set(),
): void {
  for (const entry of entries) {
    const version = entry.version ?? "1.0.0";
    const descriptorId = `connector.${entry.id}`;
    const connectorSource = source("connector", entry.id, version, `catalog:${entry.id}@${version}`, "platform");
    const capabilityIds = (entry.capabilityNames ?? []).filter((name) => registeredCapabilityIds.has(name));
    catalog.register({
      id: descriptorId,
      version,
      kind: "connector",
      name: entry.name,
      description: entry.description,
      category: entry.category,
      ...(entry.logo ? { logo: entry.logo } : {}),
      tags: ["connector", entry.kind ?? "tool", entry.runtime ?? "managed"],
      source: connectorSource,
      provider: { id: entry.id, name: entry.name, version },
      toolsetIds: [`connector.${entry.id}`],
      runtime: {
        execution: "declarative",
        requiredScopes: entry.requiredScopes ?? [],
        credentialRequirements: entry.auth && entry.auth !== "internal" && entry.auth !== "observability" ? [entry.auth] : [],
      },
    });
    addToolset(catalog, {
      id: `connector.${entry.id}`,
      version,
      name: entry.name,
      description: `${entry.name} connector capabilities`,
      source: connectorSource,
      capabilityIds,
      includes: [],
    });
  }
}

/** Projects published skill versions without loading their instruction bodies into a prompt. */
export function registerSkillSources(catalog: CapabilityCatalog, skills: readonly CapabilitySkillSource[]): void {
  for (const skill of skills) {
    const version = typeof skill.version === "number" ? `${skill.version}.0.0` : skill.version;
    const skillSource = source("skill", skill.id, version, skill.checksum, "organization");
    catalog.register({
      id: `skill.${skill.id}`,
      version,
      kind: "skill",
      name: skill.name,
      description: skill.description?.trim() || `Skill ${skill.name}`,
      category: "skills",
      tags: ["skill", ...(skill.requiredConnectors ?? []).map((connector) => `connector:${connector}`)],
      source: skillSource,
      provider: { id: skill.id, name: skill.name, version },
      toolsetIds: [`skill.${skill.id}`],
      runtime: {
        execution: "declarative",
        requiredScopes: skill.requiredCapabilities ?? [],
        credentialRequirements: skill.requiredConnectors ?? [],
      },
    });
    addToolset(catalog, {
      id: `skill.${skill.id}`,
      version,
      name: skill.name,
      description: `${skill.name} skill`,
      source: skillSource,
      capabilityIds: skill.requiredCapabilities ?? [],
      includes: [],
    });
  }
}

/** Projects plugin packages as packages; executable plugin tools remain separately registered. */
export function registerPluginSources(catalog: CapabilityCatalog, plugins: readonly CapabilityPluginSource[]): void {
  for (const plugin of plugins) {
    const pluginSource = source("plugin", plugin.id, plugin.version, plugin.checksum, "organization");
    catalog.register({
      id: `plugin.${plugin.id}`,
      version: plugin.version,
      kind: "plugin",
      name: plugin.name?.trim() || plugin.id,
      description: plugin.description?.trim() || `Plugin ${plugin.id}`,
      category: "plugins",
      tags: ["plugin"],
      source: pluginSource,
      provider: { id: plugin.id, name: plugin.name?.trim() || plugin.id, version: plugin.version },
      toolsetIds: [`plugin.${plugin.id}`],
      runtime: {
        execution: "plugin",
        requiredScopes: plugin.permissions ?? [],
        credentialRequirements: [],
      },
    });
    addToolset(catalog, {
      id: `plugin.${plugin.id}`,
      version: plugin.version,
      name: plugin.name?.trim() || plugin.id,
      description: `${plugin.name?.trim() || plugin.id} plugin capabilities`,
      source: pluginSource,
      capabilityIds: plugin.capabilityIds ?? [],
      includes: [],
    });
  }
}

/** Projects a pinned/discovered MCP revision and its immutable tool schemas into discovery. */
export function registerMcpSources(catalog: CapabilityCatalog, servers: readonly CapabilityMcpServerSource[]): void {
  for (const server of servers) {
    const version = typeof server.version === "number" ? `${server.version}.0.0` : server.version;
    const serverSource = source("mcp", server.id, version, server.checksum, "organization");
    const toolIds = server.tools.map((tool) => `remote_mcp.${server.id}.${tool.name}`);
    catalog.register({
      id: `mcp.${server.id}`,
      version,
      kind: "mcp_server",
      name: server.providerName,
      description: `MCP server ${server.providerName} (${server.protocolVersion})`,
      category: "mcp",
      tags: ["mcp", server.protocolVersion],
      source: serverSource,
      provider: { id: server.providerId, name: server.providerName, version },
      toolsetIds: [`mcp.${server.id}`],
      runtime: {
        execution: "mcp",
        timeoutMs: server.timeoutMs,
        requiredScopes: ["mcp:remote"],
        credentialRequirements: server.credentialConfigured ? ["mcp.remote"] : [],
      },
    });
    for (const tool of server.tools) {
      catalog.register({
        id: `remote_mcp.${server.id}.${tool.name}`,
        version,
        kind: "mcp_tool",
        name: tool.name,
        description: tool.description?.trim() || `MCP tool ${tool.name}`,
        category: "mcp",
        tags: ["mcp", "tool"],
        source: serverSource,
        provider: { id: server.providerId, name: server.providerName, version },
        toolsetIds: [`mcp.${server.id}`],
        runtime: {
          execution: "mcp",
          timeoutMs: server.timeoutMs,
          requiredScopes: ["mcp:remote"],
          credentialRequirements: server.credentialConfigured ? ["mcp.remote"] : [],
        },
      });
    }
    addToolset(catalog, {
      id: `mcp.${server.id}`,
      version,
      name: server.providerName,
      description: `${server.providerName} MCP tools`,
      source: serverSource,
      capabilityIds: toolIds,
      includes: [],
    });
  }
}

export function registerUserToolSource(catalog: CapabilityCatalog, tool: CapabilityUserToolSource): CapabilityDescriptor {
  const toolSource = source("user", tool.id, tool.version, tool.checksum, "user");
  const descriptor: CapabilityDescriptor = {
    id: `user.${tool.id}`,
    version: tool.version,
    kind: "user_tool",
    name: tool.name,
    description: tool.description,
    category: tool.category ?? "user tools",
    ...(tool.logo ? { logo: tool.logo } : {}),
    tags: ["user", "tool"],
    source: toolSource,
    provider: { id: tool.id, name: tool.name, version: tool.version },
    toolsetIds: [`user.${tool.id}`],
    runtime: { execution: "declarative", requiredScopes: tool.requiredScopes ?? [], credentialRequirements: tool.credentialRequirements ?? [] },
  };
  catalog.register(descriptor);
  addToolset(catalog, {
    id: `user.${tool.id}`,
    version: tool.version,
    name: tool.name,
    description: `${tool.name} user tool`,
    source: toolSource,
    capabilityIds: [descriptor.id],
    includes: [],
  });
  return descriptor;
}
