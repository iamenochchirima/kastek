import { modelToolSupport } from "../../adapters/models/model-capabilities";
import { validateGeneration, modelControlsRevision } from "../../adapters/models/model-controls";
import type { ModelGenerationSettings } from "../../contracts/model-generation";
import { ProviderTransportError } from "../../contracts/model-transport";
import type { PoolClient } from "pg";
import { PlatformError, canonicalJson, requestDigest } from "../../contracts/contracts";
import { acceptedModelRoutesSchema, type AcceptedModelRoutes } from "../../contracts/model-bindings";
import { modelDescriptorSchema, modelSelectionSchema, providerDefinitionSchema,
  type ModelSelection, type ProviderUseGrant } from "../../contracts/model-providers";
import { compileEffectiveExecutionPolicy, type ExecutionPolicyLayer } from "./policy";

/** Admission only. It reads saved metadata and authority without discovery, inference or key access. */
export async function resolveAcceptedModelRoutes(db: PoolClient, input: {
  organizationId: string; agentId: string; product: "agents" | "growth" | "agencies";
  selection: ModelSelection; generation?: ModelGenerationSettings; layers: readonly ExecutionPolicyLayer[]; requiresTools: boolean;
}): Promise<AcceptedModelRoutes> {
  const selection = modelSelectionSchema.parse(input.selection);
  let connectionId: string, modelId: string, grantId: string | undefined, consumer: ProviderUseGrant["consumer"];
  if (selection.kind === "organization_default") {
    // The owner authorizes this service route explicitly when choosing the default.
    const row = input.product === "agents"
      ? (await db.query("SELECT * FROM agents_platform.model_provider_defaults WHERE organization_id=$1 FOR SHARE", [input.organizationId])).rows[0]
      : (await db.query("SELECT * FROM agents_platform.product_model_defaults WHERE organization_id=$1 AND product=$2 FOR SHARE", [input.organizationId,input.product])).rows[0];
    if (!row) throw new PlatformError("MODEL_DEFAULT_REQUIRED", 409, "Choose a default model in Model providers");
    connectionId = row.connection_id; modelId = row.model_id; grantId = row.use_grant_id;
    consumer = { kind: "service", serviceId: input.product === "agents" ? "organization-default" : "product-default", product: input.product };
  } else {
    connectionId = selection.connectionId; modelId = selection.modelId;
    consumer = { kind: "agent", agentId: input.agentId };
  }
  const connection = (await db.query(`SELECT * FROM agents_platform.model_provider_connections
    WHERE organization_id=$1 AND id=$2 FOR SHARE`, [input.organizationId, connectionId])).rows[0];
  if (connection?.managed_model_id && modelId !== connection.managed_model_id) throw new PlatformError("MODEL_USE_DENIED", 403, "The managed provider does not allow this model");
  if (!connection || connection.state !== "active") throw new PlatformError("MODEL_CONNECTION_UNAVAILABLE", 409, "Reconnect the selected model provider");
  const definition = providerDefinitionSchema.parse(connection.definition);
  if (definition.adapter.readiness !== "installed") throw new PlatformError("MODEL_ADAPTER_NOT_INSTALLED", 503, "The selected model adapter is unavailable");
  if (definition.id !== connection.provider_id || definition.protocol !== connection.protocol) throw new PlatformError("MODEL_ROUTE_CHANGED", 409, "Model connection metadata has changed");
  const grant = (await db.query(`SELECT * FROM agents_platform.model_provider_use_grants WHERE organization_id=$1 AND connection_id=$2
    AND consumer=$3::jsonb AND state='active' AND model_ids ? $4 AND ($5::uuid IS NULL OR id=$5)
    ORDER BY created_at DESC,id DESC LIMIT 1 FOR SHARE`,
  [input.organizationId, connectionId, JSON.stringify(consumer), modelId, grantId ?? null])).rows[0];
  if (!grant || canonicalJson(grant.consumer) !== canonicalJson(consumer) ||
      !["primary", "compaction", "delegated"].every(role => grant.roles.includes(role))) {
    throw new PlatformError("MODEL_USE_DENIED", 403, "The model connection is not authorized for this agent");
  }
  const cache = (await db.query(`SELECT snapshot,snapshot_digest FROM agents_platform.model_provider_catalogues
    WHERE organization_id=$1 AND connection_id=$2 AND connection_revision=$3 AND credential_revision=$4 FOR SHARE`,
  [input.organizationId, connectionId, connection.revision, connection.credential_revision])).rows[0];
  if (!cache || requestDigest(cache.snapshot) !== cache.snapshot_digest || !Array.isArray(cache.snapshot.models)) {
    throw new PlatformError("MODEL_METADATA_REQUIRED", 409, "Refresh models for the selected provider");
  }
  const found = cache.snapshot.models.find((item: { id: string }) => item.id === modelId);
  if (!found || cache.snapshot.unavailableModelIds?.includes(modelId)) throw new PlatformError("MODEL_UNAVAILABLE", 409, "The selected model is unavailable; refresh models or choose another model");
  const model = modelDescriptorSchema.parse(found);
  if (model.providerId !== definition.id || model.protocol !== definition.protocol || model.lifecycle === "retired") {
    throw new PlatformError("MODEL_UNAVAILABLE", 409, "The selected model cannot be used on this route");
  }
  if (!model.inputModalities.includes("text") || !model.outputModalities.includes("text")) {
    throw new PlatformError("MODEL_TEXT_SUPPORT_REQUIRED", 409, "Text generation metadata is required for this model");
  }
  if (input.requiresTools && modelToolSupport(model) !== "supported") {
    const receipt = (await db.query(`SELECT verification,observed_at FROM agents_platform.model_provider_verifications
      WHERE organization_id=$1 AND connection_id=$2 AND connection_revision=$3 AND credential_revision=$4
      AND endpoint=$5 AND protocol=$6 AND model_id=$7 AND model_revision=$8`,
    [input.organizationId, connectionId, connection.revision, connection.credential_revision, connection.endpoint, connection.protocol, modelId, model.revision])).rows[0];
    if (modelToolSupport(model, receipt?.verification) !== "supported") {
      throw new PlatformError("MODEL_TOOL_SUPPORT_REQUIRED", 409, "Test tool support for the selected model");
    }
    model.capabilities.tools = { value: true, evidence: "verified", source: { kind: "verified",
      reference: `model-provider-verification:${connectionId}/${connection.revision}/${connection.credential_revision}/${modelId}`,
      observedAt: receipt.observed_at.toISOString() } };
    model.revision = requestDigest({ ...model, revision: "pending" });
  }
  let compiled;
  try { compiled = compileEffectiveExecutionPolicy(model, input.layers); }
  catch { throw new PlatformError("MODEL_POLICY_INVALID", 422, "Model limits are unknown or do not fit the execution allowance"); }
  if (compiled.policy.maxCostMicros !== null) throw new PlatformError("MODEL_COST_CAP_UNSUPPORTED", 422, "A strict spending cap requires a qualified token bound and an enforceable price ceiling for this route");
  let generation;
  try { generation = validateGeneration(model, compiled.policy, connection.endpoint, input.generation); }
  catch (error) { if (error instanceof ProviderTransportError) throw new PlatformError(error.code, error.status, "The generation settings do not fit this model or output allowance"); throw error; }
  const generationDigest = requestDigest({ generation, revision: modelControlsRevision });
  const route = (role: "primary" | "compaction" | "delegated") => ({ definition, model, consumer, policy: compiled.policy, policyDecisions:compiled.decisions, generation, generationRevision: modelControlsRevision,
    binding: { organizationId: input.organizationId, connectionId, connectionRevision: connection.revision,
      credentialRevision: connection.credential_revision, useGrantId: grant.id, useGrantRevision: grant.revision,
      providerId: definition.id, providerDefinitionDigest: requestDigest(definition), endpoint: connection.endpoint,
      protocol: definition.protocol, modelId, modelRevision: model.revision, adapterId: definition.adapter.id,
      adapterRevision: definition.adapter.revision, generationDigest, role, policyDigest: compiled.policy.digest } });
  return acceptedModelRoutesSchema.parse({ primary: route("primary"), compaction: route("compaction"), delegated: route("delegated") });
}
