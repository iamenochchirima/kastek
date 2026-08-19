import type { HostedAgentCreationProfile } from "../domain/types";

/**
 * The low-configuration profile starts with read-only platform context. Writes,
 * provider effects, and privileged account changes remain opt-in capabilities.
 */
export const GENERAL_HOSTED_AGENT_ALLOWED_TOOLS = [
  "platform.current_time",
  "kasitek.core.workspace_status",
  "kasitek.core.workspace_report",
  "kasitek.core.customer_get",
  "kasitek.core.booking_services_list",
  "kasitek.core.bookings_list",
  "kasitek.core.booking_get",
  "kasitek.core.campaigns_list",
  "kasitek.core.campaign_summary",
  "kasitek.core.templates_list",
  "kasitek.core.contacts_list",
  "kasitek.core.inbox_conversations_list",
  "kasitek.core.inbox_messages_list",
  "kasitek.core.content_posts_list",
  "kasitek.core.content_post_get",
] as const;

export function resolveHostedAgentAllowedTools(profile: HostedAgentCreationProfile | "system" | undefined, requested: unknown): string[] {
  const requestedTools = Array.isArray(requested)
    ? requested.filter((tool): tool is string => typeof tool === "string" && tool.trim().length > 0)
    : [];
  if (requestedTools.length || profile !== "general") return requestedTools;
  return [...GENERAL_HOSTED_AGENT_ALLOWED_TOOLS];
}
