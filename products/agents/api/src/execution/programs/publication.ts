import type { CapabilityBinding } from "../../contracts/capability-catalog";
import { requestDigest, type AgentConfiguration } from "../../contracts/contracts";
import { HARNESS_RELEASE, WORKFLOW_NAME, HANDOFF_HARNESS_RELEASE, HANDOFF_WORKFLOW_NAME, ADAPTIVE_HARNESS_RELEASE, ADAPTIVE_WORKFLOW_NAME } from "../../contracts/execution";
import { publishedToolBindings } from "../../capabilities/tool-definitions";
import { REPORT_WORKFLOW_BINDING,BOOKING_WORKFLOW_BINDING } from "../../capabilities/tool-descriptors";
import { compileComposition } from "./composition";

export function compilePublishedComposition(configuration: AgentConfiguration, connectedBindings: readonly CapabilityBinding[]) {
  const handoffV2 = (configuration.tools as readonly string[]).includes("support.request_handoff_v2");
  return compileComposition(configuration.program, configuration, {
    runtime: configuration.program.id==="tool-directed"&&configuration.program.version==="4" ? {release:ADAPTIVE_HARNESS_RELEASE,workflow:ADAPTIVE_WORKFLOW_NAME} : handoffV2 ? { release: HANDOFF_HARNESS_RELEASE, workflow: HANDOFF_WORKFLOW_NAME } : { release: HARNESS_RELEASE, workflow: WORKFLOW_NAME }, tools: publishedToolBindings(configuration), connectedBindings,
    workflows: [REPORT_WORKFLOW_BINDING,BOOKING_WORKFLOW_BINDING].map(binding=>({id:binding.profileId,version:binding.version,digest:requestDigest(binding)})),
  });
}
