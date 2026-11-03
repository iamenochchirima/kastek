import { delegatedConfiguration } from "./scope";
import { delegatedSkills } from "./skills";
import { capabilityBindingSchema } from "../../contracts/capability-catalog";
import type { Pool } from "pg";
import { agentConfigurationSchema, PlatformError } from "../../contracts/contracts";
import { orchestrationContracts } from "../../contracts/orchestration";
import { delegatedModelRoutes } from "../models/settings";
import { transaction } from "../lifecycle/execution";
import { authorizeOrchestration } from "./progress";

/** Discover only the already authorized, admitted catalog. A search cannot expand its grant. */
export async function discoverSpecialists(pool: Pool, taskId: string, input: unknown) {
  const args = orchestrationContracts["agents.discover"].input.parse(input);
  return transaction(pool, async db => {
    const execution = await authorizeOrchestration(db, taskId, "agents.discover");
    const delegation = execution.configuration.capabilities.delegation;
    if (!delegation.enabled) throw new PlatformError("DELEGATION_DENIED", 403, "Delegation is unavailable");
    const query = args.query?.trim().toLocaleLowerCase();
    const selected = delegation.bindings.filter(binding => (!args.bindingId || binding.id === args.bindingId) &&
      (!query || `${binding.id} ${binding.label ?? ""} ${binding.description ?? ""}`.toLocaleLowerCase().includes(query)));
    const offset = args.offset ?? 0;
    const specialists = [];
    for (const binding of selected.slice(offset, offset + 8)) {
      const row = (await db.query(`SELECT v.configuration,v.agent_id,a.name FROM agents_platform.agent_versions v
        JOIN agents_platform.agents a ON a.id=v.agent_id AND a.organization_id=v.organization_id
        WHERE v.organization_id=$1 AND v.id=$2 AND a.deleted_at IS NULL`, [execution.task.organization_id, binding.versionId])).rows[0];
      const reasons: string[] = [];let skills:{name:string;description:string}[]=[];
      const config = row ? agentConfigurationSchema.parse(row.configuration) : null;
      if (!config) reasons.push("Pinned specialist unavailable");
      else {
        if(execution.task.product==="growth") {
          const available=(await db.query("SELECT 1 FROM agents_platform.product_execution_features f JOIN agents_platform.agent_versions v ON v.agent_id=f.agent_id WHERE f.product='growth' AND f.organization_id=$1 AND f.enabled AND v.id=$2",[execution.task.organization_id,binding.versionId])).rowCount;
          if(!available)reasons.push("Growth specialist unavailable");
        }
        let effective=config;
        try { effective=delegatedConfiguration(execution.configuration,binding,config); }
        catch(error){if(error instanceof PlatformError)reasons.push(error.message);else throw error;}
        try { delegatedModelRoutes(execution.models, effective, binding.maxTokens, binding.maxActiveMs); }
        catch (error) { if (error instanceof PlatformError) reasons.push(error.message); else throw error; }
        try{
          const connections=(await db.query("SELECT binding FROM agents_platform.capability_bindings WHERE organization_id=$1 AND id=ANY($2::uuid[])",[execution.task.organization_id,effective.connectedToolBindingIds])).rows;
          skills=(await delegatedSkills(db,{organizationId:execution.task.organization_id,agentId:row.agent_id,configuration:effective,connectedBindings:connections.map(row=>capabilityBindingSchema.parse(row.binding))})).map(skill=>({name:skill.name,description:skill.description}));
        }catch(error){if(error instanceof PlatformError)reasons.push(error.message);else throw error;}
        if (binding.sourceRevisionIds.length) {
          const sources = await db.query(`SELECT r.id FROM agents_platform.source_revisions r JOIN agents_platform.sources s ON s.id=r.source_id
            JOIN agents_platform.source_revision_policy p ON p.revision_id=r.id WHERE r.organization_id=$1 AND r.id=ANY($2::uuid[])
            AND s.state='active' AND p.state='approved'`, [execution.task.organization_id, binding.sourceRevisionIds]);
          if (sources.rowCount !== binding.sourceRevisionIds.length) reasons.push("Knowledge unavailable");
        }
        if (binding.connectedToolBindingIds.length) {
          const connections = await db.query(`SELECT b.id FROM agents_platform.capability_bindings b JOIN agents_platform.connections c ON c.id=b.connection_id
            WHERE b.organization_id=$1 AND b.id=ANY($2::uuid[]) AND c.state='active' AND c.expires_at>now()
            AND c.policy_revision=(b.binding->'connection'->>'policyRevision')::integer`, [execution.task.organization_id, binding.connectedToolBindingIds]);
          if (connections.rowCount !== binding.connectedToolBindingIds.length) reasons.push("Tools unavailable");
        }
      }
      specialists.push({ bindingId: binding.id, name: binding.label ?? row?.name ?? binding.id, description: binding.description ?? "Configured specialist",
        versionId: binding.versionId, ready: !reasons.length, reasons, skillCount:config?.skillIds.length??0,skills, tools: [...binding.tools], sourceCount: binding.sourceRevisionIds.length });
    }
    return { specialists, nextOffset: offset + 8 < selected.length ? offset + 8 : null };
  });
}
