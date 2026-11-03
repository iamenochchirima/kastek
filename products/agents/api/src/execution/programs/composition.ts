import { procedureToolNames } from "../../contracts/procedures";
import { orchestrationTools } from "../../contracts/orchestration";
import { productAuthorityBindings } from "../../capabilities/products/product-capabilities";
import { PlatformError, requestDigest, type AgentConfiguration } from "../../contracts/contracts";
import { effectiveCompositionSchema, programReferenceSchema, type EffectiveComposition, type ProgramReference } from "../../contracts/programs";
import { capabilityBindingSchema, type CapabilityBinding } from "../../contracts/capability-catalog";
import { PROTOCOL_TOOL_NAMES } from "../../capabilities/protocol-tools";

// These descriptors select trusted code policies. A prompt cannot register a program or release.
interface ProgramDescriptor {
  readonly id: ProgramReference["id"]; readonly version: "1" | "2" | "3" | "4"; readonly executionKind: "business";
  readonly controller: string; readonly input: string; readonly output: string;
  readonly allowedTools: readonly string[]; readonly personalMemory: boolean;
  readonly delegation: boolean; readonly sandbox: boolean; readonly connectedTools: boolean; readonly workflows: readonly string[];
}
const programs: Readonly<Record<ProgramReference["id"], ProgramDescriptor>> = Object.freeze({
  "grounded-conversation": Object.freeze({
    id: "grounded-conversation", version: "1", executionKind: "business", controller: "shared-business-loop-v1",
    input: "bounded-text-v1", output: "grounded-answer-or-escalation-v1",
    allowedTools: Object.freeze(["knowledge.search", "knowledge.read", "channel.request_handoff", "enquiry.submit", "enquiry.read", "enquiry.amend", "records.search", "records.update"]),
    personalMemory: false, delegation: false, sandbox: false, connectedTools: true, workflows: Object.freeze([]),
  }),
  "tool-directed": Object.freeze({
    id: "tool-directed", version: "1", executionKind: "business", controller: "shared-business-loop-v1",
    input: "bounded-text-v1", output: "evidence-backed-result-v1",
    allowedTools: Object.freeze(["knowledge.search", "knowledge.read", "memory.search", "memory.read", "memory.propose", "agents.delegate", "sandbox.analyze", "channel.request_handoff", "enquiry.submit", "enquiry.read", "enquiry.amend", "records.search", "records.update"]),
    personalMemory: true, delegation: true, sandbox: true, connectedTools: true, workflows: Object.freeze(["report-delivery-v1"]),
  }),
});

export function resolveProgram(reference: ProgramReference) {
  const parsed = programReferenceSchema.safeParse(reference);
  if (!parsed.success) throw new PlatformError("PROGRAM_RELEASE_UNAVAILABLE", 503, "The trusted program release is unavailable");
  if(parsed.data.id==='tool-directed'&&parsed.data.version==='2')return {...programs['tool-directed'],version:'2' as const,
    allowedTools:[...programs['tool-directed'].allowedTools,'tasks.inspect','tasks.cancel']};
  if(parsed.data.id==='tool-directed'&&parsed.data.version==='4') return {...programs['tool-directed'],version:'4' as const,controller:'adaptive-business-loop-v1',allowedTools:[...programs['tool-directed'].allowedTools,'tasks.inspect','tasks.cancel',...orchestrationTools]};
  if (parsed.data.version !== "1") {
    if(parsed.data.id!=="tool-directed"||parsed.data.version!=="3")throw new PlatformError("PROGRAM_RELEASE_UNAVAILABLE",503,"The trusted program release is unavailable");
    return {...programs["tool-directed"],version:"3" as const};
  }
  return programs[parsed.data.id];
}

export interface CompositionDependencies {
  runtime: { release: string; workflow: string };
  tools: readonly { name: string; version: string; digest: string }[];
  workflows: readonly { id: string; version: string; digest: string }[];
  connectedBindings: readonly CapabilityBinding[];
}

