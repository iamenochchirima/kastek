import type { AgentAuthorizationRequirement } from "../media/contracts";

const capabilityLabels: Record<string, string> = {
  MESSAGING_INBOUND: "receive messages",
  MESSAGING_OUTBOUND: "reply to messages",
  SOCIAL_PUBLISH: "publish content",
  MEDIA_PUBLISH: "use media",
  SOCIAL_ANALYTICS: "view analytics",
  COMMENTS_MANAGE: "manage comments",
  SOCIAL_POST_DELETE: "manage published content",
};

function providerLabel(provider: string): string {
  const normalized = provider.trim().toLowerCase();
  return normalized === "facebook" ? "Facebook" : normalized === "instagram" ? "Instagram" : normalized === "whatsapp" ? "WhatsApp" : normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

function capabilityLabel(capability: string): string {
  return capabilityLabels[capability] ?? capability.toLowerCase().replaceAll("_", " ");
}

export function connectionAccessUrl(baseUrl: string | undefined, requirement: AgentAuthorizationRequirement): string | undefined {
  if (!baseUrl || requirement.remediation !== "connections_access") return undefined;
  try {
    const url = new URL("/connections", baseUrl);
    url.searchParams.set("access", "required");
    url.searchParams.set("provider", requirement.provider.toLowerCase());
    url.searchParams.set("capabilities", requirement.requiredCapabilities.join(","));
    return url.toString();
  } catch {
    return undefined;
  }
}

/**
 * Adds one gateway-neutral recovery instruction. The gateway's own formatter turns the Markdown
 * link into its native representation when it supports links.
 */
export function authorizationRemediationText(
  text: string,
  requirement: AgentAuthorizationRequirement,
  appUrl?: string,
): string {
  const access = requirement.requestable ? "Access is needed" : "Access needs review";
  const capabilities = requirement.requiredCapabilities.map(capabilityLabel).join(" and ");
  const provider = providerLabel(requirement.provider);
  const link = connectionAccessUrl(appUrl, requirement);
  const action = link ? `[Open Connections](${link})` : "open Connections in your KasiTek workspace";
  const addition = `${access} to ${capabilities} on ${provider}. ${action} to review it, then retry.`;
  if (!text.trim()) return addition;
  if (text.toLowerCase().includes("open connections") || text.toLowerCase().includes("grant access")) {
    return link ? `${text.trim()}\n\n${action} to review access, then retry.` : text.trim();
  }
  return `${text.trim()}\n\n${addition}`;
}
