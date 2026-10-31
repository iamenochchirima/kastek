import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { agentConfigurationSchema, PlatformError } from "../../contracts/contracts";
import { compileEffectiveExecutionPolicy } from "../../execution/models/policy";
import { executionModelLayers, modelServicePolicy } from "../../execution/models/settings";
import { modelControls, validateGeneration } from "../../adapters/models/model-controls";
import type { ActionScope } from "../../contracts/connections";
import { requireActionMember } from "../../infrastructure/action-authority";
import type { ModelProviderStore } from "./store";

/** Configuration preview reads authorized cached metadata. It neither grants use nor calls a provider. */
export function registerModelPolicyRoutes(app: FastifyInstance, options: {
  store: ModelProviderStore; resolveScope(request: FastifyRequest): Promise<ActionScope>;
}) {
  app.post("/api/organizations/:organizationId/agents/:agentId/model-policy", async request => {
    const scope = await options.resolveScope(request), agentId = z.uuid().parse((request.params as Record<string,string>).agentId);
    await requireActionMember(options.store.pool, scope);
    if (!(await options.store.pool.query("SELECT id FROM agents_platform.agents WHERE id=$1 AND organization_id=$2", [agentId, scope.organizationId])).rowCount) throw new PlatformError("AGENT_NOT_FOUND",404,"Agent not found");
    const { configuration: raw } = z.strictObject({ configuration: z.unknown() }).parse(request.body);
    const configuration = agentConfigurationSchema.parse(raw), service = modelServicePolicy();
    const selection = configuration.model.selection.kind === "connection" ? configuration.model.selection : (await options.store.getDefault(scope)).selection;
    if (!selection) throw new PlatformError("MODEL_DEFAULT_REQUIRED",409,"Choose a default model");
    const cache = await options.store.cachedModels(scope, selection.connectionId, agentId);
    const model = cache.result?.models.find(model => model.id === selection.modelId);
    if (!model || model.lifecycle === "retired" || cache.result?.kind === "discovered" && cache.result.unavailableModelIds?.includes(model.id)) throw new PlatformError("MODEL_UNAVAILABLE",409,"Choose an available model");
    const connection = await options.store.get(scope, selection.connectionId);
    const root = service.maxRootTokens;
    const context = model.contextTokens.value === null ? null : Math.min(model.contextTokens.value,service.contextTokens);
    const output = Math.min(configuration.model.maxOutputTokens,service.maxOutputTokens,model.maxOutputTokens.value??service.maxOutputTokens);
    const inputLimit = context === null ? null : Math.max(0,Math.min(model.maxInputTokens.value??service.maxInputTokens,service.maxInputTokens,context-output-service.safetyTokens,...(root === null ? [] : [root-output])));
    const outputLimit = context === null || model.maxOutputTokens.value === null ? null : Math.max(0,Math.min(model.maxOutputTokens.value,service.maxOutputTokens,context-configuration.context.maxInputTokens-service.safetyTokens,...(root === null ? [] : [root-configuration.context.maxInputTokens])));
    const errors: Array<{field:string;message:string}> = [];
    let effectivePolicy = null;
    try {
      effectivePolicy = compileEffectiveExecutionPolicy(model,executionModelLayers(configuration,{id:`configuration-preview:${agentId}`,rootTokenLimit:root,
        maxInputBytes:configuration.model.maxInputBytes,maxOutputTokens:configuration.model.maxOutputTokens,maxContextTokens:configuration.context.maxInputTokens})).policy;
    } catch {
      if (inputLimit === null || outputLimit === null) errors.push({field:"model.selection",message:"Model capacity metadata is required."});
      if (inputLimit !== null && configuration.context.maxInputTokens > inputLimit) errors.push({field:"context.maxInputTokens",message:"Input and output must fit the context and run allowance."});
      if (outputLimit !== null && configuration.model.maxOutputTokens > outputLimit) errors.push({field:"model.maxOutputTokens",message:"Reply allowance exceeds the available context or run allowance."});
      if (configuration.context.compactAtTokens >= Math.min(configuration.context.maxInputTokens,inputLimit??configuration.context.maxInputTokens)) errors.push({field:"context.compactAtTokens",message:"Compact before the input allowance is reached."});
      if (!errors.length) errors.push({field:"model",message:"These settings do not fit the effective execution policy."});
    }
    const controls = modelControls(model,{maxOutputTokens:output},connection.endpoint);
    try { validateGeneration(model,{maxOutputTokens:output},connection.endpoint,configuration.model.generation); }
    catch { errors.push({field:"model.generation",message:"The generation settings do not fit this model or reply allowance."}); }
    if (configuration.model.maxCostMicros !== null) errors.push({field:"model.maxCostMicros",message:"A strict spending cap is unavailable for this route."});
    return {modelId:model.id,modelRevision:model.revision,limits:{contextTokens:context,maxInputTokens:inputLimit,maxOutputTokens:outputLimit,
      maxCallDurationMs:Math.min(service.maxCallDurationMs,service.maxDurationMs ?? service.maxCallDurationMs),maxRootTokens:root,safetyTokens:service.safetyTokens},
      effectivePolicy,errors,controls};
  });
}
