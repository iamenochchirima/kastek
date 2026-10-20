import { createHash,randomUUID } from "node:crypto";
import type { Pool,PoolClient } from "pg";
import { assertConnectedBindingDependencies } from "../../capabilities/connected-tools/connected-tool-schema";
import { capabilityBindingSchema } from "../../contracts/capability-catalog";
import {
agentConfigurationSchema,assertGrantAuthority,
connectedToolAuthorityIds,
executionGrantSchema,
PlatformError,
type AgentConfiguration,type ExecutionGrant
} from "../../contracts/contracts";
import { assertSkillRequirements } from "../../capabilities/skills/requirement-authority";
import { loadBookingPolicy } from "../../workflows/booking/policy";
import { customerConfiguration } from "../offerings/offerings";
import { compilePublishedComposition } from "../../execution/programs/publication";

import { publishedToolBindings } from "../../capabilities/tools";

import type { Account,AgentRecord,VersionRecord } from "../../contracts/records";
import { AuthorityStore } from "../../execution/admission/authority-store";
import { loadSkillRevisions } from "../../execution/memory/memory";

type Db=Pool|PoolClient;
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


export class AgentStore extends AuthorityStore {
  async listAgents(accountId: string, organizationId: string): Promise<AgentRecord[]> {
    return this.transaction(async (db) => { await this.membership(db, accountId, organizationId);
      return (await db.query<AgentRecord>("SELECT * FROM agents_platform.agents WHERE organization_id=$1 ORDER BY created_at,id", [organizationId])).rows; });
  }
  async getAgent(accountId: string, organizationId: string, agentId: string): Promise<AgentRecord> {
    return this.transaction(async (db) => { await this.membership(db, accountId, organizationId);
      return (await db.query<AgentRecord>("SELECT * FROM agents_platform.agents WHERE organization_id=$1 AND id=$2", [organizationId, agentId])).rows[0] ?? absent(); });
  }
  async createAgent(input: { accountId: string; organizationId: string; name: string; offering?: "faq" | "customer-service"; configuration?: AgentConfiguration }): Promise<AgentRecord> {
    const config = agentConfigurationSchema.parse(input.configuration ?? customerConfiguration(input.offering));
    return this.transaction(async (db) => { await this.membership(db, input.accountId, input.organizationId);
      return (await db.query<AgentRecord>(`INSERT INTO agents_platform.agents(id,organization_id,name,draft,created_by,offering)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [randomUUID(), input.organizationId, text(input.name, 120), config, input.accountId, input.offering??(input.configuration?null:"faq")])).rows[0]!; });
  }
  async updateDraft(input: { accountId: string; organizationId: string; agentId: string; name?: string;
    configuration: AgentConfiguration; expectedRevision: number }): Promise<AgentRecord> {
    const config = agentConfigurationSchema.parse(input.configuration);
    return this.transaction(async (db) => { await this.membership(db, input.accountId, input.organizationId);
      const row = (await db.query<AgentRecord>(`UPDATE agents_platform.agents SET draft=$4,name=coalesce($5,name),
        draft_revision=draft_revision+1,updated_at=now() WHERE organization_id=$1 AND id=$2 AND draft_revision=$3 RETURNING *`,
      [input.organizationId, input.agentId, input.expectedRevision, config, input.name === undefined ? null : text(input.name, 120)])).rows[0];
      if (!row) throw new PlatformError("DRAFT_CONFLICT", 409, "The draft has changed. Refresh and try again.");
      return row; });
  }
  async createVersion(input: { accountId: string; organizationId: string; agentId: string; expectedRevision: number }): Promise<VersionRecord> {
    return this.transaction(async (db) => {
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE", [input.organizationId]);
      await this.membership(db, input.accountId, input.organizationId);
      const agent = (await db.query<AgentRecord>("SELECT * FROM agents_platform.agents WHERE organization_id=$1 AND id=$2 FOR UPDATE", [input.organizationId, input.agentId])).rows[0] ?? absent();
      if (agent.draft_revision !== input.expectedRevision) throw new PlatformError("DRAFT_CONFLICT", 409, "The draft has changed. Refresh and try again.");
      const existing = (await db.query<VersionRecord>("SELECT * FROM agents_platform.agent_versions WHERE agent_id=$1 AND draft_revision=$2", [agent.id, agent.draft_revision])).rows[0];
      if (existing) return existing;
      const config = agentConfigurationSchema.parse(agent.draft);
      const connectedAuthority = connectedToolAuthorityIds(config);
      if(config.capabilities.businessActions.enabled)await loadBookingPolicy(db,input.organizationId,agent.id,config.capabilities.businessActions);
      if (config.capabilities.delegation.enabled) {
        for (const binding of config.capabilities.delegation.bindings) {
          const child = (await db.query<VersionRecord&{agent_name:string}>(`SELECT v.*,a.name AS agent_name FROM agents_platform.agent_versions v
            JOIN agents_platform.agents a ON a.organization_id=v.organization_id AND a.id=v.agent_id
            WHERE v.organization_id=$1 AND v.id=$2 FOR SHARE OF v`, [input.organizationId,binding.versionId])).rows[0];
          if (!child || child.agent_id === agent.id) throw new PlatformError("DELEGATION_BINDING_INVALID",409,"Choose a published specialist from this workspace");
          const childConfig = agentConfigurationSchema.parse(child.configuration);
          if (childConfig.executionKind !== "business" || childConfig.memory.enabled || childConfig.capabilities.delegation.enabled || childConfig.capabilities.sandbox.enabled || childConfig.capabilities.workflows.enabled || childConfig.capabilities.businessActions.enabled ||
              binding.sourceRevisionIds.some(id => !config.sourceRevisionIds.includes(id) || !childConfig.sourceRevisionIds.includes(id)) ||
              binding.connectedToolBindingIds.some(id => !childConfig.connectedToolBindingIds.includes(id)) ||
              binding.tools.some(tool => !childConfig.tools.includes(tool))) throw new PlatformError("DELEGATION_BINDING_INVALID",409,"Specialist binding exceeds the published scope");
          const effectiveBindings=(await db.query("SELECT binding FROM agents_platform.capability_bindings WHERE organization_id=$1 AND id=ANY($2::uuid[])",[input.organizationId,binding.connectedToolBindingIds])).rows;
          assertConnectedBindingDependencies(effectiveBindings.map(row=>capabilityBindingSchema.parse(row.binding)));
          binding.label=child.agent_name;
          binding.description=Array.from(childConfig.instructions.replace(/\s+/g," ")).slice(0,512).join("");
          binding.versionNumber=child.number;
        }
      }
      if(config.capabilities.workflows.enabled) {
        const connection=await db.query("SELECT id FROM agents_platform.connections WHERE id=$1 AND organization_id=$2 AND account_id=$3 AND state='active' AND profile_id='report-delivery-v1' AND expires_at>now() FOR SHARE",[config.capabilities.workflows.connectionId,input.organizationId,input.accountId]);
        if(!connection.rowCount)throw new PlatformError("WORKFLOW_CONNECTION_UNAVAILABLE",409,"Choose an active report connection owned by this account");
      }
      const sources = (await db.query(`SELECT r.id,r.source_id,r.embedding_release,s.visibility FROM agents_platform.source_revisions r
        JOIN agents_platform.sources s ON s.id=r.source_id AND s.organization_id=r.organization_id
        JOIN agents_platform.source_revision_policy p ON p.revision_id=r.id AND p.organization_id=r.organization_id
        WHERE r.organization_id=$1 AND r.id=ANY($2::uuid[]) AND s.state='active' AND p.state='approved' ORDER BY s.id FOR SHARE OF s,p`, [input.organizationId, config.sourceRevisionIds])).rows;
      if (sources.length !== config.sourceRevisionIds.length || new Set(sources.map(source => source.source_id)).size !== sources.length) throw new PlatformError("SOURCE_REVISION_UNAVAILABLE", 409, "Choose one approved revision per source");
      if (sources.some(source => source.visibility === "private") && !(await db.query("SELECT 1 FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND role='owner' AND revoked_at IS NULL", [input.organizationId, input.accountId])).rowCount) throw new PlatformError("SOURCE_GRANT_DENIED", 403, "An owner must publish protected knowledge grants");
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
    });
  }
  async listVersions(accountId: string, organizationId: string, agentId: string): Promise<VersionRecord[]> {
    return this.transaction(async (db) => {
      await this.membership(db, accountId, organizationId);
      if (!(await db.query("SELECT id FROM agents_platform.agents WHERE organization_id=$1 AND id=$2", [organizationId, agentId])).rows[0]) absent();
      return (await db.query<VersionRecord>("SELECT * FROM agents_platform.agent_versions WHERE organization_id=$1 AND agent_id=$2 ORDER BY number DESC", [organizationId, agentId])).rows;
    });
  }
  async getVersion(accountId: string, organizationId: string, versionId: string): Promise<VersionRecord> {
    return this.transaction(async (db) => { await this.membership(db, accountId, organizationId); return this.version(db, organizationId, versionId); });
  }
  async createGrant(input: { accountId: string; grant: ExecutionGrant }): Promise<ExecutionGrant> {
    const grant = executionGrantSchema.parse(input.grant);
    return this.transaction(async (db) => {
      await this.membership(db, input.accountId, grant.organizationId);
      const account = (await db.query<Account>("SELECT * FROM agents_platform.accounts WHERE id=$1", [input.accountId])).rows[0]!;
      const version = await this.version(db, grant.organizationId, grant.versionId);
      if (grant.product !== "agents" || grant.callerClientId !== "agents-execution" || grant.resourceId !== version.agent_id ||
        grant.principal.kind !== "human" || grant.principal.issuer !== account.issuer || grant.principal.subject !== account.subject ||
        new Date(grant.expiresAt).getTime() > Date.now() + 30 * 60_000) denied();
      assertGrantAuthority(grant, { ...grant }, version.id, version.configuration);
      return this.insertGrant(db, grant);
    });
  }
  async revokeGrant(accountId: string, organizationId: string, grantId: string): Promise<void> {
    await this.transaction(async (db) => { await this.membership(db, accountId, organizationId);
      if (!(await db.query("UPDATE agents_platform.execution_grants SET revoked_at=now() WHERE organization_id=$1 AND id=$2 RETURNING id", [organizationId, grantId])).rows[0]) absent(); });
  }
}
