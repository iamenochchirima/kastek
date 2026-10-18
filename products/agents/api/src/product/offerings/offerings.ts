import { defaultBusinessConfiguration, type AgentConfiguration } from "../../contracts/contracts";

export const customerOfferings = Object.freeze([
  { id: "faq", name: "FAQ", available: true },
  { id: "customer-service", name: "Customer service", available: true },
  { id: "booking", name: "Booking", available: false, unavailableCode: "BOOKING_PROVIDER_UNAVAILABLE" },
] as const);

export function customerConfiguration(offering: "faq" | "customer-service" = "faq"): AgentConfiguration {
  return { ...defaultBusinessConfiguration(), program: { id: "grounded-conversation", version: "1" },
    tools: ["knowledge.search", "knowledge.read", "channel.request_handoff"],
    instructions: offering === "faq"
      ? "Answer questions using approved knowledge. If the supplied approved passages answer the question, answer directly from those passages without calling knowledge tools. Use knowledge tools only when the supplied passages do not answer the question. Cite each fact from approved knowledge with its provided evidence label in square brackets, exactly as supplied. Never invent a citation or a fact. If the sources do not answer a question, say so and offer human support."
      : "Help customers using approved knowledge. Cite each fact from approved knowledge with its provided evidence label in square brackets, exactly as supplied. Never invent a citation, account state or an action you cannot confirm. Offer human support when needed.",
  };
}
