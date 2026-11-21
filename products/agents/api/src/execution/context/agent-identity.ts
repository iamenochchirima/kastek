import type { AgentConfiguration, AgentGuidance, AgentIdentity } from "../../contracts/contracts";

/** Prompt composition for an agent's identity and behaviour guidance. */
export function renderIdentity(identity: AgentIdentity): string {
  const parts = [
    "You are the agent described below. This identity is who you are and how you speak.",
    `Purpose: ${identity.purpose}`,
    `Voice: ${identity.voice}`,
    identity.values ? `Values: ${identity.values}` : "",
    identity.boundaries ? `Boundaries: ${identity.boundaries}` : "",
    identity.refusal ? `When refusing: ${identity.refusal}` : "",
    identity.escalation ? `Escalation: ${identity.escalation}` : "",
    identity.examples.length ? `Examples:\n${identity.examples.map((example) => `- ${example}`).join("\n")}` : "",
  ];
  return parts.filter(Boolean).join("\n");
}

export function renderGuidance(guidance: AgentGuidance): string {
  return [
    "Behaviour guidance:",
    guidance.topicScope ? `Scope: ${guidance.topicScope}` : "",
    guidance.avoid.length ? `Avoid:\n${guidance.avoid.map((item) => `- ${item}`).join("\n")}` : "",
    `Refusal style: ${guidance.refusalStyle}`,
    guidance.redirectTo ? `When redirecting: ${guidance.redirectTo}` : "",
  ].filter(Boolean).join("\n");
}

/** Identity and guidance are optional; without them the prompt is exactly the existing instructions. */
export function composeAgentInstructions(configuration: Pick<AgentConfiguration, "instructions" | "identity" | "guidance">): string {
  return [
    configuration.identity ? renderIdentity(configuration.identity) : "",
    configuration.instructions,
    configuration.guidance ? renderGuidance(configuration.guidance) : "",
  ].filter(Boolean).join("\n\n");
}
