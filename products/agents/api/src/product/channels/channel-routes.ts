import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { observeConnectionControl, type ConnectionControlEvent } from "../../observability/connection-telemetry";
import type { ActionScope } from "../../contracts/connections";
import { channelModeSchema } from "../../contracts/channel-connections";
import { PlatformError } from "../../contracts/contracts";
import { requireActionMember } from "../../infrastructure/action-authority";
import { transaction } from "../../infrastructure/database";
import { installedChannelHandlers } from "../../adapters/channels/providers";
import type { ChannelStore } from "./channel-store";
import type { TelegramSetupService } from "./telegram-setup";
import type { MetaChannelSetup } from "./meta-setup";
import type { GrowthChannelLinkClient } from "../../adapters/products/growth-channel-links";
import type { GrowthAgentChannelRequest } from "@kasitek-labs/contracts";
import { randomUUID } from "node:crypto";

export interface ChannelRouteOptions {
  store: ChannelStore; telegram?: TelegramSetupService; meta?: MetaChannelSetup; growthLinks?: GrowthChannelLinkClient;
  resolveScope(request: FastifyRequest): Promise<ActionScope>;
  resolveActor(request: FastifyRequest): Promise<{ issuer: string; subject: string }>;
  resolveSessionId(request: FastifyRequest): Promise<string>;
}
export function registerChannelRoutes(app: FastifyInstance, options: ChannelRouteOptions): void {
  const base = "/api/organizations/:organizationId/channels";
  const id = (request: FastifyRequest) => z.uuid().parse((request.params as Record<string, string>).connectionId);
  const expected = z.strictObject({ expectedRevision: z.number().int().positive() });
  async function owner(request: FastifyRequest): Promise<ActionScope> {
    const scope = await options.resolveScope(request);
    await transaction(options.store.pool, async db => {
      try {
        await requireActionMember(db, scope);
      } catch (error) {
        request.log.warn({ event: "agents.channel.owner_access_denied", failure_stage: "membership" }, "Channel owner access denied");
        throw error;
      }
      const isOwner = (await db.query("SELECT 1 FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND role='owner' AND revoked_at IS NULL FOR SHARE", [scope.organizationId,scope.accountId])).rowCount;
      if (!isOwner) {
        request.log.warn({ event: "agents.channel.owner_access_denied", failure_stage: "owner_role" }, "Channel owner access denied");
        throw new PlatformError("ACCESS_DENIED",403,"An owner must manage channel connections");
      }
    });
    const raw=request.body as Record<string,unknown>|undefined;
    const target=(request.params as Record<string,string>).connectionId??(typeof raw?.connectionId==="string"?raw.connectionId:undefined);
    if(target&&z.uuid().safeParse(target).success&&(await options.store.get(scope,target)).metadata.evaluationFixture===true)throw new PlatformError("CHANNEL_CONNECTION_NOT_FOUND",404,"Connection not found");
    return scope;
  }
  function telegram() { if (!options.telegram) throw new PlatformError("CHANNEL_SETUP_NOT_CONFIGURED",503,"Telegram setup is unavailable"); return options.telegram; }
  function meta() { if (!options.meta) throw new PlatformError("CHANNEL_SETUP_NOT_CONFIGURED",503,"Meta setup is unavailable"); return options.meta; }
  function growthLinks() { if (!options.growthLinks) throw new PlatformError("GROWTH_CHANNEL_UNAVAILABLE",503,"Growth connections are unavailable"); return options.growthLinks; }
  async function growthRequest(request:FastifyRequest,scope:ActionScope,body:Record<string,unknown>) {
    const requestId=typeof body.requestId==="string"?z.uuid().parse(body.requestId):randomUUID();
    const {requestId:_ignored,...payload}=body;
    return growthLinks().request({version:"1",requestId,actor:await options.resolveActor(request),workspaceId:scope.organizationId,...payload} as GrowthAgentChannelRequest);
  }
  async function observed<T>(request:FastifyRequest,flow:ConnectionControlEvent["flow"],provider:ConnectionControlEvent["provider"]|null,run:(scope:ActionScope)=>Promise<T>):Promise<T> {
    const scope=await owner(request), raw=request.body as Record<string,unknown>|undefined;
    const connectionId=(request.params as Record<string,string>).connectionId??(typeof raw?.connectionId==="string"?raw.connectionId:undefined);
    const connection=connectionId?await options.store.get(scope,connectionId):null;
    const kind=connection?.kind;
    return observeConnectionControl(options.store.pool,kind&&kind!=="website"?kind:provider??"native_api",flow,{organizationId:scope.organizationId,...(connectionId?{connectionId}:{})},()=>run(scope));
  }
  app.get(`${base}/catalogue`, async request => {
    await options.resolveScope(request); const configured = options.meta?.readiness() ?? [];
    return { channels: options.store.catalogue.map(definition => ({ ...definition,
      modes: definition.modes.map(mode => ({ id: mode, available: installedChannelHandlers.has(definition.handler) && (definition.kind === "website" || definition.kind === "telegram" ? definition.kind === "website" || Boolean(options.telegram) : configured.some(item => item.kind === definition.kind && item.mode === mode)),
        reason: definition.kind === "website" ? null : "Channel setup must be configured by the workspace operator." })),
    })) };
  });
  app.get(base, async request => {
    const scope = await options.resolveScope(request); const connections = (await options.store.list(scope)).filter(item=>item.metadata.evaluationFixture!==true), deployments = (await options.store.listDeployments(scope)).filter(item=>connections.some(connection=>connection.id===item.connectionId));
    const websites = (await options.store.pool.query(`SELECT d.id,d.agent_id AS "agentId",a.name AS "agentName",d.allowed_origins AS "allowedOrigins"
      FROM agents_platform.website_deployments d JOIN agents_platform.agents a ON a.organization_id=d.organization_id AND a.id=d.agent_id
      WHERE d.organization_id=$1 AND d.revoked_at IS NULL AND NOT EXISTS(SELECT 1 FROM agents_platform.evaluation_trial_channels e WHERE e.deployment_id=d.id) ORDER BY d.published_at DESC,d.id`, [scope.organizationId])).rows;
    const setupClaims=(await options.store.pool.query("SELECT connection_id AS \"connectionId\",state,expires_at AS \"expiresAt\" FROM agents_platform.channel_setup_claims WHERE organization_id=$1 AND state<>'complete'",[scope.organizationId])).rows;
    const ingressFailures=(await options.store.pool.query(`SELECT connection_id AS "connectionId",count(*)::int count,max(reason) reason FROM agents_platform.channel_ingress
      WHERE organization_id=$1 AND state='quarantined' GROUP BY connection_id`,[scope.organizationId])).rows;
    return { connections, deployments, websites,setupClaims,ingressFailures };
  });
  app.post(`${base}/growth/organizations`,async request=>{
    const scope=await owner(request),input=z.strictObject({agentId:z.uuid()}).parse(request.body);
    await options.store.assertGrowthManagedAgent(scope,input.agentId);
    const result=await growthRequest(request,scope,{operation:"organizations.list",agentId:input.agentId});
    if(result.operation!=="organizations.list")throw new PlatformError("GROWTH_CHANNEL_RESPONSE_INVALID",502,"Growth returned an invalid organization list");
    return {organizations:result.organizations};
  });
  app.post(`${base}/growth/intents`,async request=>{
    const scope=await owner(request),input=z.strictObject({agentId:z.uuid(),provider:z.enum(["facebook","instagram","whatsapp"]),growthOrganizationId:z.string().trim().min(1).max(128)}).parse(request.body);
    await options.store.assertGrowthManagedAgent(scope,input.agentId);
    const result=await growthRequest(request,scope,{operation:"intent.create",agentId:input.agentId,provider:input.provider,
      growthOrganizationId:input.growthOrganizationId,returnRoute:`/app/agents/${input.agentId}?section=channels`});
    if(result.operation!=="intent.create")throw new PlatformError("GROWTH_CHANNEL_RESPONSE_INVALID",502,"Growth returned an invalid link intent");
    return {intentId:result.intentId,expiresAt:result.expiresAt};
  });
  app.post(`${base}/growth/intents/:intentId/assets`,async request=>{
    const scope=await owner(request),intentId=z.uuid().parse((request.params as Record<string,string>).intentId),input=z.strictObject({agentId:z.uuid()}).parse(request.body);
    await options.store.assertGrowthManagedAgent(scope,input.agentId);
    const result=await growthRequest(request,scope,{operation:"assets.list",agentId:input.agentId,intentId});
    if(result.operation!=="assets.list")throw new PlatformError("GROWTH_CHANNEL_RESPONSE_INVALID",502,"Growth returned an invalid asset list");
    return {assets:result.assets};
  });
  app.post(`${base}/growth/intents/:intentId/oauth`,async request=>{
    const scope=await owner(request),intentId=z.uuid().parse((request.params as Record<string,string>).intentId),input=z.strictObject({
      agentId:z.uuid(),loginMode:z.enum(["meta_login","instagram_login","whatsapp_embedded_signup"]),
    }).parse(request.body);
    await options.store.assertGrowthManagedAgent(scope,input.agentId);
    const result=await growthRequest(request,scope,{operation:"oauth.begin",agentId:input.agentId,intentId,loginMode:input.loginMode});
    if(result.operation!=="oauth.begin")throw new PlatformError("GROWTH_CHANNEL_RESPONSE_INVALID",502,"Growth returned an invalid authorization flow");
    return result;
  });
  app.post(`${base}/growth/intents/:intentId/whatsapp/complete`,{bodyLimit:16384},async request=>{
    const scope=await owner(request),intentId=z.uuid().parse((request.params as Record<string,string>).intentId),input=z.strictObject({
      agentId:z.uuid(),code:z.string().min(1).max(4096),wabaId:z.string().trim().min(1).max(128),phoneNumberId:z.string().trim().min(1).max(128),
    }).parse(request.body);
    await options.store.assertGrowthManagedAgent(scope,input.agentId);
    const result=await growthRequest(request,scope,{operation:"whatsapp.complete",agentId:input.agentId,intentId,
      code:input.code,wabaId:input.wabaId,phoneNumberId:input.phoneNumberId});
    if(result.operation!=="whatsapp.complete"||!result.authorized)throw new PlatformError("GROWTH_CHANNEL_RESPONSE_INVALID",502,"Growth did not confirm WhatsApp signup");
    return {authorized:true};
  });
  app.post(`${base}/growth/intents/:intentId/select`,async request=>{
    const scope=await owner(request),intentId=z.uuid().parse((request.params as Record<string,string>).intentId),input=z.strictObject({
      agentId:z.uuid(),connectionId:z.string().trim().min(1).max(128),providerAssetId:z.string().trim().min(1).max(512),
    }).parse(request.body);
    await options.store.assertGrowthManagedAgent(scope,input.agentId);
    const listed=await growthRequest(request,scope,{operation:"assets.list",agentId:input.agentId,intentId});
    if(listed.operation!=="assets.list")throw new PlatformError("GROWTH_CHANNEL_RESPONSE_INVALID",502,"Growth returned an invalid asset list");
    const asset=listed.assets.find(item=>item.connectionId===input.connectionId&&item.providerAssetId===input.providerAssetId);
    if(!asset)throw new PlatformError("CHANNEL_ASSET_UNAVAILABLE",409,"Select an eligible connected account");
    let connection=await options.store.beginGrowthManaged(scope,{kind:asset.provider,name:asset.name,assetId:asset.providerAssetId,
      growthOrganizationId:asset.growthOrganizationId,growthConnectionId:asset.connectionId,permissionRevision:asset.permissionRevision,
      providerMode:asset.providerMode,agentId:input.agentId,intentId,requestId:randomUUID(),exchangeRequestId:randomUUID(),actor:await options.resolveActor(request)});
    const link=await options.store.growthLinkState(scope,connection.id);
    if(connection.state!=="active"){
      const issued=await growthRequest(request,scope,{operation:"grant.issue",agentId:input.agentId,intentId,requestId:link.requestId,
        connectionId:asset.connectionId,agentsConnectionId:connection.id,providerAssetId:asset.providerAssetId});
      if(issued.operation!=="grant.issue"||issued.intentId!==intentId)throw new PlatformError("GROWTH_CHANNEL_RESPONSE_INVALID",502,"Growth returned an invalid grant code");
      const exchanged=await growthRequest(request,scope,{operation:"grant.exchange",agentId:input.agentId,intentId,requestId:link.exchangeRequestId,
        agentsConnectionId:connection.id,code:issued.code});
      if(exchanged.operation!=="grant.exchange"||exchanged.grant.routeOwner!=="growth"||exchanged.grant.state!=="pending"||
        exchanged.grant.provider!==asset.provider||exchanged.grant.connectionId!==asset.connectionId||exchanged.grant.providerAssetId!==asset.providerAssetId||
        exchanged.grant.permissionRevision!==asset.permissionRevision)throw new PlatformError("GROWTH_CHANNEL_RESPONSE_INVALID",502,"Growth could not confirm the selected channel");
      const active=await options.store.completeGrowthManaged(scope,connection.id,{expectedRevision:connection.revision,
        grantId:exchanged.grant.grantId,growthActor:exchanged.grant.growthActor,permissionRevision:exchanged.grant.permissionRevision});
      // Publish the local Inbox binding before Growth transfers webhook ownership. Once that
      // transfer succeeds, inbound events can arrive immediately and must resolve here.
      const deployment=await options.store.bind(scope,active.id,{expectedRevision:active.revision,agentId:input.agentId});
      const activated=await growthRequest(request,scope,{operation:"grant.activate",agentId:input.agentId,intentId,
        agentsConnectionId:connection.id,requestId:randomUUID()});
      if(activated.operation==="grant.activate"&&activated.grant.state==="needs_attention"&&activated.grant.routeOwner==="agents") {
        await options.store.markGrowthManagedNeedsAttention(connection.id,"AGENT_CHANNEL_PERMISSION_MISSING");
        throw new PlatformError("GROWTH_CHANNEL_REPAIR_REQUIRED",409,"Reconnect this account in Growth Connections");
      }
      if(activated.operation!=="grant.activate"||activated.grant.routeOwner!=="agents"||activated.grant.state!=="active"||
        activated.grant.grantId!==exchanged.grant.grantId||activated.grant.connectionId!==asset.connectionId||
        activated.grant.providerAssetId!==asset.providerAssetId||
        activated.grant.growthActor.issuer!==exchanged.grant.growthActor.issuer||activated.grant.growthActor.subject!==exchanged.grant.growthActor.subject)
        throw new PlatformError("GROWTH_CHANNEL_RESPONSE_INVALID",502,"Growth could not activate the selected channel");
      const connected=await options.store.recordGrowthManagedActor(scope,active.id,{expectedRevision:active.revision,
        grantId:exchanged.grant.grantId,growthActor:activated.grant.growthActor,permissionRevision:activated.grant.permissionRevision});
      return {connection:connected,deployment};
    }
    if(link.grantId) {
      // The binding must be ready before an idempotent activation can restore Agents as
      // Growth's webhook destination.
      const deployment=await options.store.bind(scope,connection.id,{expectedRevision:connection.revision,agentId:input.agentId});
      const activated=await growthRequest(request,scope,{operation:"grant.activate",agentId:input.agentId,intentId:link.intentId,
        agentsConnectionId:connection.id,requestId:randomUUID()});
      if(activated.operation==="grant.activate"&&activated.grant.state==="needs_attention"&&activated.grant.routeOwner==="agents") {
        await options.store.markGrowthManagedNeedsAttention(connection.id,"AGENT_CHANNEL_PERMISSION_MISSING");
        throw new PlatformError("GROWTH_CHANNEL_REPAIR_REQUIRED",409,"Reconnect this account in Growth Connections");
      }
      if(activated.operation!=="grant.activate"||activated.grant.routeOwner!=="agents"||activated.grant.state!=="active"||
        activated.grant.grantId!==link.grantId||activated.grant.provider!==connection.kind||activated.grant.connectionId!==link.growthConnectionId||
        activated.grant.providerAssetId!==connection.assetId)
        throw new PlatformError("GROWTH_CHANNEL_RESPONSE_INVALID",502,"Growth could not confirm the channel route");
      connection=await options.store.recordGrowthManagedActor(scope,connection.id,{expectedRevision:connection.revision,
        grantId:link.grantId,growthActor:activated.grant.growthActor,permissionRevision:activated.grant.permissionRevision});
      return {connection,deployment};
    } else throw new PlatformError("GROWTH_CHANNEL_GRANT_UNAVAILABLE",503,"Reconnect this channel in Agent Channels");
  });
  app.post(base, async request => {
    const scope = await owner(request);
    const input = z.strictObject({ kind: z.enum(["whatsapp","facebook","instagram"]), name: z.string().trim().min(1).max(120), mode: channelModeSchema }).parse(request.body);
    if (!options.meta?.readiness().some(item => item.kind === input.kind && item.mode === input.mode)) throw new PlatformError("CHANNEL_SETUP_NOT_CONFIGURED",503,"Channel setup is unavailable");
    return { connection: await options.store.create(scope, input) };
  });
  app.get(`${base}/:connectionId`, async request => ({ connection: await options.store.get(await options.resolveScope(request),id(request)) }));
  app.get(`${base}/:connectionId/assets`, async request => options.store.listAssets(await options.resolveScope(request),id(request), z.strictObject({ cursor:z.uuid().optional(),limit:z.coerce.number().int().min(1).max(100).optional() }).parse(request.query)));
  app.patch(`${base}/:connectionId`, async request => {
    const input = expected.extend({ name:z.string().trim().min(1).max(120) }).parse(request.body);
    return { connection:await options.store.update(await owner(request),id(request),input) };
  });
  app.post(`${base}/:connectionId/bind`, async request => ({ deployment: await options.store.bind(await owner(request),id(request),request.body) }));
  app.post(`${base}/:connectionId/retry-ingress`,async request=>{
    const scope=await owner(request),connection=await options.store.get(scope,id(request)),input=expected.parse(request.body);
    if(connection.state!=="active"||connection.revision!==input.expectedRevision)throw new PlatformError("CHANNEL_CONNECTION_CHANGED",409,"Reconnect the current channel first");
    const result=await transaction(options.store.pool,async db=>{
      await requireActionMember(db,scope);
      const active=await db.query("SELECT 1 FROM agents_platform.channel_connections WHERE organization_id=$1 AND id=$2 AND revision=$3 AND state='active' FOR SHARE",[scope.organizationId,connection.id,input.expectedRevision]);
      if(!active.rowCount)throw new PlatformError("CHANNEL_CONNECTION_CHANGED",409,"Connection changed");
      return db.query("UPDATE agents_platform.channel_ingress SET state='pending',attempts=0,available_at=now(),reason='operator_retry',claim_id=NULL,lease_until=NULL WHERE organization_id=$1 AND connection_id=$2 AND state='quarantined'",[scope.organizationId,connection.id]);
    });return {queued:result.rowCount};
  });
  app.post(`${base}/telegram/connect`, {bodyLimit:16384}, async request => observed(request,"connect","telegram",scope=>telegram().connect(scope,request.body)));
  app.post(`${base}/:connectionId/telegram/setup`, async request => observed(request,"reconnect","telegram",scope=>telegram().setup(scope,id(request),request.body)));
  app.post(`${base}/:connectionId/telegram/rotate`, {bodyLimit:16384}, async request => observed(request,"rotate","telegram",scope=>telegram().rotate(scope,id(request),request.body)));
  app.post(`${base}/:connectionId/health`, async request => observed(request,"credential_check",null,async scope => {
    const connection=await options.store.get(scope,id(request)), input=expected.parse(request.body);
    return connection.kind==="telegram"?telegram().health(scope,connection.id,input.expectedRevision):meta().health(scope,{connectionId:connection.id,...input});
  }));
  app.post(`${base}/:connectionId/refresh`,async request=>observed(request,"refresh",null,scope=>meta().refresh(scope,{connectionId:id(request),...expected.parse(request.body)})));
  app.post(`${base}/meta/begin`, async request => observed(request,"authorize",null,async scope=>meta().begin(scope,await options.resolveSessionId(request),request.body)));
  app.post(`${base}/meta/complete`, {bodyLimit:16384}, async request => observed(request,"callback",null,async scope=>meta().complete(scope,await options.resolveSessionId(request),request.body)));
  app.post(`${base}/meta/manual`, {bodyLimit:32768}, async request => observed(request,"authorize",null,async scope=>meta().manual(scope,await options.resolveSessionId(request),request.body)));
  app.post(`${base}/meta/assets`, async request => observed(request,"discover",null,async scope=>meta().discover(scope,await options.resolveSessionId(request),request.body)));
  app.post(`${base}/meta/select`, async request => observed(request,"select",null,async scope=>({ connection: await meta().select(scope,await options.resolveSessionId(request),request.body) })));
  app.post(`${base}/meta/reconcile`,async request=>observed(request,"probe",null,async scope=>meta().reconcile(scope,await options.resolveSessionId(request),request.body)));
  app.post(`${base}/:connectionId/disconnect`, async request => observed(request,"disconnect",null,async scope => {
    const connection=await options.store.get(scope,id(request)),input=expected.parse(request.body);
    if(connection.mode==="growth_managed") {
      const link=await options.store.growthLinkState(scope,connection.id);
      if(link.grantId) {
        const result=await growthRequest(request,scope,{operation:"grant.revoke",agentId:link.agentId,grantId:link.grantId,
          agentsConnectionId:connection.id,requestId:randomUUID()});
        if(result.operation!=="grant.revoke"||result.grant.state!=="revoked"||result.grant.routeOwner!=="growth"||result.grant.grantId!==link.grantId)
          throw new PlatformError("GROWTH_CHANNEL_REVOKE_UNCONFIRMED",503,"Growth could not confirm channel disconnection");
      }
      return {connection:await options.store.disconnect(scope,connection.id,input.expectedRevision)};
    }
    if(connection.kind==="telegram")return telegram().disconnect(scope,connection.id,input.expectedRevision);
    if(connection.kind!=="website")return meta().disconnect(scope,{connectionId:connection.id,expectedRevision:input.expectedRevision});
    return { connection:await options.store.disconnect(scope,connection.id,input.expectedRevision) };
  }));
  app.delete(`${base}/:connectionId`, async request => {
    const scope=await owner(request),connection=await options.store.get(scope,id(request)),input=expected.parse(request.body);
    if (!["pending","disconnected"].includes(connection.state)) throw new PlatformError("CHANNEL_DISCONNECT_REQUIRED",409,"Disconnect this channel before removing it");
    return { connection:await options.store.remove(scope,connection.id,input.expectedRevision) };
  });
}
