import { contextGrantCeiling } from "../../execution/models/settings";
import { delegatedSkills } from "../../execution/delegation/skills";
import { delegatedConfiguration } from "../../execution/delegation/scope";
import { capabilityBindingSchema } from "../../contracts/capability-catalog";
import type { Pool } from "pg";
import { agentConfigurationSchema, connectedToolAuthorityIds, sourceAuthorityIds, PlatformError, type AgentConfiguration } from "../../contracts/contracts";
import { transaction } from "../../infrastructure/database";
import { resolveAcceptedModelRoutes } from "../../execution/models/resolution";
import { executionModelLayers, delegatedModelRoutes, modelServicePolicy } from "../../execution/models/settings";
import { PlatformStore } from "../agents/store";

export async function specialistCatalogue(pool:Pool,scope:{accountId:string;organizationId:string},agentId:string) {
  const parent=await new PlatformStore(pool).getAgent(scope.accountId,scope.organizationId,agentId);
  const pinned=parent.draft.capabilities.delegation.enabled?parent.draft.capabilities.delegation.bindings.map(binding=>binding.versionId):[];
  return transaction(pool,async db=>{
    const rows=(await db.query(`SELECT a.id,a.name,v.id version_id,v.number,v.configuration FROM agents_platform.agents a
      JOIN agents_platform.agent_versions v ON v.organization_id=a.organization_id AND v.agent_id=a.id
      WHERE a.organization_id=$1 AND a.id<>$2 AND a.deleted_at IS NULL AND a.offering IS NULL
      AND (v.id=ANY($3::uuid[]) OR v.number=(SELECT max(number) FROM agents_platform.agent_versions WHERE agent_id=a.id))
      ORDER BY a.name,a.id,v.number DESC LIMIT 100`,[scope.organizationId,parent.id,pinned])).rows;
    const specialists=[];
    for(const row of rows) {
      const config=agentConfigurationSchema.parse(row.configuration),reasons:string[]=[];
      const configured=parent.draft.capabilities.delegation.enabled?parent.draft.capabilities.delegation.bindings.find(binding=>binding.versionId===row.version_id):undefined;
      const binding=configured??{id:`specialist_${row.id.replaceAll("-","")}`,versionId:row.version_id,
        sourceRevisionIds:sourceAuthorityIds(config),connectedToolBindingIds:connectedToolAuthorityIds(config),
        tools:config.tools,maxTokens:null,maxActiveMs:null};
      const previewDelegation=parent.draft.capabilities.delegation.enabled
        ?{...parent.draft.capabilities.delegation,bindings:configured?parent.draft.capabilities.delegation.bindings:[...parent.draft.capabilities.delegation.bindings,binding]}
        :{enabled:true as const,maxDepth:null,maxChildren:2,bindings:[binding],policy:{maxTasks:null,maxStalls:3}};
      const previewParent:AgentConfiguration={...parent.draft,capabilities:{...parent.draft.capabilities,delegation:previewDelegation}};
      let effective=config;
      try{effective=delegatedConfiguration(previewParent,binding,config);}
      catch(error){if(error instanceof PlatformError)reasons.push(error.message);else throw error;}
      try {
        const routes=await resolveAcceptedModelRoutes(db,{organizationId:scope.organizationId,agentId:parent.id,product:"agents",selection:parent.draft.model.selection,
          generation:parent.draft.model.generation,layers:executionModelLayers(parent.draft,{id:"specialist-readiness",maxInputBytes:parent.draft.model.maxInputBytes,
            maxOutputTokens:parent.draft.model.maxOutputTokens,maxContextTokens:contextGrantCeiling(parent.draft),rootTokenLimit:modelServicePolicy().maxRootTokens}),requiresTools:true});
        delegatedModelRoutes(routes,effective,binding.maxTokens,binding.maxActiveMs);
      } catch(error) {if(error instanceof PlatformError)reasons.push(error.message);else throw error;}
      const sourceRevisionIds=binding.sourceRevisionIds;
      if(sourceRevisionIds.length) {
        const available=await db.query(`SELECT r.id FROM agents_platform.source_revisions r JOIN agents_platform.sources s ON s.id=r.source_id
          JOIN agents_platform.source_revision_policy p ON p.revision_id=r.id WHERE r.organization_id=$1 AND r.id=ANY($2::uuid[])
          AND s.state='active' AND p.state='approved'`,[scope.organizationId,sourceRevisionIds]);
        if(available.rowCount!==sourceRevisionIds.length)reasons.push("Review unavailable specialist knowledge");
      }
      const connectedToolBindingIds=binding.connectedToolBindingIds;
      if(connectedToolBindingIds.length) {
        const available=await db.query(`SELECT b.id FROM agents_platform.capability_bindings b JOIN agents_platform.connections c ON c.id=b.connection_id
          WHERE b.organization_id=$1 AND b.account_id=$2 AND b.id=ANY($3::uuid[]) AND c.state='active' AND c.expires_at>now()
          AND c.policy_revision=(b.binding->'connection'->>'policyRevision')::integer`,[scope.organizationId,scope.accountId,connectedToolBindingIds]);
        if(available.rowCount!==connectedToolBindingIds.length)reasons.push("Reconnect or authorize the specialist tools");
      }
      const tools=effective.tools;
      try{
        const selected=(await db.query("SELECT binding FROM agents_platform.capability_bindings WHERE organization_id=$1 AND id=ANY($2::uuid[])",[scope.organizationId,connectedToolBindingIds])).rows;
        await delegatedSkills(db,{organizationId:scope.organizationId,agentId:row.id,configuration:effective,connectedBindings:selected.filter(row=>effective.connectedToolBindingIds.includes(row.binding.id)).map(row=>capabilityBindingSchema.parse(row.binding))});
      }catch(error){if(error instanceof PlatformError)reasons.push(error.message);else throw error;}
      specialists.push({agentId:row.id,name:row.name,description:config.instructions.replace(/\s+/g,' ').slice(0,512),versionId:row.version_id,
        skillCount:config.skillIds.length,versionNumber:row.number,ready:reasons.length===0,reasons,sourceRevisionIds,connectedToolBindingIds,tools});
    }
    return {specialists};
  });
}
