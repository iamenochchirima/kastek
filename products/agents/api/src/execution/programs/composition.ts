import { PlatformError, requestDigest, type AgentConfiguration } from "../../contracts/contracts";
import { effectiveCompositionSchema, programReferenceSchema, type EffectiveComposition, type ProgramReference } from "../../contracts/programs";
import { capabilityBindingSchema, type CapabilityBinding } from "../../contracts/capability-catalog";

// These descriptors select trusted code policies. A prompt cannot register a program or release.
interface ProgramDescriptor {
  readonly id: ProgramReference["id"]; readonly version: "1"; readonly executionKind: "business";
  readonly controller: string; readonly input: string; readonly output: string;
  readonly allowedTools: readonly string[]; readonly personalMemory: boolean;
  readonly delegation: boolean; readonly sandbox: boolean; readonly connectedTools: boolean; readonly workflows: readonly string[];
}
const programs: Readonly<Record<ProgramReference["id"], ProgramDescriptor>> = Object.freeze({
  "grounded-conversation": Object.freeze({
    id: "grounded-conversation", version: "1", executionKind: "business", controller: "shared-business-loop-v1",
    input: "bounded-text-v1", output: "grounded-answer-or-escalation-v1",
    allowedTools: ["knowledge.search", "knowledge.read", "channel.request_handoff"],
    personalMemory: false, delegation: false, sandbox: false, connectedTools: false, workflows: [],
  }),
  "tool-directed": Object.freeze({
    id: "tool-directed", version: "1", executionKind: "business", controller: "shared-business-loop-v1",
    input: "bounded-text-v1", output: "evidence-backed-result-v1",
    allowedTools: ["knowledge.search", "knowledge.read", "memory.search", "memory.propose", "agents.delegate", "sandbox.analyze", "channel.request_handoff"],
    personalMemory: true, delegation: true, sandbox: true, connectedTools: true, workflows: ["report-delivery-v1"],
  }),
});

export function resolveProgram(reference: ProgramReference) {
  const parsed = programReferenceSchema.safeParse(reference);
  if (!parsed.success) throw new PlatformError("PROGRAM_RELEASE_UNAVAILABLE", 503, "The trusted program release is unavailable");
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
  const denied = () => { throw new PlatformError("PROGRAM_COMPOSITION_DENIED", 409, "The configuration exceeds the trusted program contract"); };
  if (configuration.executionKind !== program.executionKind) throw new PlatformError("RUNTIME_UNAVAILABLE", 503, "The program requires an available compatible runtime");
  if (configuration.tools.some(name => !program.allowedTools.includes(name)) ||
      (configuration.memory.enabled && !program.personalMemory) ||
      (configuration.capabilities.delegation.enabled && !program.delegation) ||
      (configuration.capabilities.sandbox.enabled && !program.sandbox) ||
      (configuration.connectedToolBindingIds.length > 0 && !program.connectedTools) ||
      (configuration.capabilities.workflows.enabled && !program.workflows.includes(configuration.capabilities.workflows.profileId))) denied();
  const expectedTools: string[] = [...configuration.tools, ...(configuration.capabilities.workflows.enabled ? ["report.deliver"] : [])];
  if (new Set(dependencies.tools.map(tool => tool.name)).size !== dependencies.tools.length ||
      expectedTools.length !== dependencies.tools.length ||
      expectedTools.some(name => !dependencies.tools.some(tool => tool.name === name)) ||
      dependencies.tools.some(tool => !expectedTools.includes(tool.name))) denied();
  if ((configuration.tools.includes("agents.delegate") && !configuration.capabilities.delegation.enabled) ||
      (configuration.tools.includes("sandbox.analyze") && !configuration.capabilities.sandbox.enabled) ||
      (configuration.tools.some(name => name.startsWith("memory.")) && !configuration.memory.enabled)) denied();
  const workflowConfiguration = configuration.capabilities.workflows;
  const workflows = workflowConfiguration.enabled ? dependencies.workflows.filter(workflow => workflow.id === workflowConfiguration.profileId) : [];
  if (configuration.capabilities.workflows.enabled && workflows.length !== 1) throw new PlatformError("WORKFLOW_RELEASE_UNAVAILABLE", 503, "The workflow release is unavailable");
  const bindings = dependencies.connectedBindings.map(binding => capabilityBindingSchema.parse(binding));
  if (new Set(bindings.map(binding => binding.id)).size !== bindings.length || bindings.length !== configuration.connectedToolBindingIds.length ||
      bindings.some(binding => !configuration.connectedToolBindingIds.includes(binding.id))) denied();
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
