import { validateGeneration, modelControlsRevision } from "../../adapters/models/model-controls";
import { ProviderTransportError } from "../../contracts/model-transport";
import { requestDigest } from "../../contracts/contracts";
import { z } from "zod";
import type { AgentConfiguration, ExecutionGrant } from "../../contracts/contracts";
import { effectiveExecutionPolicySchema } from "../../contracts/model-providers";
import type { ExecutionPolicyLayer } from "./policy";
import { compileEffectiveExecutionPolicy } from "./policy";
import { PlatformError } from "../../contracts/contracts";
import { acceptedModelRoutesSchema, type AcceptedModelRoutes } from "../../contracts/model-bindings";

// Operator service allowances, not claims about any vendor's model capacity.
export const modelServiceDefaults = Object.freeze({
  contextTokens: 262144, maxInputTokens: 196608, maxOutputTokens: 32768, safetyTokens: 1024,
  compactAtTokens: 131072, maxModelCalls: null, maxToolCalls: null, maxRootModelCalls: null, maxRootToolCalls: null,
  maxDurationMs: null, maxWallDurationMs: null, maxCallDurationMs: 120000,
  maxInputBytes: 65536, maxRequestBytes: 2097152, maxMessages: 256, maxTools: 64, maxResponseBytes: 4194304, maxRootTokens: null, maxCostMicros: null,
});
const { revision: _revision, digest: _digest, ...limits } = effectiveExecutionPolicySchema.shape;
const storageInteger = z.number().int().nonnegative().max(2147483647);
const wideCounters=new Set(["maxModelCalls","maxToolCalls","maxRootModelCalls","maxRootToolCalls","maxDurationMs"]);
const serviceSchema = z.strictObject(limits).extend({ maxRequestBytes: z.number().int().positive().max(2147483647) })
  .superRefine((policy, context) => {
    for (const [field, value] of Object.entries(policy)) if (value !== null && field !== "maxCostMicros" && !wideCounters.has(field) && !storageInteger.safeParse(value).success) {
      context.addIssue({ code: "custom", message: "This capacity or transport setting must fit PostgreSQL integer storage", path: [field] });
    }
  });
export function modelServicePolicy(environment: NodeJS.ProcessEnv = process.env) {
  let configured: unknown = {};
  if (environment.AGENTS_MODEL_POLICY_JSON) {
    try { configured = JSON.parse(environment.AGENTS_MODEL_POLICY_JSON); } catch { throw new Error("Invalid model service policy"); }
  }
  if (!configured || typeof configured !== "object" || Array.isArray(configured)) throw new Error("Invalid model service policy");
  return serviceSchema.parse({ ...modelServiceDefaults, maxRequestBytes: 2097152, ...configured });
}

export function delegatedModelRoutes(parent: AcceptedModelRoutes, configuration: AgentConfiguration,
  maxTokens: number | null, maxActiveMs: number | null): AcceptedModelRoutes {
  if (configuration.model.maxCostMicros !== null) throw new PlatformError("MODEL_COST_CAP_UNSUPPORTED", 422, "A strict spending cap is unavailable for this specialist route");
  const inherited = parent.delegated, selection = configuration.model.selection;
  if (selection.kind === "connection" && (selection.connectionId !== inherited.binding.connectionId || selection.modelId !== inherited.binding.modelId)) {
    throw new PlatformError("MODEL_DELEGATION_ROUTE_DENIED", 403, "The specialist model is outside its parent's authorized route");
  }
  const output = Math.min(inherited.policy.maxOutputTokens, configuration.model.maxOutputTokens);
  const { revision: _revision, digest: _digest, ...parentLimits } = inherited.policy;
  const input = Math.min(inherited.policy.maxInputTokens, configuration.context.maxInputTokens, maxTokens === null ? inherited.policy.maxInputTokens : maxTokens - output);
  if (input < 2) throw new PlatformError("MODEL_DELEGATION_BUDGET_INVALID", 422, "Specialist allocation cannot fit a model call");
  const compiled = compileEffectiveExecutionPolicy(inherited.model, [
    { kind: "platform", reference: `parent-policy:${inherited.policy.digest}`, limits: parentLimits },
    { kind: "agent", reference: "specialist-allocation", limits: { maxInputTokens: input, maxOutputTokens: output,
      compactAtTokens: Math.min(configuration.context.compactAtTokens, inherited.policy.compactAtTokens, input - 1),
      maxRootTokens: maxTokens, maxDurationMs: maxActiveMs, maxCallDurationMs: maxActiveMs === null ? configuration.model.maxDurationSeconds * 1000 : Math.min(maxActiveMs, configuration.model.maxDurationSeconds * 1000),
      maxInputBytes: configuration.model.maxInputBytes } },
  ]);
  const policy=compiled.policy;
  let generation;
  try { generation = validateGeneration(inherited.model, policy, inherited.binding.endpoint, configuration.model.generation); }
  catch (error) { if (error instanceof ProviderTransportError) throw new PlatformError(error.code, error.status, "The specialist generation settings do not fit its allocation"); throw error; }
  const generationDigest = requestDigest({ generation, revision: modelControlsRevision });
  const route = (role: "delegated" | "compaction") => ({ ...inherited, policy, policyDecisions:compiled.decisions, generation, generationRevision: modelControlsRevision,
    binding: { ...inherited.binding, generationDigest, role, policyDigest: policy.digest } });
  return acceptedModelRoutesSchema.parse({ primary: route("delegated"), delegated: route("delegated"), compaction: route("compaction") });
}
export function executionModelLayers(configuration: AgentConfiguration, grant: Pick<ExecutionGrant, "id" | "maxInputBytes" | "maxOutputTokens" | "maxContextTokens" | "rootTokenLimit">,
  environment: NodeJS.ProcessEnv = process.env): ExecutionPolicyLayer[] {
  const platform = modelServicePolicy(environment);
  return [
    { kind: "platform", reference: "model-service-v2:AGENTS_MODEL_POLICY_JSON", limits: platform },
    { kind: "product", reference: `execution-grant:${grant.id}`, limits: { maxInputBytes: grant.maxInputBytes,
      maxInputTokens: grant.maxContextTokens, maxOutputTokens: grant.maxOutputTokens, maxRootTokens: grant.rootTokenLimit } },
    { kind: "agent", reference: "saved-agent-configuration", limits: { maxInputBytes: configuration.model.maxInputBytes,
      maxInputTokens: configuration.context.maxInputTokens, compactAtTokens: configuration.context.compactAtTokens,
      maxOutputTokens: configuration.model.maxOutputTokens, maxCallDurationMs: configuration.model.maxDurationSeconds * 1000,
      maxCostMicros: configuration.model.maxCostMicros } },
  ];
}
