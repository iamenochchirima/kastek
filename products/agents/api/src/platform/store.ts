import {assertConnectedBindingDependencies} from "./connected-tool-schema";
import {capabilityBindingSchema} from "./capability-catalog";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { agentConfigurationSchema, assertGrantAuthority, assertRuntimeAvailable, canonicalJson, defaultFaqConfiguration,
  executionGrantSchema, initialLimits, parseAllowedOrigin, PlatformError, requestDigest, connectedToolAuthorityIds,
  type AdmissionAuthority, type AgentConfiguration, type ExecutionGrant, type TaskState } from "./contracts";

import {transaction} from "./database";
import {assertAutomationAdmission,resolveAutomationOwner} from "./automation-authority";
import {publishedToolBindings} from "./tools";

type Db = Pool | PoolClient;
export interface Account { id: string; issuer: string; subject: string; email: string; display_name: string }
export interface Organization { id: string; name: string; role: "owner" | "member" }
export interface Session { account: Account; providerSessionId: string; expiresAt: Date }
export interface AgentRecord { id: string; organization_id: string; name: string; draft: AgentConfiguration;
  draft_revision: number; created_by: string; created_at: Date; updated_at: Date }
export interface VersionRecord { id: string; organization_id: string; agent_id: string; number: number;
  draft_revision: number; execution_kind: "business" | "workspace"; configuration: AgentConfiguration; created_by: string; created_at: Date }
export interface WebsiteDeployment { id: string; organization_id: string; agent_id: string; version_id: string;
  allowed_origins: string[]; published_by: string; published_at: Date; revoked_at: Date | null }
export interface TaskRecord { id: string; product: AdmissionAuthority["product"]; organization_id: string; resource_id: string;
  caller_client_id: string; principal: AdmissionAuthority["principal"]; version_id: string; grant_id: string;
  conversation_id: string; request_key: string; request_digest: string; input: string; state: TaskState;
  runtime_invocation_id: string | null; output: string | null; error_code: string | null; created_at: Date; updated_at: Date;
  root_task_id: string; parent_task_id: string | null; depth: number; root_token_limit: number; disposition: string;
  delegation_operation_id: string | null; allocation_active_ms: number; allocation_released: boolean; effective_configuration: AgentConfiguration | null }
export interface TaskEvent { sequence: string; task_id: string; event_key: string; kind: string; payload: Record<string,unknown>; created_at: Date }
export interface AdmitTaskInput { authority: AdmissionAuthority; grantId: string; versionId: string;
  requestKey: string; input: string; conversationId?: string }
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

