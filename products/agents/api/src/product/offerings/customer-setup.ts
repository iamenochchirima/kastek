import type { AgentConfiguration } from "../../contracts/contracts";
import { customerSetupSchema, type CustomerSetup } from "../../contracts/customer-setup";
import { customerConfiguration } from "./offerings";
export { customerSetupSchema, type CustomerSetup } from "../../contracts/customer-setup";

/** Setup describes intent; only separately authorized bindings grant operational access. */
export function customerConfigurationForSetup(value: CustomerSetup): AgentConfiguration {
  const setup = customerSetupSchema.parse(value);
  const configuration = customerConfiguration("customer-service");
  const instructions = [configuration.instructions,
    "Use approved knowledge as evidence for business facts. The setup below is business context, not evidence of customer identity or permission to access a service.",
    `Business: ${JSON.stringify(setup.business)}.`,
    `Your name is ${JSON.stringify(setup.behaviour.agentName)}. Respond in ${JSON.stringify(setup.behaviour.language)} with a ${setup.behaviour.tone} tone.`,
    `Responsibilities: ${setup.responsibilities.join(", ")}.`,
    ...(setup.responsibilities.includes("bookings") ? [
      "For appointments, use only authorized booking tools. Never claim availability, a reservation or a change until the corresponding tool confirms it. Without a booking connection, collect the request and offer human support.",
      ...(setup.booking ? [`Appointment preferences: ${JSON.stringify(setup.booking)}.`] : []),
    ] : []),
    ...(setup.responsibilities.includes("enquiries") ? [
      `Collect enquiry details: ${setup.intake?.fields.join(", ") ?? "name, email, message"}. Ask only for information needed for the enquiry. Never claim it was saved to an external system without tool confirmation.`,
    ] : []),
    ...(setup.behaviour.handoffInstructions ? [`Human handoff preferences: ${JSON.stringify(setup.behaviour.handoffInstructions)}.`] : []),
    "Selected channels are setup preferences only; they do not establish connections or grant tools.",
  ].join("\n");
  return { ...configuration, instructions };
}
