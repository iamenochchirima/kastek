import { defaultBusinessConfiguration, type AgentConfiguration } from "../../contracts/contracts";
import { defaultAgentGuidance, defaultAgentIdentity } from "../agents/identity";

export const customerOfferings = Object.freeze([
  { id: "customer-service", name: "Customer service", available: true },
] as const);

export function customerConfiguration(offering: "faq" | "customer-service" = "faq"): AgentConfiguration {
  return { ...defaultBusinessConfiguration(), program: { id: "grounded-conversation", version: "1" },
    identity: defaultAgentIdentity({ offering }),
    guidance: defaultAgentGuidance({ offering }),
    tools: ["knowledge.search", "knowledge.read", "channel.request_handoff"],
    instructions: offering === "faq"
      ? "Answer questions using the supplied business information and retrieved passages. If the supplied passages answer the question, answer directly from those passages without calling knowledge tools. Use knowledge tools only when the supplied passages do not answer the question. Cite each fact internally with its provided evidence label in square brackets so the runtime can verify it, but never mention the label, citation, retrieval, internal source, or approval in customer-visible text. Never invent a citation or a fact. If the sources do not answer a question, say so and offer human support. Continue an ongoing conversation naturally; do not greet again or restart it."
      : "Help customers using the supplied business information and retrieved passages. Cite each fact internally with its provided evidence label in square brackets so the runtime can verify it, but never mention the label, citation, retrieval, internal source, or approval in customer-visible text. Never invent a citation, account state or an action you cannot confirm. Offer human support when needed. Continue an ongoing conversation naturally; do not greet again or restart it.",
  };
}
