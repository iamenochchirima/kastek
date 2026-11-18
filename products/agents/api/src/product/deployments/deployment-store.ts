import { contextGrantCeiling } from "../../execution/models/settings";
import { createHash,randomUUID } from "node:crypto";
import type { Pool,PoolClient } from "pg";
import {
agentConfigurationSchema,connectedToolAuthorityIds,sourceAuthorityIds,
assertRuntimeAvailable,
executionGrantSchema,
parseAllowedOrigin,normalizeWebsiteDomain,PlatformError,
type ExecutionGrant
} from "../../contracts/contracts";


import type { VersionRecord, WebsiteDeployment } from "../../contracts/records";
import { assertPublicSkillPolicy } from "../../capabilities/skills/public-policy";
import { assertCustomerNativeBindings } from "../../capabilities/connected-tools/customer-native-policy";
import { delegatedConfiguration } from "../../execution/delegation/scope";
import { loadBookingPolicy } from "../../workflows/booking/policy";
import { AuthorityStore } from "../../execution/admission/authority-store";
import { defaultWebsiteAppearance, websiteAppearanceSchema } from "../../adapters/channels/website/appearance";
import { assertAgentsBillingFeature } from "../billing/billing";

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
    return this.transaction(db=>this.publishWebsiteInTransaction(db,input));
  }
  async publishCurrentWebsite(input:{accountId:string;organizationId:string;agentId:string;allowedOrigins:string[]}):Promise<WebsiteDeployment> {
    return this.transaction(async db=>{
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[input.organizationId]);
      await this.membership(db,input.accountId,input.organizationId);
      const latest=(await db.query<VersionRecord>("SELECT * FROM agents_platform.agent_versions WHERE organization_id=$1 AND agent_id=$2 ORDER BY number DESC LIMIT 1",[input.organizationId,input.agentId])).rows[0]??absent();
      return this.publishWebsiteInTransaction(db,{...input,versionId:latest.id});
    });
  }
  async publishWebsiteInTransaction(db:PoolClient,input:{accountId:string;organizationId:string;agentId:string;versionId:string;allowedOrigins:string[]}):Promise<WebsiteDeployment> {
    const origins = [...new Set(input.allowedOrigins.map(normalizeWebsiteDomain))];
    if (origins.length < 1 || origins.length > 10) throw new PlatformError("INVALID_ORIGIN", 400, "Select 1 to 10 website origins");
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[input.organizationId]);
      await this.membership(db, input.accountId, input.organizationId);
      const version = await this.version(db, input.organizationId, input.versionId);
      if (version.agent_id !== input.agentId) denied();
      await this.assertWebsiteConfigurationInTransaction(db,{organizationId:input.organizationId,agentId:input.agentId,version});
      await db.query("SELECT id FROM agents_platform.agents WHERE organization_id=$1 AND id=$2 FOR SHARE", [input.organizationId, input.agentId]);
      const draft = (await db.query("SELECT appearance FROM agents_platform.website_appearance_drafts WHERE organization_id=$1 AND agent_id=$2 FOR SHARE", [input.organizationId, input.agentId])).rows[0];
      const appearance = websiteAppearanceSchema.parse(draft?.appearance ?? defaultWebsiteAppearance);
      if (appearance.showBranding === false)
        await assertAgentsBillingFeature(this.pool, input.organizationId, "agents.feature.branding");
      return (await db.query<WebsiteDeployment>(`INSERT INTO agents_platform.website_deployments(id,organization_id,agent_id,version_id,allowed_origins,published_by,appearance)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [randomUUID(), input.organizationId, input.agentId, version.id, JSON.stringify(origins), input.accountId, appearance])).rows[0]!;
  }
  async assertWebsiteConfigurationInTransaction(db:PoolClient,input:{organizationId:string;agentId:string;version:VersionRecord}):Promise<void> {
      return this.assertChannelConfigurationInTransaction(db,input,false);
  }
  /** Product-owned assistant channels may use Growth product bindings, but no other private layer. */
  async assertProductAssistantChannelInTransaction(db:PoolClient,input:{organizationId:string;agentId:string;version:VersionRecord}):Promise<void> {
      return this.assertChannelConfigurationInTransaction(db,input,true);
  }
  private async assertChannelConfigurationInTransaction(db:PoolClient,input:{organizationId:string;agentId:string;version:VersionRecord},allowProductBindings:boolean):Promise<void> {
      const {version}=input;
      if(version.organization_id!==input.organizationId||version.agent_id!==input.agentId)denied();
      if (version.configuration.capabilities.sandbox.enabled || version.configuration.capabilities.workflows.enabled) throw new PlatformError("WEBSITE_CAPABILITY_DENIED",409,"Customer agents cannot run analysis or private workflows");
      assertRuntimeAvailable(version.configuration);
      const websiteConfig = agentConfigurationSchema.parse(version.configuration);
      if (websiteConfig.memory.enabled || websiteConfig.tools.some(name=>name.startsWith("memory.")))
        throw new PlatformError("PRIVATE_AGENT_CONFIGURATION",409,"Website agents cannot use personal memory or protected skills");
      await assertPublicSkillPolicy(db,input.organizationId,input.agentId,websiteConfig.skillIds);
      await assertCustomerNativeBindings(db,input.organizationId,connectedToolAuthorityIds(websiteConfig));
      await this.assertCustomerSubtreeInTransaction(db,version,websiteConfig,new Set(),allowProductBindings);
      if(websiteConfig.capabilities.businessActions.enabled)await loadBookingPolicy(db,input.organizationId,input.agentId,websiteConfig.capabilities.businessActions);
      if ((await db.query(`SELECT 1 FROM agents_platform.version_sources v JOIN agents_platform.sources s ON s.id=v.source_id
        JOIN agents_platform.source_revision_policy p ON p.revision_id=v.revision_id WHERE v.version_id=$1 AND (s.state<>'active' OR p.state<>'approved' OR s.visibility<>'public')`, [version.id])).rowCount) throw new PlatformError("PRIVATE_KNOWLEDGE", 409, "Website agents require approved public knowledge");
  }
  private async assertCustomerSubtreeInTransaction(db:PoolClient,version:VersionRecord,configuration:VersionRecord["configuration"],trail:Set<string>,allowProductBindings=false):Promise<void> {
    if(trail.has(version.id))throw new PlatformError("DELEGATION_SCOPE_DENIED",409,"Specialist publication contains a cycle");
    if(configuration.memory.enabled || configuration.capabilities.sandbox.enabled || configuration.capabilities.workflows.enabled ||
       (!allowProductBindings && (configuration.productBindings.length || configuration.commissionableProductBindings?.length)) ||
       configuration.tools.some(name=>name.startsWith("memory.")))
      throw new PlatformError("PRIVATE_AGENT_CONFIGURATION",409,"Customer specialists require public capabilities");
    await assertPublicSkillPolicy(db,version.organization_id,version.agent_id,configuration.skillIds);
    await assertCustomerNativeBindings(db,version.organization_id,connectedToolAuthorityIds(configuration));
    if((await db.query(`SELECT 1 FROM agents_platform.source_revisions r JOIN agents_platform.sources s ON s.id=r.source_id
      JOIN agents_platform.source_revision_policy p ON p.revision_id=r.id WHERE r.organization_id=$1 AND r.id=ANY($2::uuid[])
      AND (s.state<>'active' OR p.state<>'approved' OR s.visibility<>'public')`,[version.organization_id,sourceAuthorityIds(configuration)])).rowCount)
      throw new PlatformError("PRIVATE_KNOWLEDGE",409,"Customer specialists require approved public knowledge");
    if(configuration.capabilities.delegation.enabled) {
      const next=new Set([...trail,version.id]);
      for(const binding of configuration.capabilities.delegation.bindings) {
        const child=await this.version(db,version.organization_id,binding.versionId);
        await this.assertCustomerSubtreeInTransaction(db,child,delegatedConfiguration(configuration,binding,agentConfigurationSchema.parse(child.configuration)),next,allowProductBindings);
      }
    }
  }
  async getWebsiteDeployment(deploymentId: string): Promise<WebsiteDeployment> {
    return (await this.pool.query<WebsiteDeployment>("SELECT * FROM agents_platform.website_deployments WHERE id=$1 AND revoked_at IS NULL", [deploymentId])).rows[0] ?? absent();
  }
  async createWebsiteGrant(input: { deploymentId: string; origin: string; sessionId: string }): Promise<ExecutionGrant> {
    return this.transaction(db => this.createWebsiteGrantInTransaction(db, input));
  }
  async createWebsiteGrantInTransaction(db:PoolClient,input: { deploymentId: string; origin: string; sessionId: string; rootTokenLimit?:number }): Promise<ExecutionGrant> {
      const deployment = (await db.query<WebsiteDeployment>("SELECT * FROM agents_platform.website_deployments WHERE id=$1 AND revoked_at IS NULL AND paused=false FOR SHARE", [input.deploymentId])).rows[0] ?? absent();
      if (!deployment.allowed_origins.includes(parseAllowedOrigin(input.origin))) denied();
      const version = await this.version(db, deployment.organization_id, deployment.version_id);
      assertRuntimeAvailable(version.configuration);
      const grant = executionGrantSchema.parse({ id: randomUUID(), product: "agents", organizationId: deployment.organization_id,
        resourceId: deployment.id, callerClientId: "agents-website", principal: { kind: "visitor", deploymentId: deployment.id, sessionId: input.sessionId },
        versionId: version.id, operations: ["model.reply", "knowledge.read",...(version.configuration.capabilities.delegation.enabled?["delegation.execute"]:[]), ...(version.configuration.capabilities.enquiries?.enabled?["enquiry.submit",...(version.configuration.tools.includes("enquiry.read")?["enquiry.read"]:[]),...(version.configuration.tools.includes("enquiry.amend")?["enquiry.amend"]:[])]:[]), ...(connectedToolAuthorityIds(version.configuration).length?["connected.read","connected.execute"]:[]), ...(version.configuration.skillIds.length?["skill.read"]:[]),...(version.configuration.capabilities.businessActions.enabled?["booking.read",...(version.configuration.capabilities.businessActions.permittedOperations.includes("calendar.book")?["booking.execute"]:[])]:[]), ...(version.configuration.tools.includes("channel.request_handoff") ? ["channel.handoff"] : [])], sourceRevisionIds: sourceAuthorityIds(version.configuration), connectedToolBindingIds: connectedToolAuthorityIds(version.configuration),
        maxInputBytes: version.configuration.model.maxInputBytes, maxOutputTokens: version.configuration.model.maxOutputTokens, maxContextTokens:contextGrantCeiling(version.configuration),
        ...(input.rootTokenLimit?{rootTokenLimit:input.rootTokenLimit}:{}),
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), revokedAt: null });
      return this.insertGrant(db, grant);
  }
  async createChannelGrantInTransaction(db: PoolClient, input: { deploymentId: string; participantId: string; rootTokenLimit?:number }): Promise<ExecutionGrant> {
    return this.createChannelGrantForState(db,input,'automation_active');
  }
  async createPendingSupportStatusGrantInTransaction(db: PoolClient, input: { deploymentId: string; participantId: string }): Promise<ExecutionGrant> {
    return this.createChannelGrantForState(db,input,'handoff_pending');
  }
  private async createChannelGrantForState(db:PoolClient,input:{deploymentId:string;participantId:string;rootTokenLimit?:number},state:'automation_active'|'handoff_pending'):Promise<ExecutionGrant> {
    const deployment = (await db.query(`SELECT d.*,c.mode AS connection_mode,a.offering AS agent_offering FROM agents_platform.channel_deployments d
      JOIN agents_platform.channel_connections c ON c.organization_id=d.organization_id AND c.id=d.connection_id
      JOIN agents_platform.agents a ON a.organization_id=d.organization_id AND a.id=d.agent_id
      JOIN agents_platform.customer_conversations p ON p.organization_id=d.organization_id AND p.channel_deployment_id=d.id
      WHERE d.id=$1 AND p.id=$2 AND p.agent_id=d.agent_id AND p.state=$3
        AND d.state='active' AND c.state='active' AND c.kind<>'website' AND p.channel_kind=c.kind FOR SHARE OF d,c,p,a`,
    [input.deploymentId, input.participantId,state])).rows[0] ?? absent();
    const version = await this.version(db, deployment.organization_id, deployment.version_id);
    const productAssistantChannel = deployment.agent_offering === "growth-assistant" && deployment.connection_mode === "growth_managed";
    if (productAssistantChannel)
      await this.assertProductAssistantChannelInTransaction(db, { organizationId: deployment.organization_id, agentId: deployment.agent_id, version });
    else
      await this.assertWebsiteConfigurationInTransaction(db, { organizationId: deployment.organization_id, agentId: deployment.agent_id, version });
    const config = agentConfigurationSchema.parse(version.configuration);
    const grant = executionGrantSchema.parse({ id: randomUUID(), product: "agents", organizationId: deployment.organization_id,
      resourceId: deployment.id, callerClientId: "agents-channel", principal: { kind: "channel_customer", deploymentId: deployment.id, participantId: input.participantId },
      versionId: version.id, operations: ["model.reply", "knowledge.read",...([...config.productBindings, ...(config.commissionableProductBindings ?? [])].length ? ["product.read"] : []), ...([...config.productBindings, ...(config.commissionableProductBindings ?? [])].some(binding => binding.policy.effect !== "read") ? ["product.write"] : []), ...(config.capabilities.delegation.enabled?["delegation.execute"]:[]), ...(connectedToolAuthorityIds(config).length?["connected.read","connected.execute"]:[]), ...(config.skillIds.length ? ["skill.read"] : []),
        ...(config.capabilities.businessActions.enabled ? ["booking.read", ...(config.capabilities.businessActions.permittedOperations.includes("calendar.book")?["booking.execute"]:[])] : []), ...(config.capabilities.enquiries?.enabled ? ["enquiry.submit",...(config.tools.includes("enquiry.read")?["enquiry.read"]:[]),...(config.tools.includes("enquiry.amend")?["enquiry.amend"]:[])] : []), ...(config.tools.includes("channel.request_handoff") ? ["channel.handoff"] : [])],
      sourceRevisionIds: sourceAuthorityIds(config), connectedToolBindingIds: connectedToolAuthorityIds(config), maxInputBytes: config.model.maxInputBytes,
      maxOutputTokens: config.model.maxOutputTokens, maxContextTokens: contextGrantCeiling(config),
      ...(input.rootTokenLimit===undefined?{}:{rootTokenLimit:input.rootTokenLimit}),
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), revokedAt: null });
    return this.insertGrant(db, grant);
  }

}
