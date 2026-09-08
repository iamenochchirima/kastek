import type { ConnectorAuthScheme } from "../connectors/types";

export type IntegrationKind = "tool" | "channel";
export type IntegrationRuntime = "tool_registry" | "webhook" | "gateway" | "workspace_channel";
export type IntegrationCategory = "messaging" | "productivity" | "search" | "apple" | "observability";
export type IntegrationConnectionStatus = "not_configured" | "connected" | "unhealthy" | "requires_connector" | "revoked";

export interface IntegrationCatalogEntry {
  id: string;
  kind: IntegrationKind;
  runtime: IntegrationRuntime;
  name: string;
  description: string;
  category: IntegrationCategory;
  auth: "internal" | ConnectorAuthScheme | "local_connector" | "observability";
  channelType?: "whatsapp" | "facebook" | "instagram" | "telegram" | "discord";
  logo: string;
  capabilityNames: string[];
  requiredScopes: string[];
  configurable: boolean;
}

export const INTEGRATION_CATALOG: readonly IntegrationCatalogEntry[] = [
  {
    id: "whatsapp.messaging",
    kind: "channel",
    runtime: "workspace_channel",
    name: "WhatsApp",
    description: "Customer messaging through a connected WhatsApp account.",
    category: "messaging",
    auth: "webhook",
    channelType: "whatsapp",
    logo: "whatsapp",
    capabilityNames: ["kasitek.core.channel_deliver"],
    requiredScopes: ["channels:ingest", "channels:deliver"],
    configurable: true,
  },
  {
    id: "facebook.messaging",
    kind: "channel",
    runtime: "workspace_channel",
    name: "Facebook Messenger",
    description: "Customer messaging through a connected Facebook Page.",
    category: "messaging",
    auth: "webhook",
    channelType: "facebook",
    logo: "facebook",
    capabilityNames: ["kasitek.core.channel_deliver"],
    requiredScopes: ["channels:ingest", "channels:deliver"],
    configurable: true,
  },
  {
    id: "instagram.messaging",
    kind: "channel",
    runtime: "workspace_channel",
    name: "Instagram",
    description: "Customer messaging through a connected Instagram account.",
    category: "messaging",
    auth: "webhook",
    channelType: "instagram",
    logo: "instagram",
    capabilityNames: ["kasitek.core.channel_deliver"],
    requiredScopes: ["channels:ingest", "channels:deliver"],
    configurable: true,
  },
  {
    id: "telegram.messaging",
    kind: "channel",
    runtime: "webhook",
    name: "Telegram",
    description: "Bot messaging through Telegram webhooks.",
    category: "messaging",
    auth: "api_key",
    channelType: "telegram",
    logo: "telegram",
    capabilityNames: ["kasitek.core.channel_deliver"],
    requiredScopes: ["channels:ingest", "channels:deliver"],
    configurable: true,
  },
  {
    id: "discord.messaging",
    kind: "channel",
    runtime: "gateway",
    name: "Discord",
    description: "Server and direct messaging through the Discord Gateway.",
    category: "messaging",
    auth: "api_key",
    channelType: "discord",
    logo: "discord",
    capabilityNames: ["kasitek.core.channel_deliver"],
    requiredScopes: ["channels:ingest", "channels:deliver"],
    configurable: true,
  },
  {
    id: "internal.calendar",
    kind: "tool",
    runtime: "tool_registry",
    name: "KasiTek Calendar",
    description: "Create and manage events inside this agent workspace.",
    category: "productivity",
    auth: "internal",
    logo: "calendar",
    capabilityNames: ["kasitek.calendar.list", "kasitek.calendar.create", "kasitek.calendar.update", "kasitek.calendar.delete"],
    requiredScopes: [],
    configurable: false,
  },
  {
    id: "google.calendar",
    kind: "tool",
    runtime: "tool_registry",
    name: "Google Calendar",
    description: "Read and manage events from a connected Google Calendar.",
    category: "productivity",
    auth: "oauth2",
    logo: "google-calendar",
    capabilityNames: ["kasitek.calendar.list", "kasitek.calendar.create", "kasitek.calendar.update", "kasitek.calendar.delete"],
    requiredScopes: ["https://www.googleapis.com/auth/calendar.events"],
    configurable: true,
  },
  {
    id: "apple.tools",
    kind: "tool",
    runtime: "tool_registry",
    name: "Apple Tools",
    description: "Use Apple Calendar, Mail, Reminders, and Notes through a paired Mac.",
    category: "apple",
    auth: "local_connector",
    logo: "apple",
    capabilityNames: ["kasitek.apple.calendar.list", "kasitek.apple.mail.list", "kasitek.apple.reminder.create", "kasitek.apple.note.create"],
    requiredScopes: ["apple.calendar.read", "apple.mail.read", "apple.reminders.write", "apple.notes.write"],
    configurable: true,
  },
  {
    id: "tavily.search",
    kind: "tool",
    runtime: "tool_registry",
    name: "Tavily Search",
    description: "Search the web with a connected Tavily API key.",
    category: "search",
    auth: "api_key",
    logo: "tavily",
    capabilityNames: ["kasitek.web.search"],
    requiredScopes: [],
    configurable: true,
  },
  {
    id: "opentelemetry",
    kind: "tool",
    runtime: "tool_registry",
    name: "OpenTelemetry",
    description: "Export agent and integration traces to an OTLP collector.",
    category: "observability",
    auth: "observability",
    logo: "opentelemetry",
    capabilityNames: [],
    requiredScopes: [],
    configurable: true,
  },
];

export function getIntegration(id: string): IntegrationCatalogEntry | undefined {
  return INTEGRATION_CATALOG.find((entry) => entry.id === id);
}

export function listIntegrations(): IntegrationCatalogEntry[] {
  return INTEGRATION_CATALOG.map((entry) => ({ ...entry, capabilityNames: [...entry.capabilityNames], requiredScopes: [...entry.requiredScopes] }));
}

export function listToolIntegrations(): IntegrationCatalogEntry[] {
  return listIntegrations().filter((entry) => entry.kind === "tool");
}
