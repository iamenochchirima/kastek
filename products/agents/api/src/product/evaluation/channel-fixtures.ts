import { createHmac, randomBytes,randomUUID } from "node:crypto";
import type { Pool,PoolClient } from "pg";
import { z } from "zod";
import type { ActionScope } from "../../contracts/connections";
import type { ChannelProviderContext } from "../../contracts/channel-adapters";
import type { VersionRecord } from "../../contracts/records";
import { canonicalJson,PlatformError,requestDigest } from "../../contracts/contracts";
import { messagingChannelAdapter } from "../../adapters/channels/providers";
import { transaction } from "../../infrastructure/database";
import { ConnectionVault } from "../../infrastructure/vault";
import { DeploymentStore } from "../deployments/deployment-store";
import type { ChannelDelivery } from "../channels/channel-delivery";
import type { InboxStore } from "../inbox/inbox-store";

const fixtureSchema=z.strictObject({kind:z.enum(["telegram","whatsapp","facebook","instagram"]),mode:z.enum(["bot","cloud_api","meta","instagram_login"]),
  outcomes:z.array(z.enum(["accepted","rejected","lost_ack"])).min(1).max(64)});
type Row=Record<string,any>;
const denied=()=>new PlatformError("EVALUATION_CHANNEL_SCOPE_DENIED",403,"The isolated trial channel is unavailable");
/** Owner-only deterministic transport for the external runner. It never invokes global fetch. */
export class EvaluationChannelFixtures {
  constructor(readonly pool:Pool,private readonly vault:ConnectionVault,private readonly delivery:ChannelDelivery,private readonly inbox:InboxStore){}
  private async row(db:Pool|PoolClient,connectionId:string,active=true):Promise<Row>{
    const row=(await db.query(`SELECT f.*,e.account_id,e.agent_id,e.version_id,e.root_token_limit,e.state trial_state,e.expires_at,
      c.state connection_state,c.revision connection_revision,c.credential_revision,d.state deployment_state,d.version_id deployment_version
      FROM agents_platform.evaluation_trial_messaging_channels f
      JOIN agents_platform.evaluation_trials e ON e.id=f.trial_id AND e.organization_id=f.organization_id
      JOIN agents_platform.channel_connections c ON c.id=f.connection_id AND c.organization_id=f.organization_id
      JOIN agents_platform.channel_deployments d ON d.id=f.deployment_id AND d.organization_id=f.organization_id
      JOIN agents_platform.memberships m ON m.organization_id=e.organization_id AND m.account_id=e.account_id AND m.role='owner' AND m.revoked_at IS NULL
      WHERE f.connection_id=$1`,[connectionId])).rows[0];
    if(!row||active&&(row.trial_state!=="active"||row.expires_at.getTime()<=Date.now()||row.connection_state!=="active"||row.deployment_state!=="active"||row.deployment_version!==row.version_id))throw denied();
    return row;
  }
  private async owned(db:Pool|PoolClient,scope:ActionScope,trialId:string,active=true):Promise<Row>{
    const mapping=(await db.query("SELECT connection_id FROM agents_platform.evaluation_trial_messaging_channels WHERE trial_id=$1 AND organization_id=$2",[z.uuid().parse(trialId),scope.organizationId])).rows[0];
    if(!mapping)throw denied();const row=await this.row(db,mapping.connection_id,active);if(row.account_id!==scope.accountId||row.organization_id!==scope.organizationId)throw denied();return row;
  }
  async prepare(scope:ActionScope,trialId:string,raw:unknown){
    const fixture=fixtureSchema.parse(raw),digest=requestDigest(fixture);
    if(fixture.kind==="telegram"&&fixture.mode!=="bot"||fixture.kind==="whatsapp"&&fixture.mode!=="cloud_api"||fixture.kind==="facebook"&&fixture.mode!=="meta"||fixture.kind==="instagram"&&!["meta","instagram_login"].includes(fixture.mode))throw denied();
    return transaction(this.pool,async db=>{
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[scope.organizationId]);
      const trial=(await db.query(`SELECT e.* FROM agents_platform.evaluation_trials e JOIN agents_platform.memberships m ON m.organization_id=e.organization_id
        AND m.account_id=e.account_id AND m.role='owner' AND m.revoked_at IS NULL WHERE e.id=$1 AND e.organization_id=$2 AND e.account_id=$3 FOR UPDATE OF e`,[z.uuid().parse(trialId),scope.organizationId,scope.accountId])).rows[0];
      if(!trial||trial.state!=="active"||trial.expires_at.getTime()<=Date.now())throw denied();
      const existing=(await db.query("SELECT * FROM agents_platform.evaluation_trial_messaging_channels WHERE trial_id=$1",[trialId])).rows[0];
      if(existing){if(existing.request_digest!==digest)throw new PlatformError("IDEMPOTENCY_CONFLICT",409,"Trial channel fixture changed");const current=await this.owned(db,scope,trialId);return this.dto(current);}
      if((await db.query("SELECT 1 FROM agents_platform.evaluation_trial_channels WHERE trial_id=$1",[trialId])).rowCount)throw denied();
      if((await db.query("SELECT 1 FROM agents_platform.tasks WHERE evaluation_trial_id=$1 LIMIT 1",[trialId])).rowCount)throw denied();
      if((await db.query("SELECT 1 FROM agents_platform.channel_deployments WHERE organization_id=$1 AND agent_id=$2",[scope.organizationId,trial.agent_id])).rowCount)throw denied();
      const version=(await db.query<VersionRecord>("SELECT v.* FROM agents_platform.agent_versions v JOIN agents_platform.agents a ON a.id=v.agent_id AND a.organization_id=v.organization_id WHERE v.organization_id=$1 AND v.agent_id=$2 AND v.id=$3 AND a.offering IN ('faq','customer-service') FOR SHARE OF v,a",[scope.organizationId,trial.agent_id,trial.version_id])).rows[0];
      if(!version||version.configuration.executionKind!=="business")throw denied();await new DeploymentStore(this.pool).assertWebsiteConfigurationInTransaction(db,{organizationId:scope.organizationId,agentId:trial.agent_id,version});
      // Numeric synthetic IDs satisfy native provider grammar; the mapping, not its digits, proves isolation.
      const assetId=`9${BigInt(`0x${randomBytes(5).toString("hex")}`).toString().padStart(14,"0")}`;
      const connectionId=randomUUID(),deploymentId=randomUUID();
      const metadata={evaluationFixture:true,evaluationTrialId:trialId};
      await db.query(`INSERT INTO agents_platform.channel_connections(id,organization_id,created_by,kind,name,asset_id,mode,state,credential_revision,metadata)
        VALUES($1,$2,$3,$4,'Isolated evaluation channel',$5,$6,'active',1,$7)`,[connectionId,scope.organizationId,scope.accountId,fixture.kind,assetId,fixture.mode,metadata]);
      const credentials=fixture.kind==="telegram"?{botToken:`${assetId}:fixture_only`,webhookSecret:requestDigest({domain:"fixture-webhook",trialId})}:{accessToken:"fixture_only_never_a_real_provider_key"};
      const reference=canonicalJson({domain:"channel-credential-v1",connectionId,kind:fixture.kind,mode:fixture.mode,assetId});
      const envelope=this.vault.seal(scope.organizationId,reference,1,canonicalJson({domain:"channel-credential-v1",credentials}),65536);
      await db.query(`INSERT INTO agents_platform.channel_credentials(organization_id,connection_id,revision,kind,mode,asset_id,envelope,state) VALUES($1,$2,1,$3,$4,$5,$6,'active')`,[scope.organizationId,connectionId,fixture.kind,fixture.mode,assetId,envelope]);
      await db.query(`INSERT INTO agents_platform.channel_deployments(id,organization_id,connection_id,agent_id,version_id,created_by) VALUES($1,$2,$3,$4,$5,$6)`,[deploymentId,scope.organizationId,connectionId,trial.agent_id,trial.version_id,scope.accountId]);
      await db.query(`INSERT INTO agents_platform.evaluation_trial_messaging_channels(trial_id,organization_id,connection_id,deployment_id,kind,mode,asset_id,request_digest,fixture)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[trialId,scope.organizationId,connectionId,deploymentId,fixture.kind,fixture.mode,assetId,digest,fixture]);
      return this.dto(await this.owned(db,scope,trialId));
    });
  }
  private dto(row:Row){return {trialId:row.trial_id,connectionId:row.connection_id,deploymentId:row.deployment_id,kind:row.kind,mode:row.mode,assetId:row.asset_id,fixtureDigest:row.request_digest};}
  async ingress(scope:ActionScope,trialId:string,raw:unknown){
    const input=z.strictObject({payload:z.json()}).parse(raw);const row=await this.owned(this.pool,scope,trialId);
    const body=Buffer.from(JSON.stringify(input.payload));if(body.length>128000)throw new PlatformError("CHANNEL_WEBHOOK_LIMIT",413,"Fixture payload exceeds the webhook bound");
    const adapter=messagingChannelAdapter(row.kind),secret=requestDigest({domain:"fixture-webhook",trialId});
    const headers=row.kind==="telegram"?{"x-telegram-bot-api-secret-token":secret}:{"x-hub-signature-256":`sha256=${createHmac("sha256",secret).update(body).digest("hex")}`};
    adapter.verifyWebhook({rawBody:body,headers,secrets:row.kind==="telegram"?{webhookSecret:secret}:{appSecret:secret}});
    const events=adapter.normalize(input.payload,row.kind==="telegram"?{assetId:row.asset_id}:undefined);
    if(events.length===0||events.some(event=>event.assetId!==row.asset_id))throw denied();
    const persisted=await this.delivery.persist(row.kind,events,undefined,undefined,trialId);return {trialId,connectionId:row.connection_id,persisted,eventIds:events.map(event=>event.eventId)};
  }
  /** Called before the ordinary provider policy. A marked but missing/inactive mapping fails closed. */
  async assertFixturePolicy(connection:Row,message:Row,_request:Row):Promise<boolean>{
    if(connection.metadata?.evaluationFixture!==true)return false;
    const row=await this.row(this.pool,connection.id);
    if(connection.organization_id!==row.organization_id||connection.kind!==row.kind||connection.asset_id!==row.asset_id||connection.revision!==row.connection_revision||message.conversation_id===undefined)throw denied();
    const allowed=await this.pool.query("SELECT 1 FROM agents_platform.customer_conversations WHERE id=$1 AND organization_id=$2 AND channel_deployment_id=$3",[message.conversation_id,row.organization_id,row.deployment_id]);
    if(!allowed.rowCount)throw denied();return true;
  }
  fixtureProviderContext(connection:Row,beforeAttempt:()=>Promise<void>):ChannelProviderContext|null{
    if(connection.metadata?.evaluationFixture!==true)return null;
    const fetch:typeof globalThis.fetch=async(input,init)=>{
      const row=await this.row(this.pool,connection.id),url=new URL(String(input));
      const host=row.kind==="telegram"?"api.telegram.org":row.mode==="instagram_login"?"graph.instagram.com":"graph.facebook.com";
      if(url.hostname!==host||init?.method!=="POST"||typeof init.body!=="string"||Buffer.byteLength(init.body)>32768)throw denied();
      const request=JSON.parse(init.body);if(!request||typeof request!=="object"||Array.isArray(request))throw denied();
      if(row.kind==="telegram"?!url.pathname.startsWith(`/bot${row.asset_id}:fixture_only/`):!url.pathname.includes(`/${row.asset_id}/`))throw denied();
      const effect=await transaction(this.pool,async db=>{
        await db.query("SELECT trial_id FROM agents_platform.evaluation_trial_messaging_channels WHERE trial_id=$1 FOR UPDATE",[row.trial_id]);
        await this.row(db,connection.id);
        const count=Number((await db.query("SELECT count(*) count FROM agents_platform.evaluation_channel_effects WHERE trial_id=$1",[row.trial_id])).rows[0].count);
        const outcome=fixtureSchema.parse(row.fixture).outcomes[count];if(!outcome)throw new PlatformError("EVALUATION_CHANNEL_FIXTURE_EXHAUSTED",409,"No fixture send outcome remains");
        await beforeAttempt();
        const id=randomUUID(),providerMessageId=String(count+1),digest=requestDigest({path:url.pathname.replace(/bot[^/]+/g,"bot[fixture]"),request});
        await db.query(`INSERT INTO agents_platform.evaluation_channel_effects(id,trial_id,request_digest,request,outcome,provider_message_id) VALUES($1,$2,$3,$4,$5,$6)`,[id,row.trial_id,digest,request,outcome,outcome==="rejected"?null:providerMessageId]);
        return {outcome,providerMessageId};
      });
      if(effect.outcome==="lost_ack")throw new TypeError("Controlled fixture acknowledgement lost");
      if(effect.outcome==="rejected")return Response.json({ok:false,error_code:403,error:{code:403}},{status:403});
      return Response.json(row.kind==="telegram"?{ok:true,result:{message_id:Number(effect.providerMessageId)}}:row.kind==="whatsapp"?{messages:[{id:effect.providerMessageId}]}:{message_id:effect.providerMessageId});
    };
    return {credential:connection.kind==="telegram"?`${connection.asset_id}:fixture_only`:"fixture_only_never_a_real_provider_key",fetch,apiVersion:"v23.0",pageId:connection.asset_id,mode:connection.mode==="instagram_login"?"instagram_login":"meta"};
  }
  async history(scope:ActionScope,trialId:string){
    const row=await this.owned(this.pool,scope,trialId,false);
    const conversations=(await this.pool.query("SELECT id FROM agents_platform.customer_conversations WHERE organization_id=$1 AND channel_deployment_id=$2 ORDER BY created_at,id LIMIT 2",[row.organization_id,row.deployment_id])).rows;
    if(conversations.length>1)throw new PlatformError("EVALUATION_CHANNEL_THREAD_MISMATCH",409,"A scripted trial must use one channel thread");
    const rootTaskIds=(await this.pool.query("SELECT id FROM agents_platform.tasks WHERE evaluation_trial_id=$1 AND parent_task_id IS NULL ORDER BY created_at,id",[trialId])).rows.map(item=>item.id);
    const ingress=(await this.pool.query("SELECT event_id,state,message_id,reason FROM agents_platform.channel_ingress WHERE connection_id=$1 ORDER BY sequence LIMIT 1000",[row.connection_id])).rows;
    const effects=(await this.pool.query("SELECT id,sequence,request_digest,request,outcome,provider_message_id,created_at FROM agents_platform.evaluation_channel_effects WHERE trial_id=$1 ORDER BY sequence LIMIT 65",[trialId])).rows;
    if(!conversations.length)return {conversation:null,messages:[],commands:[],deliveries:[],rootTaskIds,effects,ingress,fixture:this.dto(row)};
    const id=conversations[0].id,history=await this.inbox.readStaff(scope,id);
    const commands=(await this.pool.query("SELECT command_id,action,actor_account_id,created_at FROM agents_platform.customer_commands WHERE conversation_id=$1 ORDER BY created_at,command_id LIMIT 1000",[id])).rows;
    const deliveries=(await this.pool.query("SELECT id,message_id,segment,ownership_generation,state,reason,provider_message_id,created_at FROM agents_platform.channel_outbound WHERE conversation_id=$1 ORDER BY created_at,id LIMIT 1000",[id])).rows;
    return {...history,commands,deliveries,rootTaskIds,effects,ingress,fixture:this.dto(row)};
  }
}
