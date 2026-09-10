import { CAPABILITY_AWARENESS_SYSTEM_CONTRACT, type EffectiveCapabilitySnapshot } from "../runtime/effective-capabilities";

/**
 * Platform-owned skill metadata. The body is deliberately generic and does
 * not enumerate current tools; those change with the effective snapshot.
 */
export const CAPABILITY_DISCOVERY_SKILL_ID = "agent-capability-discovery" as const;
export const CAPABILITY_DISCOVERY_SKILL_VERSION = "1.0.0" as const;

export const CAPABILITY_DISCOVERY_SKILL = Object.freeze({
  id: CAPABILITY_DISCOVERY_SKILL_ID,
  version: CAPABILITY_DISCOVERY_SKILL_VERSION,
  name: "Agent capability discovery",
  description: "Describe the current agent capabilities and load relevant skill instructions.",
  instructions: [
    CAPABILITY_AWARENESS_SYSTEM_CONTRACT,
    "When asked what you can do, answer from the capability projection for this turn. Distinguish callable tools from connected services, catalogue entries, and skills.",
    "A ready skill contributes instructions only; it never authorizes a tool. Do not list a blocked skill as usable, and explain the limitation without exposing internal identifiers.",
    "Use skills_list for the compact enabled-skill index and skill_view to load one skill's full instructions when the current task needs it.",
    "For a broad capability question, summarize the callable tools and ready skills. For an account-specific question, use the trusted connection-discovery capability when it is listed.",
    "For current connected records such as calendar events, messages, files, or contacts, call the matching supplied tool before answering; never infer live data from the connection name.",
    "Use a tool only when its current schema is supplied and the request is within its scope. Approval-gated actions still require approval and durable completion evidence.",
  ].join("\n"),
});

/** Compact metadata included in every hosted-agent prompt. */
export function capabilityDiscoverySkillIndex(snapshot: EffectiveCapabilitySnapshot): string {
  return [
    `${CAPABILITY_DISCOVERY_SKILL.name} v${CAPABILITY_DISCOVERY_SKILL.version}`,
    `ready=${snapshot.model.skillIndex.filter((skill) => skill.readiness === "ready").length}`,
    `unavailable=${snapshot.model.skillIndex.filter((skill) => skill.readiness === "unavailable").length}`,
  ].join("; ");
}

/** Load the platform skill body only when capability discovery is relevant. */
export function loadCapabilityDiscoveryInstructions(input: {
  snapshot: EffectiveCapabilitySnapshot;
  capabilityRequest: boolean;
}): string | undefined {
  return input.capabilityRequest
    ? `${CAPABILITY_DISCOVERY_SKILL.name} v${CAPABILITY_DISCOVERY_SKILL.version}:\n${CAPABILITY_DISCOVERY_SKILL.instructions}`
    : undefined;
}
