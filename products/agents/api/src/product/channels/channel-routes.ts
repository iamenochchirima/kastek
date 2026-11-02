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

export interface ChannelRouteOptions {
  store: ChannelStore; telegram?: TelegramSetupService; meta?: MetaChannelSetup;
  resolveScope(request: FastifyRequest): Promise<ActionScope>;
  resolveSessionId(request: FastifyRequest): Promise<string>;
}
export function registerChannelRoutes(app: FastifyInstance, options: ChannelRouteOptions): void {
  const base = "/api/organizations/:organizationId/channels";
  const id = (request: FastifyRequest) => z.uuid().parse((request.params as Record<string, string>).connectionId);
  const expected = z.strictObject({ expectedRevision: z.number().int().positive() });
  async function owner(request: FastifyRequest): Promise<ActionScope> {
    const scope = await options.resolveScope(request);
    await transaction(options.store.pool, async db => {
      await requireActionMember(db, scope);
      if (!(await db.query("SELECT 1 FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND role='owner' AND revoked_at IS NULL FOR SHARE", [scope.organizationId,scope.accountId])).rowCount) throw new PlatformError("ACCESS_DENIED",403,"An owner must manage channel connections");
    });
    const raw=request.body as Record<string,unknown>|undefined;
    const target=(request.params as Record<string,string>).connectionId??(typeof raw?.connectionId==="string"?raw.connectionId:undefined);
    if(target&&z.uuid().safeParse(target).success&&(await options.store.get(scope,target)).metadata.evaluationFixture===true)throw new PlatformError("CHANNEL_CONNECTION_NOT_FOUND",404,"Connection not found");
    return scope;
  }
  function telegram() { if (!options.telegram) throw new PlatformError("CHANNEL_SETUP_NOT_CONFIGURED",503,"Telegram setup is unavailable"); return options.telegram; }
  function meta() { if (!options.meta) throw new PlatformError("CHANNEL_SETUP_NOT_CONFIGURED",503,"Meta setup is unavailable"); return options.meta; }
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
