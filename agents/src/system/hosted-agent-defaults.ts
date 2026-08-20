import type { HostedAgentCreationProfile } from "../domain/types";

export function resolveHostedAgentAllowedTools(profile: HostedAgentCreationProfile | "system" | undefined, requested: unknown): string[] {
  const requestedTools = Array.isArray(requested)
    ? requested.filter((tool): tool is string => typeof tool === "string" && tool.trim().length > 0)
    : [];
  // Ordinary hosted agents are provider-neutral. KasiAi's protected capability
  // pack is assembled by its system bootstrap path, never by this resolver.
  void profile;
  return requestedTools;
}
