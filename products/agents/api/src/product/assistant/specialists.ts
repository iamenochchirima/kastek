import type { Pool } from "pg";
import { agentConfigurationSchema, PlatformError } from "../../contracts/contracts";
import { transaction } from "../../infrastructure/database";
import { resolveAcceptedModelRoutes } from "../../execution/models/resolution";
import { executionModelLayers, delegatedModelRoutes } from "../../execution/models/settings";
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
      if(config.executionKind!=="business"||config.memory.enabled||config.capabilities.delegation.enabled||(config.capabilities.sandbox.enabled&&!(parent.draft.program.version==="4"&&parent.draft.capabilities.sandbox.enabled))||config.capabilities.workflows.enabled||config.capabilities.businessActions.enabled)
        reasons.push("Specialist capabilities exceed the delegation scope");
      try {
        const routes=await resolveAcceptedModelRoutes(db,{organizationId:scope.organizationId,agentId:parent.id,product:"agents",selection:parent.draft.model.selection,
          generation:parent.draft.model.generation,layers:executionModelLayers(parent.draft,{id:"specialist-readiness",maxInputBytes:parent.draft.model.maxInputBytes,
            maxOutputTokens:parent.draft.model.maxOutputTokens,maxContextTokens:parent.draft.context.maxInputTokens,rootTokenLimit:32000}),requiresTools:true});
        const binding=parent.draft.capabilities.delegation.enabled?parent.draft.capabilities.delegation.bindings.find(binding=>binding.versionId===row.version_id):undefined;
        delegatedModelRoutes(routes,config,binding?.maxTokens??8000,binding?.maxActiveMs??120000);
      } catch(error) {if(error instanceof PlatformError)reasons.push(error.message);else throw error;}
      const sourceRevisionIds=config.sourceRevisionIds.filter(id=>parent.draft.sourceRevisionIds.includes(id));
      if(sourceRevisionIds.length) {
        const available=await db.query(`SELECT r.id FROM agents_platform.source_revisions r JOIN agents_platform.sources s ON s.id=r.source_id
          JOIN agents_platform.source_revision_policy p ON p.revision_id=r.id WHERE r.organization_id=$1 AND r.id=ANY($2::uuid[])
          AND s.state='active' AND p.state='approved'`,[scope.organizationId,sourceRevisionIds]);
        if(available.rowCount!==sourceRevisionIds.length)reasons.push("Review unavailable specialist knowledge");
      }
      const connectedToolBindingIds=config.connectedToolBindingIds.filter(id=>parent.draft.connectedToolBindingIds.includes(id));
      if(connectedToolBindingIds.length) {
        const available=await db.query(`SELECT b.id FROM agents_platform.capability_bindings b JOIN agents_platform.connections c ON c.id=b.connection_id
          WHERE b.organization_id=$1 AND b.account_id=$2 AND b.id=ANY($3::uuid[]) AND c.state='active' AND c.expires_at>now()
          AND c.policy_revision=(b.binding->'connection'->>'policyRevision')::integer`,[scope.organizationId,scope.accountId,connectedToolBindingIds]);
        if(available.rowCount!==connectedToolBindingIds.length)reasons.push("Reconnect or authorize the specialist tools");
      }
      specialists.push({agentId:row.id,name:row.name,description:config.instructions.replace(/\s+/g,' ').slice(0,512),versionId:row.version_id,
        versionNumber:row.number,ready:reasons.length===0,reasons,sourceRevisionIds,connectedToolBindingIds,tools:config.tools.filter(tool=>['knowledge.read','knowledge.search',...(parent.draft.program.version==='4'&&parent.draft.capabilities.sandbox.enabled?['sandbox.analyze']:[])].includes(tool))});
    }
    return {specialists};
  });
}
