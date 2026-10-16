"use client";

import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import type { AgentAuthorizationRequirement, AgentMessage } from "@/lib/agent-platform";

function isAuthorizationRequirement(value: unknown): value is AgentAuthorizationRequirement {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.code === "string"
    && typeof candidate.provider === "string"
    && Array.isArray(candidate.requiredCapabilities)
    && candidate.requiredCapabilities.length > 0
    && candidate.requiredCapabilities.every((item) => typeof item === "string")
    && typeof candidate.requestable === "boolean"
    && typeof candidate.reasonCode === "string"
    && typeof candidate.remediation === "string";
}

function providerLabel(provider: string) {
  const normalized = provider.trim().toLowerCase();
  return normalized ? `${normalized.slice(0, 1).toUpperCase()}${normalized.slice(1)}` : "provider";
}

export function AgentAuthorizationAction({ message }: { message: AgentMessage }) {
  if (message.direction !== "outbound") return null;
  const requirement = message.content?.authorizationRequired;
  if (!isAuthorizationRequirement(requirement) || requirement.remediation !== "connections_access") return null;

  const params = new URLSearchParams({
    access: "required",
    provider: requirement.provider.toLowerCase(),
    capabilities: requirement.requiredCapabilities.join(","),
  });
  if (requirement.connectionId) params.set("connectionId", requirement.connectionId);
  const label = requirement.requestable ? "Grant access" : "Review access";

  return (
    <Link
      href={`/connections?${params.toString()}`}
      className="mt-2 inline-flex min-h-8 items-center gap-1.5 rounded-md border border-current/30 bg-background/15 px-2.5 py-1 text-xs font-medium text-current transition-colors hover:bg-background/25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-current"
    >
      <ShieldCheck className="size-3.5" aria-hidden="true" />
      {label} for {providerLabel(requirement.provider)}
    </Link>
  );
}
