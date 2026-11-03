import type { PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import type { GrowthAgentModelOption } from "@kasitek-labs/contracts";
import { agentConfigurationSchema, PlatformError, requestDigest } from "../../contracts/contracts";
import { modelDescriptorSchema, providerDefinitionSchema, type ModelSelection } from "../../contracts/model-providers";
import { modelToolSupport } from "../../adapters/models/model-capabilities";
import { compileEffectiveExecutionPolicy } from "../../execution/models/policy";
import { validateGeneration } from "../../adapters/models/model-controls";
import { contextGrantCeiling, executionModelLayers, modelServicePolicy } from "../../execution/models/settings";
import { resolveAcceptedModelRoutes } from "../../execution/models/resolution";
import { assertModelCredentialAvailable } from "../../execution/models/credential-readiness";

type Feature = {organization_id:string;agent_id:string;version_id:string;revision:number;configuration:unknown};
export async function listGrowthModels(db:PoolClient,feature:Feature) {
  const config=agentConfigurationSchema.parse(feature.configuration),consumer={kind:"agent",agentId:feature.agent_id};
  const rows=(await db.query(`SELECT c.*,catalog.snapshot,catalog.snapshot_digest,g.model_ids,g.consumer,g.roles
    FROM agents_platform.model_provider_connections c
    JOIN agents_platform.model_provider_catalogues catalog ON catalog.organization_id=c.organization_id AND catalog.connection_id=c.id
      AND catalog.connection_revision=c.revision AND catalog.credential_revision=c.credential_revision
    JOIN agents_platform.model_provider_credentials credential ON credential.organization_id=c.organization_id AND credential.connection_id=c.id
      AND credential.revision=c.credential_revision AND credential.endpoint=c.endpoint AND credential.protocol=c.protocol AND credential.state='active'
    JOIN agents_platform.model_provider_use_grants g ON g.organization_id=c.organization_id AND g.connection_id=c.id AND g.state='active'
    WHERE c.organization_id=$1 AND c.state='active' AND (g.consumer=$2::jsonb OR EXISTS(
      SELECT 1 FROM agents_platform.product_model_defaults d WHERE d.organization_id=c.organization_id AND d.product='growth'
        AND d.connection_id=c.id AND d.use_grant_id=g.id
        AND g.consumer=jsonb_build_object('kind','service','serviceId','product-default','product','growth')))
    FOR SHARE OF c,catalog,credential,g`,[feature.organization_id,JSON.stringify(consumer)])).rows;
  const options=new Map<string,GrowthAgentModelOption>();
  const layers=executionModelLayers(config,{id:feature.version_id,maxInputBytes:config.model.maxInputBytes,maxOutputTokens:config.model.maxOutputTokens,
    maxContextTokens:contextGrantCeiling(config),rootTokenLimit:modelServicePolicy().maxRootTokens});
  const requiresTools=config.tools.length>0||config.productBindings.length>0||config.skillIds.length>0;
  for(const row of rows){
    if(requestDigest(row.snapshot)!==row.snapshot_digest||!Array.isArray(row.snapshot.models)||!Array.isArray(row.model_ids)||
      !['primary','compaction','delegated'].every(role=>row.roles?.includes(role)))continue;
    const definition=providerDefinitionSchema.safeParse(row.definition);if(!definition.success||definition.data.adapter.readiness!=='installed'||definition.data.id!==row.provider_id||definition.data.protocol!==row.protocol)continue;
    const verifications=requiresTools?(await db.query(`SELECT model_id,model_revision,verification,observed_at FROM agents_platform.model_provider_verifications
      WHERE organization_id=$1 AND connection_id=$2 AND connection_revision=$3 AND credential_revision=$4
      AND endpoint=$5 AND protocol=$6 FOR SHARE`,[feature.organization_id,row.id,row.revision,row.credential_revision,row.endpoint,row.protocol])).rows:[];
    for(const raw of row.snapshot.models){
      const parsed=modelDescriptorSchema.safeParse(raw);if(!parsed.success)continue;const model=parsed.data;
      if(!row.model_ids.includes(model.id)||row.snapshot.unavailableModelIds?.includes(model.id)||model.lifecycle==='retired'||
        model.providerId!==row.provider_id||model.protocol!==row.protocol||!model.inputModalities.includes('text')||!model.outputModalities.includes('text'))continue;
      if(requiresTools&&modelToolSupport(model)!=='supported'){
        const receipt=verifications.find(value=>value.model_id===model.id&&value.model_revision===model.revision);
        if(modelToolSupport(model,receipt?.verification)!=='supported')continue;
        model.capabilities.tools={value:true,evidence:'verified',source:{kind:'verified',reference:`model-provider-verification:${row.id}/${row.revision}/${row.credential_revision}/${model.id}`,observedAt:receipt!.observed_at.toISOString()}};
        model.revision=requestDigest({...model,revision:'pending'});
      }
      try{const compiled=compileEffectiveExecutionPolicy(model,layers);if(compiled.policy.maxCostMicros!==null)continue;validateGeneration(model,compiled.policy,row.endpoint,config.model.generation);}catch{continue;}
      options.set(row.id+':'+model.id,{connectionId:row.id,modelId:model.id,label:model.name,provider:definition.data.name,
        contextWindowTokens:model.contextTokens.value,maxOutputTokens:model.maxOutputTokens.value,
        pricing:model.pricing?{currency:model.pricing.currency,inputMicrosPerMillionTokens:model.pricing.inputMicrosPerMillionTokens,outputMicrosPerMillionTokens:model.pricing.outputMicrosPerMillionTokens}:null});
    }
  }
  let current:{connectionId:string;modelId:string}|null=config.model.selection.kind==='connection'?{connectionId:config.model.selection.connectionId,modelId:config.model.selection.modelId}:null;
  try{const routes=await resolveAcceptedModelRoutes(db,{organizationId:feature.organization_id,agentId:feature.agent_id,product:'growth',selection:config.model.selection,generation:config.model.generation,layers,requiresTools});
    await assertModelCredentialAvailable(db,routes.primary.binding);current={connectionId:routes.primary.binding.connectionId,modelId:routes.primary.binding.modelId};
  }catch(error){if(!(error instanceof PlatformError))throw error;}
  const productDefault=(await db.query("SELECT connection_id,model_id FROM agents_platform.product_model_defaults WHERE organization_id=$1 AND product='growth' FOR SHARE",[feature.organization_id])).rows[0];
  const defaultModel=productDefault ? options.get(productDefault.connection_id+':'+productDefault.model_id) ?? null : null;
  return {defaultModel,revision:feature.revision,inherited:config.model.selection.kind==='organization_default',current,
    models:[...options.values()].sort((a,b)=>a.provider.localeCompare(b.provider)||a.label.localeCompare(b.label)||a.modelId.localeCompare(b.modelId))};
}

export async function authorizeGrowthModelSelection(db:PoolClient,feature:Feature,selection:ModelSelection){
  const config=agentConfigurationSchema.parse(feature.configuration);
  if(selection.kind==='connection'){
    const inventory=await listGrowthModels(db,feature);
    if(!inventory.models.some(model=>model.connectionId===selection.connectionId&&model.modelId===selection.modelId))
      throw new PlatformError('MODEL_USE_DENIED',403,'This model is not available to this agent');
    const consumer={kind:'agent',agentId:feature.agent_id};
    const exists=(await db.query(`SELECT 1 FROM agents_platform.model_provider_use_grants WHERE organization_id=$1 AND connection_id=$2
      AND consumer=$3::jsonb AND state='active' AND model_ids ? $4 AND roles ?& ARRAY['primary','compaction','delegated']`,
      [feature.organization_id,selection.connectionId,JSON.stringify(consumer),selection.modelId])).rowCount;
    if(!exists)await db.query(`INSERT INTO agents_platform.model_provider_use_grants(id,organization_id,connection_id,consumer,roles,model_ids)
      VALUES($1,$2,$3,$4,$5,$6)`,[randomUUID(),feature.organization_id,selection.connectionId,consumer,JSON.stringify(['primary','compaction','delegated']),JSON.stringify([selection.modelId])]);
  }
  config.model.selection=selection;
  const route=await resolveAcceptedModelRoutes(db,{organizationId:feature.organization_id,agentId:feature.agent_id,product:'growth',selection,generation:config.model.generation,
    layers:executionModelLayers(config,{id:feature.version_id,maxInputBytes:config.model.maxInputBytes,maxOutputTokens:config.model.maxOutputTokens,maxContextTokens:contextGrantCeiling(config),rootTokenLimit:modelServicePolicy().maxRootTokens}),
    requiresTools:config.tools.length>0||config.productBindings.length>0||config.skillIds.length>0});
  await assertModelCredentialAvailable(db,route.primary.binding);
  return config;
}
