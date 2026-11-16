import { delegatedConfiguration } from "../../execution/delegation/scope";
import { delegatedSkills } from "../../execution/delegation/skills";
import { isDeepStrictEqual } from "node:util";
import { createHash,randomUUID } from "node:crypto";
import type { Pool,PoolClient } from "pg";
import { assertConnectedBindingDependencies } from "../../capabilities/connected-tools/connected-tool-schema";
import { capabilityBindingSchema } from "../../contracts/capability-catalog";
import {
agentConfigurationSchema,assertGrantAuthority,
connectedToolAuthorityIds,resolveKnowledgeMode,sourceAuthorityIds,configuredContext,
defaultBusinessConfiguration,
executionGrantSchema,
PlatformError,requestDigest,
type AgentConfiguration,type ExecutionGrant
} from "../../contracts/contracts";
import { assertSkillRequirements } from "../../capabilities/skills/requirement-authority";
import { loadBookingPolicy } from "../../workflows/booking/policy";
import { customerSetupSchema, customerConfigurationForSetup, applyCustomerSetup, type CustomerSetup } from "../offerings/customer-setup";
import { defaultAgentGuidance, defaultAgentIdentity, setupUpdatedLayers } from "./identity";
import { randomAgentAvatar } from "./avatars";
import { customerConfiguration } from "../offerings/offerings";
import { compilePublishedComposition } from "../../execution/programs/publication";
import { assertComposition, assertInspectableComposition } from "../../execution/programs/composition";

import { publishedToolBindings } from "../../capabilities/tools";

import type { Account,AgentRecord,VersionRecord,WebsiteDeployment } from "../../contracts/records";
import { DeploymentStore } from "../deployments/deployment-store";
import { AuthorityStore } from "../../execution/admission/authority-store";
import { loadSkillRevisions } from "../../execution/memory/memory";
import { assertAgentsBillingFeature } from "../billing/billing";

type Db=Pool|PoolClient;
function updatedSupportHoursSetup(agent:AgentRecord,configuration:AgentConfiguration):CustomerSetup|undefined {
  if(!agent.setup||isDeepStrictEqual(agent.draft.supportHours,configuration.supportHours))return undefined;
  return customerSetupSchema.parse({...agent.setup,supportHours:configuration.supportHours});
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function denied(): never { throw new PlatformError("ACCESS_DENIED", 403, "Access denied"); }
function absent(): never { throw new PlatformError("NOT_FOUND", 404, "Record not found"); }
function text(value: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new PlatformError("INVALID_INPUT", 400, "Invalid input");
  return normalized;
}
function tokenHash(token: string): string | null { return /^[A-Za-z0-9_-]{43}$/.test(token) ? hash(token) : null; }
function grantFromRow(row: Record<string, unknown>): ExecutionGrant {
  return executionGrantSchema.parse({ id: row.id, product: row.product, organizationId: row.organization_id,
    resourceId: row.resource_id, callerClientId: row.caller_client_id, principal: row.principal, versionId: row.version_id,
    operations: row.operations, sourceRevisionIds: row.source_revision_ids, connectedToolBindingIds: row.connected_tool_binding_ids, maxInputBytes: row.max_input_bytes,
    maxOutputTokens: row.max_output_tokens, maxContextTokens: row.max_context_tokens, rootTokenLimit: row.root_token_limit, expiresAt: (row.expires_at as Date).toISOString(),
    revokedAt: row.revoked_at ? (row.revoked_at as Date).toISOString() : null });
}


function canonical(value:unknown):string {
  if(Array.isArray(value))return JSON.stringify(value.map(item=>canonical(item)).sort());
  if(value&&typeof value==="object")return JSON.stringify(Object.entries(value).filter(([key])=>!["label","description","versionNumber"].includes(key)).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)]));
  return JSON.stringify(value);
}
function configurationAuthorityChange(before:AgentConfiguration,after:AgentConfiguration):{expanded:boolean;reduced:boolean} {
  // Version 2 adds separately granted task tools; a compatible upgrade does not revoke accepted version 1 work.
  const atoms=(config:AgentConfiguration)=>new Set([
    ...config.tools.map(id=>`tool:${id}`),...sourceAuthorityIds(config).map(id=>`source:${id}`),
    ...config.skillIds.map(id=>`skill:${id}`),...connectedToolAuthorityIds(config).map(id=>`binding:${id}`),
    ...config.productBindings.map(binding=>`direct-product:${requestDigest(binding)}`),...(config.commissionableProductBindings??[]).map(binding=>`commission-product:${requestDigest(binding)}`),
    ...Object.entries(config.capabilities).filter(([,value])=>value.enabled).map(([key,value])=>`capability:${key}:${canonical(value)}`),
    ...(config.memory.enabled?["memory"]:[]),`execution:${config.executionKind}`,`program:${config.program.id==='tool-directed'&&['1','2'].includes(config.program.version)?'tool-directed-v1-v2':canonical(config.program)}`,
  ]);
  const old=atoms(before),next=atoms(after);
  return {expanded:[...next].some(value=>!old.has(value))||canonical(before.model.selection)!==canonical(after.model.selection),
    reduced:[...old].some(value=>!next.has(value))};
}

