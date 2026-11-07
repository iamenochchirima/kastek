import type { AgentConfiguration } from "../../contracts/contracts";
import { customerSetupSchema, type CustomerSetup } from "../../contracts/customer-setup";
import { customerConfiguration } from "./offerings";
export { customerSetupSchema, type CustomerSetup } from "../../contracts/customer-setup";

/** Setup describes intent; only separately authorized bindings grant operational access. */
function setupInstructions(value: CustomerSetup): string {
  const setup = customerSetupSchema.parse(value);
  const configuration = customerConfiguration("customer-service");
  const instructions = [configuration.instructions,
    "Use the supplied business information and retrieved passages as evidence for business facts. Treat the setup below as business context, not evidence of customer identity or permission to access a service. Continue an ongoing conversation; do not greet again or restart it. Never mention internal sources, retrieval, evidence, approval, or phrases such as approved knowledge, approved encyclopedia, or knowledge base in customer-visible text.",
    `Business: ${JSON.stringify(setup.business)}.`,
    `Your name is ${JSON.stringify(setup.behaviour.agentName)}. Respond in ${JSON.stringify(setup.behaviour.language)} with a ${setup.behaviour.tone} tone.`,
    `Responsibilities: ${setup.responsibilities.join(", ")}.`,
    ...(setup.responsibilities.includes("bookings") ? [
      "For appointments, use only authorized booking tools. Never claim availability, a reservation or a change until the corresponding tool confirms it. Without a booking connection, collect the request and offer human support.",
      ...(setup.booking ? [`Appointment preferences: ${JSON.stringify(setup.booking)}.`] : []),
    ] : []),
    ...(setup.responsibilities.includes("enquiries") ? [
      `Collect enquiry details: ${setup.intake?.fields.join(", ") ?? "name, email, message"}. Ask only for information needed for the enquiry. Use enquiry.read for this customer's earlier enquiries and enquiry.amend for a confirmed correction. Use enquiry.submit to save the completed enquiry after the customer confirms its exact details. Only report it saved after the tool returns a submitted receipt.`,
    ] : []),
    ...(setup.behaviour.handoffInstructions ? [`Human handoff preferences: ${JSON.stringify(setup.behaviour.handoffInstructions)}.`] : []),
    "Selected channels are setup preferences only; they do not establish connections or grant tools.",
  ].join("\n");
  return instructions;
}

export function customerConfigurationForSetup(value: CustomerSetup): AgentConfiguration {
  return applyCustomerSetup(customerConfiguration("customer-service"), customerSetupSchema.parse(value));
}

/** Derive setup-owned capabilities without replacing manually authorized sources or bindings. */
export function applyCustomerSetup(configuration: AgentConfiguration, setup: CustomerSetup, previous?: CustomerSetup): AgentConfiguration {
  const selected = new Set(setup.responsibilities);
  const tools = new Set(configuration.tools);
  if (selected.has("answer-questions") || selected.has("customer-support")) {
    tools.add("knowledge.search"); tools.add("knowledge.read");
  }
  if (selected.has("customer-support") || setup.behaviour.handoffInstructions.trim()) { tools.add("channel.request_handoff"); tools.add("support.request_handoff_v2"); tools.delete("support.request_handoff"); tools.add("support.get_status_v2"); tools.delete("support.get_status"); }
  else { tools.delete("channel.request_handoff"); tools.delete("support.request_handoff"); tools.delete("support.request_handoff_v2"); tools.delete("support.get_status"); tools.delete("support.get_status_v2"); }
  const enquiries = selected.has("enquiries") ? { enabled: true as const, fields: setup.intake?.fields ?? ["name", "email", "message"] as Array<"name" | "email" | "message"> } : { enabled: false as const };
  if (enquiries.enabled) { tools.add("enquiry.submit"); tools.add("enquiry.read"); tools.add("enquiry.amend"); } else { tools.delete("enquiry.submit"); tools.delete("enquiry.read"); tools.delete("enquiry.amend"); }
  // Calendar access still requires a separately authorized policy, never just setup intent.
  const businessActions = !selected.has("bookings") && previous?.responsibilities.includes("bookings") ? { enabled: false as const } : configuration.capabilities.businessActions;
  const { supportHours: _previousHours, ...rest } = configuration;
  return { ...rest, ...(setup.supportHours ? { supportHours: setup.supportHours } : {}), instructions: setupInstructions(setup), tools: [...tools], capabilities: { ...configuration.capabilities, businessActions, enquiries } };
}
