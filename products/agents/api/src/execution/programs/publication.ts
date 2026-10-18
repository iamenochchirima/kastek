import type { CapabilityBinding } from "../../contracts/capability-catalog";
import { requestDigest, type AgentConfiguration } from "../../contracts/contracts";
import { HARNESS_RELEASE, WORKFLOW_NAME } from "../../contracts/execution";
import { publishedToolBindings } from "../../capabilities/tool-definitions";
import { REPORT_WORKFLOW_BINDING } from "../../capabilities/tool-descriptors";
import { compileComposition } from "./composition";

export function compilePublishedComposition(configuration: AgentConfiguration, connectedBindings: readonly CapabilityBinding[]) {
  return compileComposition(configuration.program, configuration, {
    runtime: { release: HARNESS_RELEASE, workflow: WORKFLOW_NAME }, tools: publishedToolBindings(configuration), connectedBindings,
    workflows: [{ id: REPORT_WORKFLOW_BINDING.profileId, version: REPORT_WORKFLOW_BINDING.version, digest: requestDigest(REPORT_WORKFLOW_BINDING) }],
  });
}