/** Publication and admission use the same compiler, with freshly authorized dependencies. */
export function compileComposition(reference: ProgramReference, configuration: AgentConfiguration, dependencies: CompositionDependencies): EffectiveComposition {
  const program = resolveProgram(reference);
  const productAuthority=productAuthorityBindings(configuration);
  if(productAuthority.length && (reference.id!=="tool-directed"||!["3","4"].includes(reference.version)))throw new PlatformError("PROGRAM_COMPOSITION_DENIED",409,"Product tools require a compatible program");
  const denied = () => { throw new PlatformError("PROGRAM_COMPOSITION_DENIED", 409, "The configuration exceeds the trusted program contract"); };
  if(configuration.capabilities.delegation.enabled&&configuration.capabilities.delegation.bindings.some(role=>role.productBindingIds?.some(id=>!productAuthority.some(binding=>binding.id===id))))denied();
  if(configuration.capabilities.delegation.enabled && reference.version!=="4" && (configuration.capabilities.delegation.bindings.length>2 || configuration.capabilities.delegation.maxChildren!==2 || configuration.capabilities.delegation.policy)) denied();
  if (configuration.program.id !== reference.id || configuration.program.version !== reference.version) denied();
  if (configuration.executionKind !== program.executionKind) throw new PlatformError("RUNTIME_UNAVAILABLE", 503, "The program requires an available compatible runtime");
  if (configuration.tools.some(name => !program.allowedTools.includes(name) &&
        !(name==="artifact.create"&&reference.id==="tool-directed"&&["3","4"].includes(reference.version)) &&
        !(["support.get_status","support.get_status_v2","support.request_handoff","support.request_handoff_v2"].includes(name) && configuration.tools.includes("channel.request_handoff"))) ||
      (configuration.tools.includes("support.request_handoff_v2") && (reference.id!=="grounded-conversation" || configuration.capabilities.delegation.enabled)) ||
      (configuration.memory.enabled && !program.personalMemory) ||
      (configuration.capabilities.delegation.enabled && !program.delegation) ||
      (configuration.capabilities.sandbox.enabled && !program.sandbox) ||
      (configuration.connectedToolBindingIds.length > 0 && !program.connectedTools) ||
      (configuration.capabilities.workflows.enabled && !program.workflows.includes(configuration.capabilities.workflows.profileId))) denied();
  if(configuration.procedures?.length && (!configuration.tools.includes("channel.request_handoff") || !configuration.tools.includes("support.get_status_v2") || !configuration.supportHours)) throw new PlatformError("PROCEDURE_NOT_READY",409,"Enable human support and configure support hours before selecting the workflow");
  const expectedTools: string[] = [...configuration.tools,...(configuration.procedures?.length ? procedureToolNames : []),...configuration.productBindings.map(binding=>binding.alias), ...(configuration.sourceRevisionIds.length ? ["knowledge.initial"] : []),
    ...(dependencies.tools.some(tool => (PROTOCOL_TOOL_NAMES as readonly string[]).includes(tool.name)) ? PROTOCOL_TOOL_NAMES : []),
    ...(configuration.memory.enabled&&configuration.tools.includes("memory.search")&&!configuration.tools.includes("memory.read")?["memory.read"]:[]),
    ...(configuration.skillIds.length ? ["skills.activate", "skills.read",...(configuration.capabilities.sandbox.enabled&&configuration.tools.includes("sandbox.analyze")?["skills.run"]:[])] : []),
    ...(configuration.capabilities.businessActions.enabled?["booking.availability",...(configuration.capabilities.businessActions.permittedOperations.includes("calendar.book")?["booking.reserve"]:[])]:[]),
    ...(configuration.capabilities.workflows.enabled ? ["report.deliver"] : [])];
  if (new Set(dependencies.tools.map(tool => tool.name)).size !== dependencies.tools.length ||
      expectedTools.length !== dependencies.tools.length ||
      expectedTools.some(name => !dependencies.tools.some(tool => tool.name === name)) ||
      dependencies.tools.some(tool => !expectedTools.includes(tool.name))) denied();
  if ((configuration.tools.includes("agents.delegate") && !configuration.capabilities.delegation.enabled) ||
      (configuration.tools.includes("sandbox.analyze") && !configuration.capabilities.sandbox.enabled) ||
      (configuration.tools.some(name => name.startsWith("memory.")) && !configuration.memory.enabled)) denied();
  const workflowConfiguration = configuration.capabilities.workflows,bookingConfiguration=configuration.capabilities.businessActions;
  const workflows = dependencies.workflows.filter(workflow => workflowConfiguration.enabled&&workflow.id===workflowConfiguration.profileId || bookingConfiguration.enabled&&workflow.id===bookingConfiguration.profileId || configuration.procedures?.some(ref=>ref.id===workflow.id&&ref.version===workflow.version));
  if((configuration.procedures??[]).some(ref=>!workflows.some(workflow=>workflow.id===ref.id&&workflow.version===ref.version)))throw new PlatformError("PROCEDURE_RELEASE_UNAVAILABLE",503,"The selected workflow release is unavailable");
  if(bookingConfiguration.enabled&&!workflows.some(workflow=>workflow.id===bookingConfiguration.profileId))throw new PlatformError("WORKFLOW_RELEASE_UNAVAILABLE",503,"The booking workflow release is unavailable");
  if (workflowConfiguration.enabled && workflows.filter(workflow=>workflow.id===workflowConfiguration.profileId).length !== 1) throw new PlatformError("WORKFLOW_RELEASE_UNAVAILABLE", 503, "The workflow release is unavailable");
  const bindings = dependencies.connectedBindings.map(binding => capabilityBindingSchema.parse(binding));
  if (new Set(bindings.map(binding => binding.id)).size !== bindings.length || bindings.length !== configuration.connectedToolBindingIds.length ||
      bindings.some(binding => !configuration.connectedToolBindingIds.includes(binding.id))) denied();
  if(new Set([...bindings,...configuration.productBindings].map(binding=>binding.alias)).size!==bindings.length+configuration.productBindings.length)denied();
  const content = {
    schemaVersion: 1 as const,
    program: { id: program.id, version: program.version, digest: requestDigest(program) },
    runtime: { kind: configuration.executionKind, ...dependencies.runtime },
    context: {
      conversation: "ordered-evidence-v1" as const, knowledge: "approved-revisions-v1" as const,
      personalMemory: configuration.memory.enabled ? "reviewed-principal-v1" as const : "disabled" as const,
      compaction: "dependency-preserving-v1" as const, productRecords: "authorized-tool-results-only" as const,
    },
    capabilities: [...dependencies.tools].sort((a, b) => a.name.localeCompare(b.name)).map(tool => ({ id: tool.name, version: tool.version, digest: tool.digest })),
    workflows: [...workflows].sort((a, b) => a.id.localeCompare(b.id)),
    connectedBindings: bindings.map(binding => ({ id: binding.id, digest: binding.digest })).sort((a, b) => a.id.localeCompare(b.id)),
    productBindings:configuration.productBindings.map(binding=>({id:binding.id,digest:binding.digest})).sort((a,b)=>a.id.localeCompare(b.id)),
    ...(configuration.commissionableProductBindings?{commissionableProductBindings:configuration.commissionableProductBindings.map(binding=>({id:binding.id,digest:binding.digest})).sort((a,b)=>a.id.localeCompare(b.id))}:{}),
    configurationDigest: requestDigest(configuration),
  };
  return effectiveCompositionSchema.parse({ ...content, digest: requestDigest(content) });
}