export class AgentStore extends AuthorityStore {
  async listAgents(accountId: string, organizationId: string): Promise<AgentRecord[]> {
    return this.transaction(async (db) => { await this.membership(db, accountId, organizationId);
      return (await db.query<AgentRecord>("SELECT * FROM agents_platform.agents WHERE organization_id=$1 AND deleted_at IS NULL ORDER BY created_at,id", [organizationId])).rows; });
  }
  async getAgent(accountId: string, organizationId: string, agentId: string): Promise<AgentRecord> {
    return this.transaction(async (db) => { await this.membership(db, accountId, organizationId);
      return (await db.query<AgentRecord>("SELECT * FROM agents_platform.agents WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL", [organizationId, agentId])).rows[0] ?? absent(); });
  }
  async identityDefaults(accountId: string, organizationId: string, agentId: string): Promise<{
    identity: ReturnType<typeof defaultAgentIdentity>;
    guidance: ReturnType<typeof defaultAgentGuidance>;
  }> {
    const agent = await this.getAgent(accountId, organizationId, agentId);
    const responsibilities = agent.setup?.responsibilities ?? null;
    return {
      identity: defaultAgentIdentity({ offering: agent.offering, responsibilities }),
      guidance: defaultAgentGuidance({ offering: agent.offering, responsibilities }),
    };
  }
  private async assertNoPendingTransfer(db:Db, organizationId:string, agentId:string):Promise<void> {
    if ((await db.query("SELECT 1 FROM agents_platform.agent_transfers WHERE organization_id=$1 AND agent_id=$2 AND state='pending' AND expires_at>now() LIMIT 1",[organizationId,agentId])).rowCount)
      throw new PlatformError("AGENT_TRANSFER_PENDING",409,"Cancel the pending transfer before changing this agent");
  }
  async deleteAgent(accountId:string, organizationId:string, agentId:string):Promise<void> {
    await this.transaction(async db => {
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE", [organizationId]);
      await this.membership(db,accountId,organizationId);
      await this.assertNoPendingTransfer(db,organizationId,agentId);
      const agent=(await db.query("SELECT id FROM agents_platform.agents WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE",[organizationId,agentId])).rows[0] ?? absent();
      if ((await db.query(`SELECT 1 FROM agents_platform.tasks t JOIN agents_platform.agent_versions v ON v.id=t.version_id
        WHERE v.organization_id=$1 AND v.agent_id=$2 AND (t.state NOT IN ('completed','incomplete','refused','failed','cancelled') OR t.disposition<>'settled') LIMIT 1`,[organizationId,agent.id])).rowCount)
        throw new PlatformError("AGENT_TASKS_ACTIVE",409,"Wait for active agent tasks to finish before deleting");
      await db.query("UPDATE agents_platform.website_deployments SET revoked_at=now() WHERE organization_id=$1 AND agent_id=$2 AND revoked_at IS NULL",[organizationId,agent.id]);
      await db.query("UPDATE agents_platform.channel_deployments SET state='revoked',revision=revision+1,updated_at=now() WHERE organization_id=$1 AND agent_id=$2 AND state<>'revoked'",[organizationId,agent.id]);
      if ((await db.query(`SELECT 1 FROM agents_platform.channel_outbound o JOIN agents_platform.channel_deployments d ON d.id=o.deployment_id
        WHERE d.organization_id=$1 AND d.agent_id=$2 AND o.state='sending' LIMIT 1`,[organizationId,agent.id])).rowCount)
        throw new PlatformError("AGENT_DELIVERY_ACTIVE",409,"Wait for active message delivery to finish before deleting");
      await db.query(`UPDATE agents_platform.automations a SET state='paused',updated_at=now() FROM agents_platform.automation_revisions r JOIN agents_platform.agent_versions v ON v.id=r.version_id
        WHERE a.organization_id=$1 AND a.id=r.automation_id AND a.revision=r.revision AND v.agent_id=$2 AND a.state='active'`,[organizationId,agent.id]);
      await db.query(`UPDATE agents_platform.execution_grants SET revoked_at=now() WHERE organization_id=$1 AND revoked_at IS NULL
        AND version_id IN (SELECT id FROM agents_platform.agent_versions WHERE organization_id=$1 AND agent_id=$2)`,[organizationId,agent.id]);
      await db.query("UPDATE agents_platform.agents SET deleted_at=now(),updated_at=now() WHERE organization_id=$1 AND id=$2",[organizationId,agent.id]);
    });
  }
  async createAgent(input: { accountId: string; organizationId: string; name: string; offering?: "faq" | "customer-service"; configuration?: AgentConfiguration }): Promise<AgentRecord> {
    const config = agentConfigurationSchema.parse(input.configuration ?? customerConfiguration(input.offering));
    return this.transaction(async (db) => { await this.membership(db, input.accountId, input.organizationId);
      return (await db.query<AgentRecord>(`INSERT INTO agents_platform.agents(id,organization_id,name,avatar,draft,created_by,offering)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [randomUUID(), input.organizationId, text(input.name, 120), randomAgentAvatar(), config, input.accountId, input.offering??(input.configuration?null:"faq")])).rows[0]!; });
  }
  async updateDraft(input: { accountId: string; organizationId: string; agentId: string; name?: string; avatar?: string;
    configuration: AgentConfiguration; expectedRevision: number }): Promise<AgentRecord> {
    const config = agentConfigurationSchema.parse(input.configuration);
    return this.transaction(async (db) => { await this.membership(db, input.accountId, input.organizationId);
      await this.assertNoPendingTransfer(db,input.organizationId,input.agentId);
      const current=(await db.query<AgentRecord>("SELECT * FROM agents_platform.agents WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL AND draft_revision=$3 FOR UPDATE",[input.organizationId,input.agentId,input.expectedRevision])).rows[0];
      if(!current)throw new PlatformError("DRAFT_CONFLICT",409,"Agent settings changed. Refresh and try again.");
      const setup=updatedSupportHoursSetup(current,config);
      const row = (await db.query<AgentRecord>(`UPDATE agents_platform.agents SET draft=$4,name=coalesce($5,name),avatar=coalesce($6,avatar),setup=coalesce($7,setup),
        draft_revision=draft_revision+1,updated_at=now() WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL AND draft_revision=$3 RETURNING *`,
      [input.organizationId, input.agentId, input.expectedRevision, config, input.name === undefined ? null : text(input.name, 120),input.avatar??null,setup??null])).rows[0];
      if (!row) throw new PlatformError("DRAFT_CONFLICT", 409, "Agent settings changed. Refresh and try again.");
      return row; });
  }
  async updateAgentProfile(input: { accountId: string; organizationId: string; agentId: string; name?: string; avatar?: string }): Promise<AgentRecord> {
    if(input.name===undefined&&input.avatar===undefined)return this.getAgent(input.accountId,input.organizationId,input.agentId);
    return this.transaction(async (db) => { await this.membership(db, input.accountId, input.organizationId);
      await this.assertNoPendingTransfer(db,input.organizationId,input.agentId);
      const row=(await db.query<AgentRecord>(`UPDATE agents_platform.agents SET name=coalesce($3,name),avatar=coalesce($4,avatar),updated_at=now()
        WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL RETURNING *`,[input.organizationId,input.agentId,
        input.name===undefined?null:text(input.name,120),input.avatar??null])).rows[0]??absent();
      return row; });
  }
  async createConfiguredAgent(input: {accountId:string;organizationId:string;name:string;offering?:"faq"|"customer-service";configuration?:AgentConfiguration;setup?:CustomerSetup;operationId?:string}):Promise<{agent:AgentRecord;snapshot:VersionRecord;deployments:WebsiteDeployment[]}> {
    const setup=input.setup===undefined?null:customerSetupSchema.parse(input.setup);
    const config=agentConfigurationSchema.parse(setup?customerConfigurationForSetup(setup):input.configuration??customerConfiguration(input.offering));
    if (setup) {
      config.identity = defaultAgentIdentity({ offering: "customer-service", responsibilities: setup.responsibilities });
      config.guidance = defaultAgentGuidance({ offering: "customer-service", responsibilities: setup.responsibilities });
    }
    return this.transaction(async db=>{
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[input.organizationId]);
      await this.membership(db,input.accountId,input.organizationId);
      const digest=requestDigest({name:input.name,offering:input.offering??"customer-service",setup,...(input.configuration?{configuration:config}:{})});
      if(input.operationId){
        const existing=(await db.query<AgentRecord & {setup_request_digest:string}>("SELECT * FROM agents_platform.agents WHERE organization_id=$1 AND created_by=$2 AND setup_operation_id=$3",[input.organizationId,input.accountId,input.operationId])).rows[0];
        if(existing){
          if(existing.setup_request_digest!==digest)throw new PlatformError("SETUP_OPERATION_CONFLICT",409,"This creation request has changed. Resume the existing agent.");
          const snapshot=(await db.query<VersionRecord>("SELECT * FROM agents_platform.agent_versions WHERE organization_id=$1 AND agent_id=$2 ORDER BY number DESC LIMIT 1",[input.organizationId,existing.id])).rows[0]!;
          return {agent:existing,snapshot,deployments:[]};
        }
      }
      const agent=(await db.query<AgentRecord>(`INSERT INTO agents_platform.agents(id,organization_id,name,avatar,draft,created_by,offering,setup,setup_step,setup_operation_id,setup_request_digest)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[randomUUID(),input.organizationId,text(input.name,120),randomAgentAvatar(),config,input.accountId,setup?"customer-service":input.offering??(input.configuration?null:"faq"),setup,setup?"Responsibilities":null,input.operationId??null,input.operationId?digest:null])).rows[0]!;
      const snapshot=await this.createVersionInTransaction(db,{...input,agentId:agent.id},agent);
      return {agent,snapshot,deployments:[]};
    });
  }
  async saveConfiguration(input:{accountId:string;organizationId:string;agentId:string;name?:string;avatar?:string;configuration:AgentConfiguration;expectedRevision:number;confirmImpact?:boolean;setup?:CustomerSetup;setupStep?:string}):Promise<{agent:AgentRecord;snapshot:VersionRecord;deployments:WebsiteDeployment[]}> {
    return this.transaction(db=>this.saveConfigurationInTransaction(db,input));
  }
  async saveConfigurationInTransaction(db:PoolClient,input:{accountId:string;organizationId:string;agentId:string;name?:string;avatar?:string;configuration:AgentConfiguration;expectedRevision:number;confirmImpact?:boolean;setup?:CustomerSetup;setupStep?:string}):Promise<{agent:AgentRecord;snapshot:VersionRecord;deployments:WebsiteDeployment[]}> {
    let setup=input.setup===undefined?undefined:customerSetupSchema.parse(input.setup);
    let config=agentConfigurationSchema.parse(input.configuration);
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[input.organizationId]);
      await this.membership(db,input.accountId,input.organizationId);
      await this.assertNoPendingTransfer(db,input.organizationId,input.agentId);
      let agent=(await db.query<AgentRecord>("SELECT * FROM agents_platform.agents WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE",[input.organizationId,input.agentId])).rows[0]??absent();
      if(setup){
        const derivedBefore=agent.setup?customerConfigurationForSetup(agent.setup).instructions:null;
        const customInstructions=derivedBefore!==null?agent.draft.instructions!==derivedBefore:
          !new Set([defaultBusinessConfiguration().instructions,customerConfiguration("faq").instructions,customerConfiguration("customer-service").instructions]).has(agent.draft.instructions);
        const next=applyCustomerSetup(config,setup,agent.setup??undefined);
        if(customInstructions)next.instructions=agent.draft.instructions;
        Object.assign(next,setupUpdatedLayers(config,{offering:agent.offering,responsibilities:agent.setup?.responsibilities??null},{offering:agent.offering,responsibilities:setup.responsibilities}));
        config=agentConfigurationSchema.parse(next);
      }
      else setup=updatedSupportHoursSetup(agent,config);
      if(agent.draft_revision!==input.expectedRevision)throw new PlatformError("DRAFT_CONFLICT",409,"The configuration has changed. Refresh and try again.");
      const latest=(await db.query<VersionRecord>("SELECT * FROM agents_platform.agent_versions WHERE organization_id=$1 AND agent_id=$2 ORDER BY number DESC LIMIT 1",[input.organizationId,input.agentId])).rows[0];
      const previous=latest?agentConfigurationSchema.parse(latest.configuration):null;
      const authority=previous?configurationAuthorityChange(previous,config):{expanded:false,reduced:false};
      if(authority.reduced)await db.query(`SELECT g.id FROM agents_platform.execution_grants g
        WHERE g.organization_id=$1 AND g.revoked_at IS NULL AND g.version_id IN
        (SELECT id FROM agents_platform.agent_versions WHERE organization_id=$1 AND agent_id=$2)
        ORDER BY g.id FOR UPDATE OF g`,[input.organizationId,input.agentId]);
      let deployments=(await db.query<WebsiteDeployment>("SELECT * FROM agents_platform.website_deployments WHERE organization_id=$1 AND agent_id=$2 AND revoked_at IS NULL AND NOT EXISTS (SELECT 1 FROM agents_platform.evaluation_trial_channels e WHERE e.deployment_id=website_deployments.id) ORDER BY id FOR UPDATE",[input.organizationId,input.agentId])).rows;
      const channelDeployments = (await db.query("SELECT id,agent_id FROM agents_platform.channel_deployments WHERE organization_id=$1 AND agent_id=$2 AND state='active' ORDER BY id FOR UPDATE", [input.organizationId,input.agentId])).rows;
      const name=input.name===undefined?agent.name:text(input.name,120);
      const avatar=input.avatar??agent.avatar;
      const setupChanged=(setup!==undefined&&!isDeepStrictEqual(agent.setup,setup))||(input.setupStep!==undefined&&agent.setup_step!==input.setupStep);
      const changed=!isDeepStrictEqual(agentConfigurationSchema.parse(agent.draft),config)||setupChanged;
      let refreshRelease = false;
      if (!changed && latest && latest.draft_revision === agent.draft_revision) {
        const bindings = (await db.query("SELECT binding FROM agents_platform.capability_bindings WHERE organization_id=$1 AND id=ANY($2::uuid[])", [input.organizationId, config.connectedToolBindingIds])).rows.map(row => capabilityBindingSchema.parse(row.binding));
        if (bindings.length !== config.connectedToolBindingIds.length) throw new PlatformError("CAPABILITY_BINDING_UNAVAILABLE",409,"Published connected tools are unavailable");
        const current = compilePublishedComposition(config, bindings);
        try { assertComposition(latest.effective_composition, current); }
        catch (error) {
          if (!(error instanceof PlatformError) || error.code !== "PROGRAM_RELEASE_UNAVAILABLE") throw error;
          const accepted=compilePublishedComposition(config,bindings,latest.effective_composition.runtime,latest.tool_bindings);
          assertInspectableComposition(latest.effective_composition, accepted);
          refreshRelease = true;
        }
      }
      if(!changed&&!refreshRelease&&latest&&latest.draft_revision===agent.draft_revision&&name===agent.name&&avatar===agent.avatar)return {agent,snapshot:latest,deployments};
      if(!changed&&!refreshRelease&&latest&&latest.draft_revision===agent.draft_revision){
        agent=(await db.query<AgentRecord>("UPDATE agents_platform.agents SET name=$3,avatar=$4,updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING *",[input.organizationId,input.agentId,name,avatar])).rows[0]!;
        return {agent,snapshot:latest,deployments};
      }
      if(input.confirmImpact!==true&&(((previous?canonical(previous)!==canonical(config):changed)&&(deployments.length>0||channelDeployments.length>0))||authority.expanded))throw new PlatformError("CONFIGURATION_CONFIRMATION_REQUIRED",409,"Confirm changes to agent permissions or connected customer channels.");
      agent=(await db.query<AgentRecord>(`UPDATE agents_platform.agents SET draft=$3,name=$4,avatar=$7,setup=coalesce($5,setup),setup_step=coalesce($6,setup_step),draft_revision=draft_revision+1,updated_at=now()
        WHERE organization_id=$1 AND id=$2 RETURNING *`,[input.organizationId,input.agentId,config,name,setup??null,input.setupStep??null,avatar])).rows[0]!;
      const snapshot=await this.createVersionInTransaction(db,input,agent);
      const deploymentStore=new DeploymentStore(this.pool);
      for(const deployment of deployments)await deploymentStore.assertWebsiteConfigurationInTransaction(db,{organizationId:input.organizationId,agentId:deployment.agent_id,version:snapshot});
      if (channelDeployments.length) {
        await deploymentStore.assertWebsiteConfigurationInTransaction(db,{organizationId:input.organizationId,agentId:input.agentId,version:snapshot});
        await db.query("UPDATE agents_platform.channel_deployments SET version_id=$3,revision=revision+1,updated_at=now() WHERE organization_id=$1 AND agent_id=$2 AND state='active'",[input.organizationId,input.agentId,snapshot.id]);
      }
      if(deployments.length)deployments=(await db.query<WebsiteDeployment>(`UPDATE agents_platform.website_deployments SET version_id=$3
        WHERE organization_id=$1 AND agent_id=$2 AND revoked_at IS NULL AND NOT EXISTS (SELECT 1 FROM agents_platform.evaluation_trial_channels e WHERE e.deployment_id=website_deployments.id) RETURNING *`,[input.organizationId,input.agentId,snapshot.id])).rows;
      if(authority.reduced)await db.query(`UPDATE agents_platform.execution_grants SET revoked_at=now()
        WHERE organization_id=$1 AND revoked_at IS NULL AND version_id IN
        (SELECT id FROM agents_platform.agent_versions WHERE organization_id=$1 AND agent_id=$2 AND id<>$3)`,[input.organizationId,input.agentId,snapshot.id]);
      return {agent,snapshot,deployments};
  }
  async createVersion(input: { accountId: string; organizationId: string; agentId: string; expectedRevision: number }): Promise<VersionRecord> {
    return this.transaction(async (db) => {
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE", [input.organizationId]);
      await this.membership(db, input.accountId, input.organizationId);
      await this.assertNoPendingTransfer(db,input.organizationId,input.agentId);
      const agent = (await db.query<AgentRecord>("SELECT * FROM agents_platform.agents WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE", [input.organizationId, input.agentId])).rows[0] ?? absent();
      if (agent.draft_revision !== input.expectedRevision) throw new PlatformError("DRAFT_CONFLICT", 409, "Agent settings changed. Refresh and try again.");
      const existing = (await db.query<VersionRecord>("SELECT * FROM agents_platform.agent_versions WHERE agent_id=$1 AND draft_revision=$2 ORDER BY number DESC LIMIT 1", [agent.id, agent.draft_revision])).rows[0];
      if (existing) return existing;
      return this.createVersionInTransaction(db,input,agent);

    });
  }
  async createVersionInTransaction(db:PoolClient,input:{accountId:string;organizationId:string;agentId:string},agent:AgentRecord):Promise<VersionRecord> {
      const config = agentConfigurationSchema.parse(agent.draft);
      if (config.tools.includes("channel.request_handoff"))
        await assertAgentsBillingFeature(this.pool, input.organizationId, "agents.feature.handoff");
      const connectedAuthority = connectedToolAuthorityIds(config);
      if (config.model.selection.kind === "connection") {
        const selection = config.model.selection;
        const active = await db.query(`SELECT 1 FROM agents_platform.model_provider_use_grants g
          JOIN agents_platform.model_provider_connections c ON c.id=g.connection_id AND c.organization_id=g.organization_id
          WHERE g.organization_id=$1 AND g.connection_id=$2 AND g.consumer=$3::jsonb AND g.state='active' AND c.state='active'
          AND g.model_ids ? $4 AND g.roles ?& array['primary','compaction','delegated'] FOR SHARE OF g,c`,
        [input.organizationId, selection.connectionId, JSON.stringify({ kind: "agent", agentId: agent.id }), selection.modelId]);
        if (!active.rowCount) {
          const published = (await db.query("SELECT configuration FROM agents_platform.agent_versions WHERE organization_id=$1 AND agent_id=$2 ORDER BY number DESC LIMIT 1", [input.organizationId, agent.id])).rows[0];
          if (published && canonical(agentConfigurationSchema.parse(published.configuration).model.selection) === canonical(selection)) {
            throw new PlatformError("MODEL_USE_REAUTHORIZATION_REQUIRED", 409, "An owner must reauthorize this model connection before it can be reused");
          }
          const owner = await db.query("SELECT 1 FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND role='owner' AND revoked_at IS NULL FOR SHARE", [input.organizationId, input.accountId]);
          if (!owner.rowCount) throw new PlatformError("MODEL_USE_DENIED", 403, "An owner must authorize a new model connection");
          const connection = await db.query("SELECT 1 FROM agents_platform.model_provider_connections WHERE organization_id=$1 AND id=$2 AND state='active' FOR SHARE", [input.organizationId, selection.connectionId]);
          if (!connection.rowCount) throw new PlatformError("MODEL_CONNECTION_UNAVAILABLE", 409, "Reconnect the selected model provider");
          await db.query(`INSERT INTO agents_platform.model_provider_use_grants(id,organization_id,connection_id,consumer,roles,model_ids)
            VALUES($1,$2,$3,$4,$5,$6)`, [randomUUID(), input.organizationId, selection.connectionId, { kind: "agent", agentId: agent.id },
            JSON.stringify(["primary","compaction","delegated"]), JSON.stringify([selection.modelId])]);
        }
      }
      if(config.capabilities.businessActions.enabled)await loadBookingPolicy(db,input.organizationId,agent.id,config.capabilities.businessActions);
      if (config.capabilities.delegation.enabled) {
        for (const binding of config.capabilities.delegation.bindings) {
          const child = (await db.query<VersionRecord&{agent_name:string}>(`SELECT v.*,a.name AS agent_name FROM agents_platform.agent_versions v
            JOIN agents_platform.agents a ON a.organization_id=v.organization_id AND a.id=v.agent_id
            WHERE v.organization_id=$1 AND v.id=$2 FOR SHARE OF v`, [input.organizationId,binding.versionId])).rows[0];
          if (!child || child.agent_id === agent.id) throw new PlatformError("DELEGATION_BINDING_INVALID",409,"Choose a published specialist from this workspace");
          const childConfig = agentConfigurationSchema.parse(child.configuration);
          let effective:AgentConfiguration;
          try { effective=delegatedConfiguration(config,binding,childConfig); }
          catch(error){if(error instanceof PlatformError)throw new PlatformError("DELEGATION_BINDING_INVALID",409,"Specialist binding exceeds the published scope");throw error;}
          const effectiveBindings=(await db.query("SELECT binding FROM agents_platform.capability_bindings WHERE organization_id=$1 AND id=ANY($2::uuid[])",[input.organizationId,connectedToolAuthorityIds(effective)])).rows;
          assertConnectedBindingDependencies(effectiveBindings.filter(row=>effective.connectedToolBindingIds.includes(row.binding.id)).map(row=>capabilityBindingSchema.parse(row.binding)));
          if(config.program.version==="4")await delegatedSkills(db,{organizationId:input.organizationId,agentId:child.agent_id,configuration:effective,connectedBindings:effectiveBindings.filter(row=>effective.connectedToolBindingIds.includes(row.binding.id)).map(row=>capabilityBindingSchema.parse(row.binding))});
          binding.label=child.agent_name;
          binding.description=Array.from(childConfig.instructions.replace(/\s+/g," ")).slice(0,512).join("");
          binding.versionNumber=child.number;
        }
      }
      if(config.capabilities.workflows.enabled) {
        const connection=await db.query("SELECT id FROM agents_platform.connections WHERE id=$1 AND organization_id=$2 AND account_id=$3 AND state='active' AND profile_id='report-delivery-v1' AND expires_at>now() FOR SHARE",[config.capabilities.workflows.connectionId,input.organizationId,input.accountId]);
        if(!connection.rowCount)throw new PlatformError("WORKFLOW_CONNECTION_UNAVAILABLE",409,"Choose an active report connection owned by this account");
      }
      const sources = (await db.query(`SELECT r.id,r.source_id,r.embedding_release,r.text_bytes FROM agents_platform.source_revisions r
        JOIN agents_platform.sources s ON s.id=r.source_id AND s.organization_id=r.organization_id
        JOIN agents_platform.source_revision_policy p ON p.revision_id=r.id AND p.organization_id=r.organization_id
        WHERE r.organization_id=$1 AND r.id=ANY($2::uuid[]) AND s.state='active' AND p.state='approved' ORDER BY s.id FOR SHARE OF s,p`, [input.organizationId, sourceAuthorityIds(config)])).rows;
      if (sources.length !== sourceAuthorityIds(config).length || new Set(sources.map(source => source.source_id)).size !== sources.length) throw new PlatformError("SOURCE_REVISION_UNAVAILABLE", 409, "Choose one approved revision per source");
      config.knowledge = { mode: resolveKnowledgeMode({ requested: config.knowledge?.mode ?? "auto", offering: agent.offering,
        sourceBytes: sources.reduce((total, source) => total + Number(source.text_bytes ?? 0), 0) }) };
      const retrieval = config.retrievalProfile;
      if (retrieval.kind === "hybrid-v1" && sources.some(source => source.embedding_release !== retrieval.embeddingRelease)) throw new PlatformError("RETRIEVAL_PROFILE_CONFLICT", 409, "Source indexes do not match the retrieval profile");
      const connected = (await db.query(`SELECT b.id,b.binding FROM agents_platform.capability_bindings b JOIN agents_platform.connections c ON c.id=b.connection_id
        WHERE b.organization_id=$1 AND b.account_id=$2 AND b.id=ANY($3::uuid[]) AND c.state='active' AND c.expires_at>now()
        AND c.policy_revision=(b.binding->'connection'->>'policyRevision')::integer ORDER BY c.id FOR SHARE OF c`, [input.organizationId, input.accountId, connectedAuthority])).rows;
      if (connected.length !== connectedAuthority.length) throw new PlatformError("CAPABILITY_SCOPE_DENIED", 403, "Choose current connected tools owned by this account");
      assertConnectedBindingDependencies(connected.filter(row => config.connectedToolBindingIds.includes(row.id))
        .map(row => capabilityBindingSchema.parse(row.binding)));
      if (config.skillIds.length) {
        const selectedSkills=await loadSkillRevisions(db, input.organizationId, input.agentId, config.skillIds);
        const profiles=connected.map(row=>capabilityBindingSchema.parse(row.binding).connection?.profileId).filter((profile):profile is string=>!!profile);
        for(const skill of selectedSkills)if(skill.package)assertSkillRequirements(skill.package.requirements,config,profiles);
      }
      const composition = compilePublishedComposition(config, connected.filter(row => config.connectedToolBindingIds.includes(row.id)).map(row => capabilityBindingSchema.parse(row.binding)));
      const version = (await db.query<VersionRecord>(`INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,execution_kind,configuration,created_by,draft_revision,tool_bindings,effective_composition)
        SELECT $1,$2,$3,coalesce(max(number),0)+1,$4,$5,$6,$7,$8,$9 FROM agents_platform.agent_versions WHERE agent_id=$3 RETURNING *`,
      [randomUUID(), input.organizationId, input.agentId, config.executionKind, config, input.accountId, agent.draft_revision,JSON.stringify(publishedToolBindings(config)),composition])).rows[0]!;
      for (const source of sources) await db.query("INSERT INTO agents_platform.version_sources(organization_id,version_id,source_id,revision_id) VALUES($1,$2,$3,$4)", [input.organizationId, version.id, source.source_id, source.id]);
      for (const binding of connected) await db.query("INSERT INTO agents_platform.version_connected_tools(organization_id,version_id,binding_id) VALUES($1,$2,$3)", [input.organizationId, version.id, binding.id]);
      return version;
  }
  async listVersions(accountId: string, organizationId: string, agentId: string): Promise<VersionRecord[]> {
    return this.transaction(async (db) => {
      await this.membership(db, accountId, organizationId);
      if (!(await db.query("SELECT id FROM agents_platform.agents WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL", [organizationId, agentId])).rows[0]) absent();
      return (await db.query<VersionRecord>("SELECT * FROM agents_platform.agent_versions WHERE organization_id=$1 AND agent_id=$2 ORDER BY number DESC", [organizationId, agentId])).rows;
    });
  }
  async getVersion(accountId: string, organizationId: string, versionId: string): Promise<VersionRecord> {
    return this.transaction(async (db) => { await this.membership(db, accountId, organizationId); return this.version(db, organizationId, versionId); });
  }
  async createGrant(input: { accountId: string; grant: ExecutionGrant }): Promise<ExecutionGrant> {
    return this.transaction(db=>this.createGrantInTransaction(db,input));
  }
  async createGrantInTransaction(db:PoolClient,input:{accountId:string;grant:ExecutionGrant}):Promise<ExecutionGrant> {
    const grant = executionGrantSchema.parse(input.grant);
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[grant.organizationId]);
      await this.membership(db, input.accountId, grant.organizationId);
      const account = (await db.query<Account>("SELECT * FROM agents_platform.accounts WHERE id=$1", [input.accountId])).rows[0]!;
      const version = await this.version(db, grant.organizationId, grant.versionId);
      const current=(await db.query<VersionRecord>("SELECT * FROM agents_platform.agent_versions WHERE organization_id=$1 AND agent_id=$2 ORDER BY number DESC LIMIT 1",[grant.organizationId,version.agent_id])).rows[0];
      if(current&&current.id!==version.id){
        const latest=agentConfigurationSchema.parse(current.configuration),requested=agentConfigurationSchema.parse(version.configuration);
        if(configurationAuthorityChange(latest,requested).expanded||requested.model.maxInputBytes>latest.model.maxInputBytes||requested.model.maxOutputTokens>latest.model.maxOutputTokens||requested.model.maxDurationSeconds>latest.model.maxDurationSeconds||(configuredContext(requested)?.maxInputTokens??Infinity)>(configuredContext(latest)?.maxInputTokens??Infinity))
          throw new PlatformError("CONFIGURATION_SCOPE_REVOKED",403,"This saved configuration contains permissions that have been removed.");
      }
      if (grant.product !== "agents" || grant.callerClientId !== "agents-execution" || grant.resourceId !== version.agent_id ||
        grant.principal.kind !== "human" || grant.principal.issuer !== account.issuer || grant.principal.subject !== account.subject ||
        new Date(grant.expiresAt).getTime() > Date.now() + 30 * 60_000) denied();
      assertGrantAuthority(grant, { ...grant }, version.id, version.configuration);
      return this.insertGrant(db, grant);
  }
  async revokeGrant(accountId: string, organizationId: string, grantId: string): Promise<void> {
    await this.transaction(async (db) => { await this.membership(db, accountId, organizationId);
      if (!(await db.query("UPDATE agents_platform.execution_grants SET revoked_at=now() WHERE organization_id=$1 AND id=$2 RETURNING id", [organizationId, grantId])).rows[0]) absent(); });
  }
}
