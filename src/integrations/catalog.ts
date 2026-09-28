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
  provider?: string;
  oauthProvider?: string;
  displayOrder?: number;
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
    provider: "kasitek",
    displayOrder: 40,
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
    provider: "google",
    oauthProvider: "google",
    displayOrder: 10,
    capabilityNames: ["kasitek.calendar.list", "kasitek.calendar.create", "kasitek.calendar.update", "kasitek.calendar.delete"],
    requiredScopes: ["https://www.googleapis.com/auth/calendar.events"],
    configurable: true,
  },
  {
    id: "google.gmail",
    kind: "tool",
    runtime: "tool_registry",
    name: "Gmail",
    description: "Search messages in a connected Gmail account.",
    category: "productivity",
    auth: "oauth2",
    logo: "google-gmail",
    provider: "google",
    oauthProvider: "google",
    displayOrder: 20,
    capabilityNames: ["kasitek.gmail.search"],
    requiredScopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    configurable: true,
  },
  {
    id: "google.email",
    kind: "tool",
    runtime: "tool_registry",
    name: "Google Mail",
    description: "Search, read, and reply from a connected Google mailbox.",
    category: "productivity",
    auth: "oauth2",
    logo: "google-gmail",
    provider: "google",
    oauthProvider: "google",
    displayOrder: 21,
    capabilityNames: ["kasitek.email.search", "kasitek.email.read", "kasitek.email.send", "kasitek.email.reply"],
    requiredScopes: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.send"],
    configurable: true,
  },
  {
    id: "microsoft.email",
    kind: "tool",
    runtime: "tool_registry",
    name: "Microsoft Mail",
    description: "Search, read, and reply from a connected Microsoft mailbox.",
    category: "productivity",
    auth: "oauth2",
    logo: "microsoft-outlook",
    provider: "microsoft",
    oauthProvider: "microsoft",
    displayOrder: 22,
    capabilityNames: ["kasitek.email.search", "kasitek.email.read", "kasitek.email.send", "kasitek.email.reply"],
    requiredScopes: ["Mail.Read", "Mail.Send", "offline_access"],
    configurable: true,
  },
  {
    id: "google.drive",
    kind: "tool",
    runtime: "tool_registry",
    name: "Google Drive",
    description: "Search files in a connected Google Drive.",
    category: "productivity",
    auth: "oauth2",
    logo: "google-drive",
    provider: "google",
    oauthProvider: "google",
    displayOrder: 30,
    capabilityNames: ["kasitek.drive.search"],
    requiredScopes: ["https://www.googleapis.com/auth/drive.readonly"],
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
    provider: "apple",
    displayOrder: 50,
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
    provider: "tavily",
    displayOrder: 60,
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
    provider: "opentelemetry",
    displayOrder: 90,
    capabilityNames: [],
    requiredScopes: [],
    configurable: true,
  },
];

export function getIntegration(id: string): IntegrationCatalogEntry | undefined {
  return INTEGRATION_CATALOG.find((entry) => entry.id === id);
}

export function listIntegrations(): IntegrationCatalogEntry[] {
  return INTEGRATION_CATALOG
    .map((entry) => ({ ...entry, capabilityNames: [...entry.capabilityNames], requiredScopes: [...entry.requiredScopes] }))
    .sort((left, right) => (left.displayOrder ?? 1_000) - (right.displayOrder ?? 1_000) || left.name.localeCompare(right.name));
}

export function listToolIntegrations(): IntegrationCatalogEntry[] {
  return listIntegrations().filter((entry) => entry.kind === "tool");
}
