import { listToolIntegrations, type IntegrationCatalogEntry } from "./catalog";
import { REVIEWED_MCP_CATALOG, REVIEWED_SKILL_CATALOG } from "./reviewed-catalog";
import { getReviewedPluginAdapterCapabilityIds, getReviewedPluginAdapterStatus, REVIEWED_PLUGIN_CATALOG } from "../extensions/reviewed-plugin-catalog";

export type ConnectionDirectoryKind = "native" | "mcp";

export interface ConnectionDirectoryEntry {
  id: string;
  kind: ConnectionDirectoryKind;
  name: string;
  description: string;
  category: string;
  logo: string;
  auth: string;
  source: "kasitek" | "reviewed-catalog";
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
  provider?: string;
  oauthProvider?: string;
  displayOrder?: number;
}

export function listConnectionDirectory(): ConnectionDirectoryEntry[] {
  const native = listToolIntegrations().map((entry) => nativeDirectoryEntry(entry));
  const mcp = REVIEWED_MCP_CATALOG.map((entry) => ({
    id: entry.id,
    kind: "mcp" as const,
    name: titleCase(entry.name),
    description: entry.description,
    category: reviewedCategory(entry),
    logo: entry.slug,
    auth: entry.auth,
    source: "reviewed-catalog" as const,
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
  return [...native, ...mcp].sort(compareConnectionDirectoryEntries);
}

export function listSkillDirectory() {
  return REVIEWED_SKILL_CATALOG.map((entry) => ({
    ...entry,
    source: "reviewed-catalog" as const,
    enabled: false,
    skillId: null,
    versionId: null,
  }));
}

export function listPluginDirectory() {
  return REVIEWED_PLUGIN_CATALOG.map((entry) => ({
    ...entry,
    adapterCapabilityIds: getReviewedPluginAdapterCapabilityIds(entry),
    adapterStatus: getReviewedPluginAdapterStatus(entry),
    source: "reviewed-catalog" as const,
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
    ...(entry.provider ? { provider: entry.provider } : {}),
    ...(entry.oauthProvider ? { oauthProvider: entry.oauthProvider } : {}),
    ...(entry.displayOrder === undefined ? {} : { displayOrder: entry.displayOrder }),
  };
}

function compareConnectionDirectoryEntries(left: ConnectionDirectoryEntry, right: ConnectionDirectoryEntry): number {
  const groupDifference = connectionGroup(left) - connectionGroup(right);
  if (groupDifference !== 0) return groupDifference;
  const orderDifference = (left.displayOrder ?? 1_000) - (right.displayOrder ?? 1_000);
  if (orderDifference !== 0) return orderDifference;
  return left.name.localeCompare(right.name);
}

function connectionGroup(entry: ConnectionDirectoryEntry): number {
  if (entry.provider === "google" || entry.category.toLowerCase() === "google") return 0;
  switch (entry.category.toLowerCase()) {
    case "productivity": return 1;
    case "messaging": return 2;
    case "search": return 3;
    case "development": return 4;
    case "data": return 5;
    case "observability": return 6;
    default: return 7;
  }
}

function reviewedCategory(entry: { id: string; slug: string; name: string; keywords: readonly string[]; hosts: readonly string[] }): string {
  const value = [entry.id, entry.slug, entry.name, ...entry.keywords, ...entry.hosts].join(" ").toLowerCase();
  if (/google|gmail|drive|calendar/.test(value)) return "Google";
  if (/slack|discord|telegram|whatsapp|messenger|sms|chat/.test(value)) return "Messaging";
  if (/github|gitlab|jira|linear|atlassian|code|developer/.test(value)) return "Development";
  if (/postgres|mysql|sqlite|database|supabase|airtable|snowflake/.test(value)) return "Data";
  if (/search|web|browser|fetch|firecrawl|exa|tavily|serp/.test(value)) return "Search";
  if (/notion|asana|trello|hubspot|salesforce|figma|stripe|shopify/.test(value)) return "Productivity";
  return "Other";
}

function titleCase(value: string): string {
  return value
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}
