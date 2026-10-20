import { createHash,randomUUID } from "node:crypto";
import type { Pool,PoolClient } from "pg";
import {
agentConfigurationSchema,
assertRuntimeAvailable,
executionGrantSchema,
parseAllowedOrigin,PlatformError,
type ExecutionGrant
} from "../../contracts/contracts";


import type { WebsiteDeployment } from "../../contracts/records";
import { assertPublicSkillPolicy } from "../../capabilities/skills/public-policy";
import { loadBookingPolicy } from "../../workflows/booking/policy";
import { AuthorityStore } from "../../execution/admission/authority-store";

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


export class DeploymentStore extends AuthorityStore {
  async listDeployments(accountId: string, organizationId: string, agentId: string): Promise<WebsiteDeployment[]> {
    return this.transaction(async (db) => {
      await this.membership(db, accountId, organizationId);
      if (!(await db.query("SELECT id FROM agents_platform.agents WHERE organization_id=$1 AND id=$2", [organizationId, agentId])).rows[0]) absent();
      return (await db.query<WebsiteDeployment>("SELECT * FROM agents_platform.website_deployments WHERE organization_id=$1 AND agent_id=$2 ORDER BY published_at DESC,id", [organizationId, agentId])).rows;
    });
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
      if (websiteConfig.memory.enabled || websiteConfig.connectedToolBindingIds.length || websiteConfig.tools.some(name=>name.startsWith("memory.")))
        throw new PlatformError("PRIVATE_AGENT_CONFIGURATION",409,"Website agents cannot use personal memory or protected skills");
      await assertPublicSkillPolicy(db,input.organizationId,input.agentId,websiteConfig.skillIds);
      if(websiteConfig.capabilities.businessActions.enabled)await loadBookingPolicy(db,input.organizationId,input.agentId,websiteConfig.capabilities.businessActions);
      if ((await db.query(`SELECT 1 FROM agents_platform.version_sources v JOIN agents_platform.sources s ON s.id=v.source_id
        JOIN agents_platform.source_revision_policy p ON p.revision_id=v.revision_id WHERE v.version_id=$1 AND (s.state<>'active' OR s.visibility<>'public' OR p.state<>'approved')`, [version.id])).rowCount) throw new PlatformError("PRIVATE_KNOWLEDGE", 409, "Website agents require approved public knowledge");
      return (await db.query<WebsiteDeployment>(`INSERT INTO agents_platform.website_deployments(id,organization_id,agent_id,version_id,allowed_origins,published_by)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [randomUUID(), input.organizationId, input.agentId, version.id, JSON.stringify(origins), input.accountId])).rows[0]!;
    });
  }
  async getWebsiteDeployment(deploymentId: string): Promise<WebsiteDeployment> {
    return (await this.pool.query<WebsiteDeployment>("SELECT * FROM agents_platform.website_deployments WHERE id=$1 AND revoked_at IS NULL", [deploymentId])).rows[0] ?? absent();
  }
  async createWebsiteGrant(input: { deploymentId: string; origin: string; sessionId: string }): Promise<ExecutionGrant> {
    return this.transaction(db => this.createWebsiteGrantInTransaction(db, input));
  }
  async createWebsiteGrantInTransaction(db:PoolClient,input: { deploymentId: string; origin: string; sessionId: string; rootTokenLimit?:number }): Promise<ExecutionGrant> {
      const deployment = (await db.query<WebsiteDeployment>("SELECT * FROM agents_platform.website_deployments WHERE id=$1 AND revoked_at IS NULL FOR SHARE", [input.deploymentId])).rows[0] ?? absent();
      if (!deployment.allowed_origins.includes(parseAllowedOrigin(input.origin))) denied();
      const version = await this.version(db, deployment.organization_id, deployment.version_id);
      assertRuntimeAvailable(version.configuration);
      const grant = executionGrantSchema.parse({ id: randomUUID(), product: "agents", organizationId: deployment.organization_id,
        resourceId: deployment.id, callerClientId: "agents-website", principal: { kind: "visitor", deploymentId: deployment.id, sessionId: input.sessionId },
        versionId: version.id, operations: ["model.reply", "knowledge.read", ...(version.configuration.skillIds.length?["skill.read"]:[]),...(version.configuration.capabilities.businessActions.enabled?["booking.read","booking.execute"]:[]), ...(version.configuration.tools.includes("channel.request_handoff") ? ["channel.handoff"] : [])], sourceRevisionIds: version.configuration.sourceRevisionIds, connectedToolBindingIds: [],
        maxInputBytes: version.configuration.model.maxInputBytes, maxOutputTokens: version.configuration.model.maxOutputTokens,
        ...(input.rootTokenLimit?{rootTokenLimit:input.rootTokenLimit}:{}),
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), revokedAt: null });
      return this.insertGrant(db, grant);
  }
}
