import type { CapabilityBinding } from "../../contracts/capability-catalog";
import { requestDigest, type AgentConfiguration } from "../../contracts/contracts";
import { SHARED_HARNESS_RELEASE, SHARED_WORKFLOW_NAME } from "../../contracts/execution";
import { publishedToolBindings } from "../../capabilities/tool-definitions";
import { REPORT_WORKFLOW_BINDING,BOOKING_WORKFLOW_BINDING } from "../../capabilities/tool-descriptors";
import { compileComposition } from "./composition";
import { PROTOCOL_TOOL_NAMES, type PublishedToolBinding } from "../../capabilities/protocol-tools";

export function compilePublishedComposition(configuration: AgentConfiguration, connectedBindings: readonly CapabilityBinding[], pinnedRuntime?: {release:string;workflow:string},
  acceptedBindings?: readonly PublishedToolBinding[]) {
  const shared = pinnedRuntime === undefined || pinnedRuntime.release === SHARED_HARNESS_RELEASE;
  const versions = acceptedBindings === undefined ? shared ? undefined : new Map([["agents.result",pinnedRuntime!.release==="product-capabilities-v13"?"1":"2"],["memory.search","1"],["memory.propose","1"]])
    : new Map(acceptedBindings.map(binding=>[binding.name,binding.version]));
  const includeProtocol = shared && (acceptedBindings === undefined || PROTOCOL_TOOL_NAMES.some(name=>versions!.has(name)));
  return compileComposition(configuration.program, configuration, {
    runtime: pinnedRuntime ?? {release:SHARED_HARNESS_RELEASE,workflow:SHARED_WORKFLOW_NAME}, tools: publishedToolBindings(configuration,pinnedRuntime?.release==="product-capabilities-v13",versions,includeProtocol), connectedBindings,
    workflows: [REPORT_WORKFLOW_BINDING,BOOKING_WORKFLOW_BINDING].map(binding=>({id:binding.profileId,version:binding.version,digest:requestDigest(binding)})),
  });
}
