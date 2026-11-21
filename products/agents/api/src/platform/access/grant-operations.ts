import { connectedToolAuthorityIds, type AgentConfiguration, type ExecutionGrant } from "../../contracts/contracts";

/** Derive an operation ceiling from the published configuration and caller context. */
export function operationsForConfiguration(c: AgentConfiguration, staff = false): ExecutionGrant["operations"] {
  return ["model.reply", "knowledge.read", ...(staff && c.tools.includes("tasks.inspect") ? ["tasks.read"] as const : []),
    ...(staff && c.tools.includes("tasks.cancel") ? ["tasks.cancel"] as const : []),
    ...(c.tools.includes("enquiry.read") ? ["enquiry.read"] as const : []), ...(c.tools.includes("enquiry.amend") ? ["enquiry.amend"] as const : []),
    ...(staff && c.tools.includes("records.search") ? ["records.read"] as const : []), ...(staff && c.tools.includes("records.update") ? ["records.write"] as const : []),
    ...(c.capabilities.enquiries?.enabled ? ["enquiry.submit"] as const : []), ...(c.memory.enabled ? ["memory.read", "memory.propose"] as const : []),
    ...(c.skillIds.length ? ["skill.read"] as const : []),
    ...(c.capabilities.businessActions.enabled ? ["booking.read" as const, ...(c.capabilities.businessActions.permittedOperations.includes("calendar.book") ? ["booking.execute" as const] : [])] : []),
    ...(c.capabilities.delegation.enabled ? ["delegation.execute"] as const : []), ...(c.capabilities.sandbox.enabled ? ["sandbox.execute"] as const : []),
    ...((c.capabilities.sandbox.enabled || c.capabilities.workflows.enabled) ? ["artifact.read", "artifact.write"] as const : []),
    ...(c.capabilities.workflows.enabled ? ["effect.deliver"] as const : []), ...(connectedToolAuthorityIds(c).length ? ["connected.read", "connected.execute"] as const : []),
    ...(c.tools.includes("channel.request_handoff") ? ["channel.handoff"] as const : [])];
}
