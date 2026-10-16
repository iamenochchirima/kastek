import type { HostedAgentCreationProfile } from "../domain/types";

/** The consent-gated handoff capability every customer-service agent receives. */
export const CUSTOMER_SERVICE_HANDOFF_TOOL = "conversation.offer_handoff";
/** Compatibility capability retained for already-published agent versions. */
export const LEGACY_CUSTOMER_SERVICE_HANDOFF_TOOL = "conversation.request_human";

export function resolveHostedAgentAllowedTools(
  profile: HostedAgentCreationProfile | "system" | undefined,
  requested: unknown,
  audience: "personal" | "customer_service" = "personal",
): string[] {
  const requestedTools = Array.isArray(requested)
    ? requested.filter((tool): tool is string => typeof tool === "string" && tool.trim().length > 0)
    : [];
  // Ordinary hosted agents are provider-neutral. KasiAi's protected capability
  // pack is assembled by its system bootstrap path, never by this resolver.
  void profile;
  const allowedTools = [...new Set(requestedTools.map((tool) => tool.trim()))];
  if (audience === "personal" && (allowedTools.includes(CUSTOMER_SERVICE_HANDOFF_TOOL) || allowedTools.includes(LEGACY_CUSTOMER_SERVICE_HANDOFF_TOOL))) {
    throw new Error("Customer handoff capability requires a customer-service agent");
  }
  if (audience === "customer_service" && !allowedTools.includes(CUSTOMER_SERVICE_HANDOFF_TOOL)) {
    allowedTools.push(CUSTOMER_SERVICE_HANDOFF_TOOL);
  }
  return allowedTools;
}