/** Public methods accept only identities and authority established by the trusted HTTP/auth layer. */
export class PlatformStore {
  constructor(readonly pool: Pool) {}
  private transaction<T>(work: (db:PoolClient)=>Promise<T>):Promise<T> { return transaction(this.pool,work); }
  private async membership(db: Db, accountId: string, org: string): Promise<void> {
    const row = await db.query(`SELECT account_id FROM agents_platform.memberships
      WHERE account_id=$1 AND organization_id=$2 AND revoked_at IS NULL FOR SHARE`, [accountId, org]);
    if (!row.rows[0]) denied();
  }
  async requireMembership(accountId: string, organizationId: string): Promise<void> {
    await this.membership(this.pool, accountId, organizationId);
  }
  /** Call only after server-side OIDC claim validation. */
  async ensureAccount(input: { issuer: string; subject: string; email: string; displayName: string }): Promise<Account> {
    return (await this.pool.query<Account>(`INSERT INTO agents_platform.accounts(id,issuer,subject,email,display_name)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT(issuer,subject) DO UPDATE SET email=excluded.email,display_name=excluded.display_name
      RETURNING id,issuer,subject,email,display_name`,
    [randomUUID(), text(input.issuer, 2048), text(input.subject, 512), text(input.email, 320), text(input.displayName, 256)])).rows[0]!;
  }
  async createOrganization(accountId: string, name: string): Promise<Organization> {
    return this.transaction(async (db) => {
      if (!(await db.query("SELECT id FROM agents_platform.accounts WHERE id=$1 FOR SHARE", [accountId])).rows[0]) denied();
      const row = (await db.query<{ id: string; name: string }>("INSERT INTO agents_platform.organizations(id,name) VALUES($1,$2) RETURNING id,name", [randomUUID(), text(name, 120)])).rows[0]!;
      await db.query("INSERT INTO agents_platform.memberships(organization_id,account_id,role) VALUES($1,$2,'owner')", [row.id, accountId]);
      return { ...row, role: "owner" };
    });
  }
  async listOrganizations(accountId: string): Promise<Organization[]> {
    return (await this.pool.query<Organization>(`SELECT o.id,o.name,m.role FROM agents_platform.organizations o
      JOIN agents_platform.memberships m ON m.organization_id=o.id WHERE m.account_id=$1 AND m.revoked_at IS NULL ORDER BY o.created_at,o.id`, [accountId])).rows;
  }
  async createSession(input: { accountId: string; providerSessionId: string; expiresAt: Date }): Promise<{ token: string; expiresAt: Date }> {
    const expiresAt = new Date(Math.min(input.expiresAt.getTime(), Date.now() + 30 * 86_400_000));
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) throw new PlatformError("SESSION_EXPIRED", 401, "Fresh authentication required");
    const token = randomBytes(32).toString("base64url");
    await this.pool.query("INSERT INTO agents_platform.sessions(token_hash,account_id,provider_session_id,expires_at) VALUES($1,$2,$3,$4)", [hash(token), input.accountId, text(input.providerSessionId, 512), expiresAt]);
    return { token, expiresAt };
  }
  async getSession(token: string): Promise<Session | null> {
    const digest = tokenHash(token); if (!digest) return null;
    const row = (await this.pool.query<Account & { provider_session_id: string; expires_at: Date }>(`WITH touched AS (
      UPDATE agents_platform.sessions SET last_seen_at=now() WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()
      AND last_seen_at>now()-interval '7 days' RETURNING account_id,provider_session_id,expires_at)
      SELECT a.id,a.issuer,a.subject,a.email,a.display_name,t.provider_session_id,t.expires_at
      FROM touched t JOIN agents_platform.accounts a ON a.id=t.account_id`, [digest])).rows[0];
    if (!row) return null;
    const { provider_session_id, expires_at, ...account } = row;
    return { account, providerSessionId: provider_session_id, expiresAt: expires_at };
  }
  async revokeSession(token: string): Promise<void> {
    const digest = tokenHash(token);
    if (digest) await this.pool.query("UPDATE agents_platform.sessions SET revoked_at=now() WHERE token_hash=$1", [digest]);
  }
  async revokeProviderSession(issuer: string, providerSessionId: string): Promise<void> {
    await this.pool.query(`UPDATE agents_platform.sessions s SET revoked_at=now() FROM agents_platform.accounts a
      WHERE a.id=s.account_id AND a.issuer=$1 AND s.provider_session_id=$2`, [issuer, providerSessionId]);
  }
  async listAgents(accountId: string, organizationId: string): Promise<AgentRecord[]> {
    return this.transaction(async (db) => { await this.membership(db, accountId, organizationId);
      return (await db.query<AgentRecord>("SELECT * FROM agents_platform.agents WHERE organization_id=$1 ORDER BY created_at,id", [organizationId])).rows; });
  }
  async getAgent(accountId: string, organizationId: string, agentId: string): Promise<AgentRecord> {
    return this.transaction(async (db) => { await this.membership(db, accountId, organizationId);
      return (await db.query<AgentRecord>("SELECT * FROM agents_platform.agents WHERE organization_id=$1 AND id=$2", [organizationId, agentId])).rows[0] ?? absent(); });
  }
  async createAgent(input: { accountId: string; organizationId: string; name: string; configuration?: AgentConfiguration }): Promise<AgentRecord> {
    const config = agentConfigurationSchema.parse(input.configuration ?? defaultFaqConfiguration());
    return this.transaction(async (db) => { await this.membership(db, input.accountId, input.organizationId);
      return (await db.query<AgentRecord>(`INSERT INTO agents_platform.agents(id,organization_id,name,draft,created_by)
        VALUES($1,$2,$3,$4,$5) RETURNING *`, [randomUUID(), input.organizationId, text(input.name, 120), config, input.accountId])).rows[0]!; });
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
      if (config.capabilities.delegation.enabled) {
        for (const binding of config.capabilities.delegation.bindings) {
          const child = (await db.query<VersionRecord&{agent_name:string}>(`SELECT v.*,a.name AS agent_name FROM agents_platform.agent_versions v
            JOIN agents_platform.agents a ON a.organization_id=v.organization_id AND a.id=v.agent_id
            WHERE v.organization_id=$1 AND v.id=$2 FOR SHARE OF v`, [input.organizationId,binding.versionId])).rows[0];
          if (!child || child.agent_id === agent.id) throw new PlatformError("DELEGATION_BINDING_INVALID",409,"Choose a published specialist from this workspace");
          const childConfig = agentConfigurationSchema.parse(child.configuration);
          if (childConfig.executionKind !== "business" || childConfig.memory.enabled || childConfig.capabilities.delegation.enabled || childConfig.capabilities.sandbox.enabled || childConfig.capabilities.workflows.enabled ||
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
      if (sources.some(source => source.visibility === "private") && !(await db.query("SELECT 1 FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND role='owner' AND revoked_at IS NULL", [input.organizationId, input.accountId])).rowCount) throw new PlatformError("SOURCE_GRANT_DENIED", 403, "An owner must publish private knowledge grants");
      const retrieval = config.retrievalProfile;
      if (retrieval.kind === "hybrid-v1" && sources.some(source => source.embedding_release !== retrieval.embeddingRelease)) throw new PlatformError("RETRIEVAL_PROFILE_CONFLICT", 409, "Source indexes do not match the retrieval profile");
      const connected = (await db.query(`SELECT b.id FROM agents_platform.capability_bindings b JOIN agents_platform.connections c ON c.id=b.connection_id
        WHERE b.organization_id=$1 AND b.account_id=$2 AND b.id=ANY($3::uuid[]) AND c.state='active' AND c.expires_at>now()
        AND c.policy_revision=(b.binding->'connection'->>'policyRevision')::integer ORDER BY c.id FOR SHARE OF c`, [input.organizationId, input.accountId, connectedAuthority])).rows;
      if (connected.length !== connectedAuthority.length) throw new PlatformError("CAPABILITY_SCOPE_DENIED", 403, "Choose current connected tools owned by this account");
      if (config.skillIds.length) {
        const skills = await db.query("SELECT id FROM agents_platform.skill_revisions WHERE organization_id=$1 AND agent_id=$2 AND id=ANY($3::uuid[]) FOR SHARE", [input.organizationId,input.agentId,config.skillIds]);
        if (skills.rowCount !== new Set(config.skillIds).size) denied();
      }
      const version = (await db.query<VersionRecord>(`INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,execution_kind,configuration,created_by,draft_revision,tool_bindings)
        SELECT $1,$2,$3,coalesce(max(number),0)+1,$4,$5,$6,$7,$8 FROM agents_platform.agent_versions WHERE agent_id=$3 RETURNING *`,
      [randomUUID(), input.organizationId, input.agentId, config.executionKind, config, input.accountId, agent.draft_revision,JSON.stringify(publishedToolBindings(config))])).rows[0]!;
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
  async listDeployments(accountId: string, organizationId: string, agentId: string): Promise<WebsiteDeployment[]> {
    return this.transaction(async (db) => {
      await this.membership(db, accountId, organizationId);
      if (!(await db.query("SELECT id FROM agents_platform.agents WHERE organization_id=$1 AND id=$2", [organizationId, agentId])).rows[0]) absent();
      return (await db.query<WebsiteDeployment>("SELECT * FROM agents_platform.website_deployments WHERE organization_id=$1 AND agent_id=$2 ORDER BY published_at DESC,id", [organizationId, agentId])).rows;
    });
  }
  private async version(db: Db, organizationId: string, versionId: string): Promise<VersionRecord> {
    return (await db.query<VersionRecord>("SELECT * FROM agents_platform.agent_versions WHERE organization_id=$1 AND id=$2 FOR SHARE", [organizationId, versionId])).rows[0] ?? absent();
  }
  async getVersion(accountId: string, organizationId: string, versionId: string): Promise<VersionRecord> {
    return this.transaction(async (db) => { await this.membership(db, accountId, organizationId); return this.version(db, organizationId, versionId); });
  }
  async publishWebsite(input: { accountId: string; organizationId: string; agentId: string; versionId: string; allowedOrigins: string[] }): Promise<WebsiteDeployment> {
    const origins = [...new Set(input.allowedOrigins.map(parseAllowedOrigin))];
    if (origins.length < 1 || origins.length > 10) throw new PlatformError("INVALID_ORIGIN", 400, "Select 1 to 10 website origins");
    return this.transaction(async (db) => {
      await this.membership(db, input.accountId, input.organizationId);
      const version = await this.version(db, input.organizationId, input.versionId);
      if (version.agent_id !== input.agentId) denied();
      if (version.configuration.capabilities.delegation.enabled || version.configuration.capabilities.sandbox.enabled || version.configuration.capabilities.workflows.enabled) throw new PlatformError("WEBSITE_CAPABILITY_DENIED",409,"Website agents cannot delegate or run analysis");
      assertRuntimeAvailable(version.configuration);
      const websiteConfig = agentConfigurationSchema.parse(version.configuration);
      if (websiteConfig.memory.enabled || websiteConfig.skillIds.length || websiteConfig.connectedToolBindingIds.length || websiteConfig.tools.some(name=>name.startsWith("memory.")))
        throw new PlatformError("PRIVATE_AGENT_CONFIGURATION",409,"Website agents cannot use personal memory or private skills");
      if ((await db.query(`SELECT 1 FROM agents_platform.version_sources v JOIN agents_platform.sources s ON s.id=v.source_id
        JOIN agents_platform.source_revision_policy p ON p.revision_id=v.revision_id WHERE v.version_id=$1 AND (s.state<>'active' OR s.visibility<>'public' OR p.state<>'approved')`, [version.id])).rowCount) throw new PlatformError("PRIVATE_KNOWLEDGE", 409, "Website agents require approved public knowledge");
      return (await db.query<WebsiteDeployment>(`INSERT INTO agents_platform.website_deployments(id,organization_id,agent_id,version_id,allowed_origins,published_by)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [randomUUID(), input.organizationId, input.agentId, version.id, JSON.stringify(origins), input.accountId])).rows[0]!;
    });
  }
  async getWebsiteDeployment(deploymentId: string): Promise<WebsiteDeployment> {
    return (await this.pool.query<WebsiteDeployment>("SELECT * FROM agents_platform.website_deployments WHERE id=$1 AND revoked_at IS NULL", [deploymentId])).rows[0] ?? absent();
  }
  private async insertGrant(db: Db, grant: ExecutionGrant): Promise<ExecutionGrant> {
    await db.query(`INSERT INTO agents_platform.execution_grants(id,product,organization_id,resource_id,caller_client_id,principal,
      version_id,operations,max_input_bytes,max_output_tokens,expires_at,revoked_at,max_context_tokens,root_token_limit,source_revision_ids,connected_tool_binding_ids)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, [grant.id, grant.product, grant.organizationId, grant.resourceId,
      grant.callerClientId, grant.principal, grant.versionId, JSON.stringify(grant.operations),
      grant.maxInputBytes, grant.maxOutputTokens, grant.expiresAt, grant.revokedAt, grant.maxContextTokens, grant.rootTokenLimit, grant.sourceRevisionIds, grant.connectedToolBindingIds]);
    return grant;
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
  async createWebsiteGrant(input: { deploymentId: string; origin: string; sessionId: string }): Promise<ExecutionGrant> {
    return this.transaction(async (db) => {
      const deployment = (await db.query<WebsiteDeployment>("SELECT * FROM agents_platform.website_deployments WHERE id=$1 AND revoked_at IS NULL FOR SHARE", [input.deploymentId])).rows[0] ?? absent();
      if (!deployment.allowed_origins.includes(parseAllowedOrigin(input.origin))) denied();
      const version = await this.version(db, deployment.organization_id, deployment.version_id);
      assertRuntimeAvailable(version.configuration);
      const grant = executionGrantSchema.parse({ id: randomUUID(), product: "agents", organizationId: deployment.organization_id,
        resourceId: deployment.id, callerClientId: "agents-website", principal: { kind: "visitor", deploymentId: deployment.id, sessionId: input.sessionId },
        versionId: version.id, operations: ["model.reply", "knowledge.read"], sourceRevisionIds: version.configuration.sourceRevisionIds, connectedToolBindingIds: [],
        maxInputBytes: version.configuration.model.maxInputBytes, maxOutputTokens: version.configuration.model.maxOutputTokens,
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), revokedAt: null });
      return this.insertGrant(db, grant);
    });
  }
  async revokeGrant(accountId: string, organizationId: string, grantId: string): Promise<void> {
    await this.transaction(async (db) => { await this.membership(db, accountId, organizationId);
      if (!(await db.query("UPDATE agents_platform.execution_grants SET revoked_at=now() WHERE organization_id=$1 AND id=$2 RETURNING id", [organizationId, grantId])).rows[0]) absent(); });
  }
  private async assertPrincipal(db: Db, authority: AdmissionAuthority, version: VersionRecord): Promise<void> {
    if (authority.product !== "agents") denied();
    if (authority.principal.kind === "human") {
      if (authority.callerClientId !== "agents-execution" || authority.resourceId !== version.agent_id) denied();
      const account = (await db.query<Account>("SELECT * FROM agents_platform.accounts WHERE issuer=$1 AND subject=$2", [authority.principal.issuer, authority.principal.subject])).rows[0];
      if (!account) denied();
      await this.membership(db, account.id, authority.organizationId);
    } else if (authority.principal.kind === "visitor") {
      if (authority.callerClientId !== "agents-website" || authority.resourceId !== authority.principal.deploymentId) denied();
      const deployment = (await db.query<WebsiteDeployment>("SELECT * FROM agents_platform.website_deployments WHERE organization_id=$1 AND id=$2 AND revoked_at IS NULL FOR SHARE", [authority.organizationId, authority.principal.deploymentId])).rows[0];
      if (!deployment || deployment.version_id !== version.id || deployment.agent_id !== version.agent_id) denied();
    } else if(authority.principal.kind==="automation") await assertAutomationAdmission(db,authority,version);
    else denied();
  }
  async admitTask(input:AdmitTaskInput):Promise<{task:TaskRecord;replayed:boolean}> {
    return this.transaction(db=>this.admitTaskInTransaction(db,input));
  }
  async admitTaskInTransaction(db:PoolClient,input:AdmitTaskInput):Promise<{task:TaskRecord;replayed:boolean}> {
    const requestKey = text(input.requestKey, 128);
    if (!input.input.trim()) throw new PlatformError("INVALID_INPUT", 400, "Enter a message");

    // Serialize all admissions for this organization, including those across UTC day boundaries.
    if (!(await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE", [input.authority.organizationId])).rows[0]) denied();
    const row = (await db.query("SELECT * FROM agents_platform.execution_grants WHERE organization_id=$1 AND id=$2 FOR SHARE", [input.authority.organizationId, input.grantId])).rows[0];
    if (!row) denied();
    const grant = grantFromRow(row);
    const version = await this.version(db, input.authority.organizationId, input.versionId);
    const config = agentConfigurationSchema.parse(version.configuration);
    assertGrantAuthority(grant, input.authority, input.versionId, config);
    assertRuntimeAvailable(config);
    await this.assertPrincipal(db, input.authority, version);
    if (Buffer.byteLength(input.input) > config.model.maxInputBytes) throw new PlatformError("INPUT_LIMIT", 413, "The message exceeds the input limit");
    const digest = requestDigest({ authority: input.authority, versionId: input.versionId, input: input.input, conversationId: input.conversationId ?? null });
    const existing = (await db.query<TaskRecord>(`SELECT * FROM agents_platform.tasks WHERE product=$1 AND organization_id=$2
      AND caller_client_id=$3 AND resource_id=$4 AND request_key=$5`, [input.authority.product, input.authority.organizationId, input.authority.callerClientId, input.authority.resourceId, requestKey])).rows[0];
    if (existing) {
      if (existing.request_digest !== digest) throw new PlatformError("IDEMPOTENCY_CONFLICT", 409, "The request key was used for different input");
      return { task: existing, replayed: true };
    }
    const active = (await db.query<{ count: string }>("SELECT count(*) FROM agents_platform.tasks WHERE organization_id=$1 AND parent_task_id IS NULL AND state IN ('accepted','running','waiting_children','waiting_authority','waiting_review','reconciling','cancel_requested')", [input.authority.organizationId])).rows[0]!;
    if (Number(active.count) >= initialLimits.maxConcurrentTasks) throw new PlatformError("CONCURRENCY_LIMIT", 429, "Too many tasks are running");
    const reservation = grant.rootTokenLimit;
    await db.query("INSERT INTO agents_platform.usage_accounts(organization_id,day) VALUES($1,(now() AT TIME ZONE 'UTC')::date) ON CONFLICT DO NOTHING", [input.authority.organizationId]);
    const quota = (await db.query<{ day: string }>(`UPDATE agents_platform.usage_accounts SET reserved_tokens=reserved_tokens+$2
      WHERE organization_id=$1 AND day=(now() AT TIME ZONE 'UTC')::date AND reserved_tokens+consumed_tokens+$2<=token_allowance RETURNING day`, [input.authority.organizationId, reservation])).rows[0];
    if (!quota) throw new PlatformError("QUOTA_EXCEEDED", 429, "The daily usage limit was reached");
    const conversationId = input.conversationId ?? randomUUID();
    if (input.conversationId) {
      const conversation = (await db.query<{ agent_id: string; principal: unknown; deployment_id: string | null }>("SELECT agent_id,principal,deployment_id FROM agents_platform.conversations WHERE organization_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE", [input.authority.organizationId, conversationId])).rows[0];
      if (!conversation || conversation.agent_id !== version.agent_id || canonicalJson(conversation.principal) !== canonicalJson(input.authority.principal) ||
        conversation.deployment_id !== (input.authority.principal.kind === "visitor" ? input.authority.principal.deploymentId : null)) denied();
    } else await db.query("INSERT INTO agents_platform.conversations(id,organization_id,agent_id,principal,deployment_id) VALUES($1,$2,$3,$4,$5)",
      [conversationId, input.authority.organizationId, version.agent_id, input.authority.principal, input.authority.principal.kind === "visitor" ? input.authority.principal.deploymentId : null]);
    const priorVersion = (await db.query("SELECT version_id FROM agents_platform.tasks WHERE conversation_id=$1 ORDER BY turn_sequence DESC LIMIT 1", [conversationId])).rows[0];
    if (priorVersion && priorVersion.version_id !== input.versionId) throw new PlatformError("CONVERSATION_VERSION_CONFLICT",409,"Start a new conversation for this version");
    const sequence = (await db.query("UPDATE agents_platform.conversations SET next_sequence=next_sequence+1 WHERE id=$1 RETURNING next_sequence-1 AS sequence", [conversationId])).rows[0].sequence;
    const task = (await db.query<TaskRecord>(`INSERT INTO agents_platform.tasks(id,product,organization_id,resource_id,caller_client_id,
      principal,version_id,grant_id,conversation_id,request_key,request_digest,input,turn_sequence,root_token_limit) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [randomUUID(), input.authority.product, input.authority.organizationId, input.authority.resourceId, input.authority.callerClientId, input.authority.principal,
      input.versionId, grant.id, conversationId, requestKey, digest, input.input, sequence, reservation])).rows[0]!;
    await db.query("INSERT INTO agents_platform.execution_roots(root_task_id) VALUES($1)", [task.id]);
    await db.query("INSERT INTO agents_platform.task_outbox(task_id) VALUES($1)", [task.id]);
    await db.query("INSERT INTO agents_platform.usage_reservations(task_id,organization_id,day,tokens) VALUES($1,$2,$3,$4)", [task.id, input.authority.organizationId, quota.day, reservation]);
    await db.query("INSERT INTO agents_platform.task_events(task_id,event_key,kind) VALUES($1,'accepted','accepted')", [task.id]);
    return { task, replayed: false };
  }
  async getTask(authority: AdmissionAuthority, taskId: string): Promise<TaskRecord> {
    return this.transaction(async (db) => {
      const task = (await db.query<TaskRecord>("SELECT * FROM agents_platform.tasks WHERE id=$1 AND organization_id=$2", [taskId, authority.organizationId])).rows[0] ?? absent();
      if (task.product !== authority.product || task.resource_id !== authority.resourceId || task.caller_client_id !== authority.callerClientId || canonicalJson(task.principal) !== canonicalJson(authority.principal)) denied();
      if(authority.principal.kind==="automation")await resolveAutomationOwner(db,authority.organizationId,authority.principal);
      else await this.assertPrincipal(db, authority, await this.version(db, authority.organizationId, task.version_id));
      return task;
    });
  }
  async getConversation(authority: AdmissionAuthority, conversationId: string): Promise<TaskRecord[]> {
    return this.transaction(async (db) => {
      const conversation = (await db.query<{ agent_id: string; principal: unknown; deployment_id: string | null }>(
        "SELECT agent_id,principal,deployment_id FROM agents_platform.conversations WHERE organization_id=$1 AND id=$2 FOR SHARE",
        [authority.organizationId, conversationId])).rows[0] ?? absent();
      if (authority.product !== "agents" || canonicalJson(conversation.principal) !== canonicalJson(authority.principal) ||
        (authority.principal.kind === "human" && conversation.agent_id !== authority.resourceId) ||
        (authority.principal.kind === "visitor" && conversation.deployment_id !== authority.resourceId)) denied();
      const tasks = (await db.query<TaskRecord>(`SELECT * FROM agents_platform.tasks WHERE organization_id=$1 AND conversation_id=$2
        AND product=$3 AND caller_client_id=$4 AND resource_id=$5 ORDER BY turn_sequence LIMIT 100`,
      [authority.organizationId, conversationId, authority.product, authority.callerClientId, authority.resourceId])).rows;
      const task = tasks[0] ?? absent();
      if(authority.principal.kind==="automation")await resolveAutomationOwner(db,authority.organizationId,authority.principal);
      else await this.assertPrincipal(db, authority, await this.version(db, authority.organizationId, task.version_id));
      return tasks;
    });
  }
  async listTaskEvents(authority: AdmissionAuthority, taskId: string, afterSequence = "0"): Promise<TaskEvent[]> {
    if (!/^\d{1,19}$/.test(afterSequence) || BigInt(afterSequence) > 9223372036854775807n) throw new PlatformError("INVALID_CURSOR", 400, "Invalid event cursor");
    await this.getTask(authority, taskId);
    return (await this.pool.query<TaskEvent>("SELECT * FROM agents_platform.task_events WHERE task_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 100", [taskId, afterSequence])).rows;
  }
}
