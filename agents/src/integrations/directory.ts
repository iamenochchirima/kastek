import { listToolIntegrations, type IntegrationCatalogEntry } from "./catalog";
import { HERMES_MCP_CATALOG, HERMES_SKILL_CATALOG } from "./hermes-directory";
import { getHermesPluginAdapterCapabilityIds, HERMES_PLUGIN_CATALOG } from "../extensions/hermes-plugin-directory";

export type ConnectionDirectoryKind = "native" | "mcp";

export interface ConnectionDirectoryEntry {
  id: string;
  kind: ConnectionDirectoryKind;
  name: string;
  description: string;
  category: string;
  logo: string;
  auth: string;
  source: "kasitek" | "hermes-reviewed";
  sourceUrl?: string;
  endpointUrl?: string | null;
  transport?: "http" | "stdio";
  managed?: boolean;
  keywords?: string[];
  hosts?: string[];
  configured?: boolean;
  status?: "ready" | "connected" | "not_configured" | "unhealthy" | "unsupported";
  connectionId?: string | null;
  providerId?: string | null;
}

export function listConnectionDirectory(): ConnectionDirectoryEntry[] {
  const native = listToolIntegrations().map((entry) => nativeDirectoryEntry(entry));
  const mcp = HERMES_MCP_CATALOG.map((entry) => ({
    id: entry.id,
    kind: "mcp" as const,
    name: titleCase(entry.name),
    description: entry.description,
    category: "MCP",
    logo: entry.slug,
    auth: entry.auth,
    source: "hermes-reviewed" as const,
    sourceUrl: entry.sourceUrl,
    endpointUrl: entry.endpointUrl,
    transport: entry.transport,
    managed: entry.managed,
    keywords: entry.keywords,
    hosts: entry.hosts,
    configured: false,
    status: entry.managed ? "not_configured" as const : "unsupported" as const,
    connectionId: null,
    providerId: null,
  }));
  return [...native, ...mcp];
}

export function listSkillDirectory() {
  return HERMES_SKILL_CATALOG.map((entry) => ({
    ...entry,
    source: "hermes-reviewed" as const,
    enabled: false,
    skillId: null,
    versionId: null,
  }));
}

export function listPluginDirectory() {
  return HERMES_PLUGIN_CATALOG.map((entry) => ({
    ...entry,
    adapterCapabilityIds: getHermesPluginAdapterCapabilityIds(entry),
    source: "hermes-reviewed" as const,
    installed: false,
    packageId: null,
    packageVersionId: null,
  }));
}

function nativeDirectoryEntry(entry: IntegrationCatalogEntry): ConnectionDirectoryEntry {
  return {
    id: entry.id,
    kind: "native",
    name: entry.name,
    description: entry.description,
    category: entry.category,
    logo: entry.logo,
    auth: entry.auth,
    source: "kasitek",
    configured: entry.auth === "internal",
    status: entry.auth === "internal" ? "ready" : "not_configured",
    connectionId: null,
    providerId: null,
  };
}

function titleCase(value: string): string {
  return value
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