/** Check the saved release before executing any new operation. No fallback to a newer program. */
export function assertComposition(published: EffectiveComposition, current: EffectiveComposition): void {
  const parsed = effectiveCompositionSchema.parse(published);
  const { digest, ...content } = parsed;
  if (digest !== requestDigest(content) || digest !== current.digest) throw new PlatformError("PROGRAM_RELEASE_UNAVAILABLE", 503, "The pinned composition is unavailable");
}

/** Recognize previously shipped grounded v1 descriptors when inspecting completed Inbox output. */
export function assertInspectableComposition(published: EffectiveComposition, current: EffectiveComposition): void {
  const priorTools = [
    ["knowledge.search", "knowledge.read", "channel.request_handoff"],
    ["knowledge.search", "knowledge.read", "channel.request_handoff", "enquiry.submit"],
  ];
  const original = priorTools.map(allowedTools => ({ ...programs["grounded-conversation"], allowedTools }))
    .find(program => published.program.id === program.id && published.program.version === program.version && published.program.digest === requestDigest(program));
  if (!original) {
    return assertComposition(published, current);
  }
  const { digest: _digest, ...content } = current;
  const historical = { ...content, program: { ...content.program, digest: requestDigest(original) } };
  assertComposition(published, { ...historical, digest: requestDigest(historical) });
}
