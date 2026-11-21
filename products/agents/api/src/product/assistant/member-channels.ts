import { contextGrantCeiling } from "../../execution/models/settings";
import { authorizeOrchestration,queueOrchestrationInstructionInTransaction } from "../../execution/delegation/progress";
import { memberAssistantEnabled, memberAssistantPolicy } from "../../infrastructure/member-assistant-policy";
export { memberAssistantEnabled } from "../../infrastructure/member-assistant-policy";
import { assertCurrentAuthority, loadExecution, requestTreeCancellationInTransaction } from "../../execution/lifecycle/execution";
import { recordAssistantLifecycle } from "../reporting/assistant-lifecycle";
import { capabilityBindingSchema } from "../../contracts/capability-catalog";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { PlatformError, requestDigest, executionGrantSchema, sourceAuthorityIds,connectedToolAuthorityIds, type AdmissionAuthority } from "../../contracts/contracts";
import type { ChannelWebhookEvent } from "../../contracts/channel-adapters";
import type { Account, TaskRecord, VersionRecord } from "../../contracts/records";
import { transaction } from "../../infrastructure/database";
import { PlatformStore } from "../agents/store";
import { operationsForConfiguration } from "../../platform/access";
import { EvidenceStore, assertCurrentEvidence, assertDelegationInputEvidence } from "../../execution/context/evidence";
import { ToolReviewStore } from "../../capabilities/reviews/tool-reviews";
import { channelSegments } from "../channels/channel-outbound";

type Scope = {accountId:string; organizationId:string};
type Row = Record<string, any>;
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
const deny=()=>new PlatformError("MEMBER_CHANNEL_DENIED",403,"Private messaging access is unavailable");
async function member(db:PoolClient,scope:Scope) {
  if(!(await db.query("SELECT 1 FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND revoked_at IS NULL FOR SHARE",[scope.organizationId,scope.accountId])).rowCount)throw deny();
}
export class MemberChannels {
  private store:PlatformStore;
  constructor(readonly pool:Pool) {this.store=new PlatformStore(pool);}
  async list(scope:Scope) {
    return transaction(this.pool,async db=>{
      await member(db,scope);
      const links=(await db.query(`SELECT l.*,c.kind,c.name,c.revision current_revision,c.credential_revision current_credential_revision,c.state connection_state,m.revoked_at
        FROM agents_platform.member_channel_links l JOIN agents_platform.channel_connections c ON c.id=l.connection_id
        JOIN agents_platform.memberships m ON m.organization_id=l.organization_id AND m.account_id=l.account_id
        WHERE l.organization_id=$1 AND l.account_id=$2 ORDER BY l.created_at DESC LIMIT 100`,[scope.organizationId,scope.accountId])).rows;
      const connections=(await db.query(`SELECT id,kind,name AS label FROM agents_platform.channel_connections
        WHERE organization_id=$1 AND kind IN ('telegram','whatsapp') AND state='active'
        AND coalesce(metadata->>'evaluationFixture','false')<>'true' ORDER BY name,id`,[scope.organizationId])).rows;
      const deliveries=(await db.query(`SELECT o.id,o.member_link_id AS "linkId",o.member_task_id AS "taskId",o.state,o.reason,o.segment,o.updated_at AS "updatedAt"
        FROM agents_platform.channel_outbound o JOIN agents_platform.member_channel_links l ON l.id=o.member_link_id
        WHERE l.organization_id=$1 AND l.account_id=$2 ORDER BY o.created_at DESC,o.segment LIMIT 100`,[scope.organizationId,scope.accountId])).rows;
      return {enabled:memberAssistantEnabled(scope.organizationId),connections,deliveries,links:links.map(l=>({id:l.id,connectionId:l.connection_id,kind:l.kind,
        state:l.state==='revoked'||l.current_revision!==l.connection_revision||l.current_credential_revision!==l.credential_revision||l.connection_state!=='active'||l.revoked_at?'revoked':l.state!=='active'&&l.expires_at.getTime()<=Date.now()?'expired':l.state,
        senderLabel:l.sender_label,expiresAt:l.expires_at.toISOString(),conversationId:l.conversation_id}))};
    });
  }
  async challenge(scope:Scope,raw:unknown) {
    const {connectionId}=z.strictObject({connectionId:z.uuid()}).parse(raw);
    if(!memberAssistantEnabled(scope.organizationId))throw new PlatformError("MEMBER_CHANNEL_DISABLED",409,"Private messaging is not enabled");
    return transaction(this.pool,async db=>{
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[scope.organizationId]);
      await member(db,scope);
      const connection=(await db.query(`SELECT * FROM agents_platform.channel_connections WHERE organization_id=$1 AND id=$2
        AND state='active' AND kind IN ('telegram','whatsapp') AND coalesce(metadata->>'evaluationFixture','false')<>'true' FOR SHARE`,[scope.organizationId,connectionId])).rows[0];
      if(!connection)throw deny();
      const count=(await db.query(`SELECT count(*)::int n FROM agents_platform.member_channel_links
        WHERE account_id=$1 AND created_at>now()-interval '10 minutes'`,[scope.accountId])).rows[0].n;
      if(count>=5)throw new PlatformError("PAIRING_RATE_LIMIT",429,"Try linking again later");
      await db.query(`UPDATE agents_platform.member_channel_links SET state='revoked',challenge_hash=NULL,generation=generation+1,updated_at=now()
        WHERE organization_id=$1 AND account_id=$2 AND connection_id=$3 AND state IN ('challenge','pending')`,[scope.organizationId,scope.accountId,connectionId]);
      const id=randomUUID(),token=randomBytes(32).toString("base64url"),expiresAt=new Date(Date.now()+10*60_000);
      await db.query(`INSERT INTO agents_platform.member_channel_links(id,organization_id,account_id,connection_id,connection_revision,credential_revision,state,challenge_hash,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,'challenge',$7,$8)`,[id,scope.organizationId,scope.accountId,connectionId,connection.revision,connection.credential_revision,hash(token),expiresAt]);
      await recordAssistantLifecycle(db,{organizationId:scope.organizationId,key:id,action:"link_challenge_created",channel:connection.kind});
      return {id,token,expiresAt:expiresAt.toISOString()};
    });
  }
  async confirm(scope:Scope,id:string) {
    if(!memberAssistantEnabled(scope.organizationId))throw deny();
    return transaction(this.pool,async db=>{
      await member(db,scope);
      const link=(await db.query(`SELECT l.*,c.kind FROM agents_platform.member_channel_links l JOIN agents_platform.channel_connections c ON c.id=l.connection_id
        WHERE l.id=$1 AND l.organization_id=$2 AND l.account_id=$3 AND l.state='pending' AND l.expires_at>now()
        AND c.state='active' AND c.revision=l.connection_revision AND c.credential_revision=l.credential_revision FOR UPDATE OF l`,[id,scope.organizationId,scope.accountId])).rows[0];
      if(!link)throw deny();
      await db.query("UPDATE agents_platform.member_channel_links SET state='active',challenge_hash=NULL,updated_at=now() WHERE id=$1",[id]);
      await recordAssistantLifecycle(db,{organizationId:scope.organizationId,key:id,action:"link_confirmed",channel:link.kind});
      return {id,state:"active"};
    });
  }
  async revoke(scope:Scope,id:string) {
    return transaction(this.pool,async db=>{
      await member(db,scope);
      const changed=await db.query(`UPDATE agents_platform.member_channel_links SET state='revoked',generation=generation+1,challenge_hash=NULL,updated_at=now()
        WHERE id=$1 AND organization_id=$2 AND account_id=$3 AND state<>'revoked' RETURNING id,connection_id`,[id,scope.organizationId,scope.accountId]);
      if(!changed.rowCount)throw deny();
      await db.query(`UPDATE agents_platform.execution_grants SET revoked_at=now() WHERE id IN
        (SELECT t.grant_id FROM agents_platform.tasks t JOIN agents_platform.member_channel_tasks m ON m.task_id=t.id WHERE m.link_id=$1)`,[id]);
      await db.query("UPDATE agents_platform.channel_outbound SET state='suppressed',reason='member_link_revoked' WHERE member_link_id=$1 AND state='pending'",[id]);
      const connection=(await db.query("SELECT kind FROM agents_platform.channel_connections WHERE id=$1",[changed.rows[0].connection_id])).rows[0];
      await recordAssistantLifecycle(db,{organizationId:scope.organizationId,key:id,action:"link_revoked",channel:connection.kind});
      return {id,state:"revoked"};
    });
  }
  /** Runs only after provider verification. Pairing text is consumed here, never saved as transcript/event. */
  async route(db:PoolClient,connection:Row,event:ChannelWebhookEvent):Promise<{consumed:boolean;linkId?:string}> {
    if(!["telegram","whatsapp"].includes(connection.kind))return {consumed:false};
    const pair=event.kind==='message'&&!event.echo&&/^\/(?:pair|start)(?:\s|$)/.test(event.text??"");
    if(pair) {
      const token=/^\/(?:pair|start)\s+([A-Za-z0-9_-]{43})$/.exec(event.text?.trim()??"")?.[1];
      if(!token||!event.privateChat||!memberAssistantEnabled(connection.organization_id))return {consumed:true};
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`member-pair:${connection.id}:${event.senderId}`]);
      await db.query(`UPDATE agents_platform.member_channel_links SET state='revoked',generation=generation+1,challenge_hash=NULL
        WHERE connection_id=$1 AND sender_id=$2 AND state='pending' AND expires_at<=now()`,[connection.id,event.senderId]);
      if((await db.query("SELECT 1 FROM agents_platform.member_channel_links WHERE connection_id=$1 AND sender_id=$2 AND state IN ('pending','active')",[connection.id,event.senderId])).rowCount)return {consumed:true};
      const paired=await db.query(`UPDATE agents_platform.member_channel_links l SET state='pending',sender_id=$3,chat_id=$4,sender_label=$3,challenge_hash=NULL,updated_at=now()
        FROM agents_platform.memberships m WHERE l.challenge_hash=$1 AND l.connection_id=$2 AND l.state='challenge' AND l.expires_at>now()
        AND l.connection_revision=$5 AND l.credential_revision=$6 AND m.organization_id=l.organization_id AND m.account_id=l.account_id AND m.revoked_at IS NULL RETURNING l.id`,
      [hash(token),connection.id,event.senderId,event.externalConversationId,connection.revision,connection.credential_revision]);
      if(paired.rowCount)await recordAssistantLifecycle(db,{organizationId:connection.organization_id,key:paired.rows[0].id,action:"link_pending",channel:connection.kind});
      return {consumed:true};
    }
    const links=(await db.query(`SELECT * FROM agents_platform.member_channel_links WHERE connection_id=$1
      AND (sender_id=$2 OR chat_id=$3) ORDER BY created_at DESC,id LIMIT 100 FOR SHARE`,[connection.id,event.senderId,event.externalConversationId])).rows;
    if(!links.length)return {consumed:false};
    if(event.kind==='receipt') {
      const original=(await db.query("SELECT member_link_id FROM agents_platform.channel_ingress WHERE connection_id=$1 AND event_id=$2",[connection.id,event.eventId])).rows[0];
      if(original)return original.member_link_id?{consumed:false,linkId:original.member_link_id}:{consumed:false};
      const delivered=(await db.query(`SELECT o.member_link_id FROM agents_platform.channel_outbound o
        JOIN agents_platform.member_channel_links l ON l.id=o.member_link_id
        WHERE o.connection_id=$1 AND l.chat_id=$2 AND l.sender_id=$3 AND o.provider_message_id=$4
        ORDER BY o.created_at,o.id LIMIT 1`,[connection.id,event.externalConversationId,event.senderId,event.providerMessageId])).rows[0];
      if(delivered)return {consumed:false,linkId:delivered.member_link_id};
      const sending=(await db.query(`SELECT o.member_link_id FROM agents_platform.channel_outbound o
        JOIN agents_platform.member_channel_links l ON l.id=o.member_link_id
        WHERE o.connection_id=$1 AND l.chat_id=$2 AND l.sender_id=$3 AND o.state='sending' AND o.provider_message_id IS NULL
        ORDER BY o.created_at,o.id LIMIT 1`,[connection.id,event.externalConversationId,event.senderId])).rows[0];
      // Receipt facts retain their delivery identity across re-pairing; they never renew member authority.
      if(sending)return {consumed:false,linkId:sending.member_link_id};
      const recipient=[...links].reverse().find(link=>link.chat_id===event.externalConversationId&&link.sender_id===event.senderId);
      if(recipient)return {consumed:false,linkId:recipient.id};
      return {consumed:true};
    }
    const active=links.filter(l=>l.state==='active'&&l.sender_id===event.senderId&&l.chat_id===event.externalConversationId&&l.connection_revision===connection.revision&&l.credential_revision===connection.credential_revision);
    if(active.length!==1||!memberAssistantEnabled(connection.organization_id)||!event.privateChat)return {consumed:true};
    if(!(await db.query("SELECT 1 FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND revoked_at IS NULL FOR SHARE",[active[0].organization_id,active[0].account_id])).rowCount)return {consumed:true};
    return {consumed:false,linkId:active[0].id};
  }
  async process(row:Row,event:ChannelWebhookEvent):Promise<void> {
    if(event.kind==='receipt')return;
    const action=/^member:([ar]):([a-f0-9-]{36})$/.exec(event.interaction??'');
    if(event.kind==='interaction'&&!action)throw deny();
    if(action&&event.privateChat) {
      const link=await transaction(this.pool,db=>this.authorizedLink(db,row.member_link_id));
      if(link.sender_id!==event.senderId||link.chat_id!==event.externalConversationId)throw deny();
      const review=(await this.pool.query(`SELECT r.* FROM agents_platform.tool_invocation_reviews r JOIN agents_platform.member_channel_tasks mt ON mt.task_id=r.root_task_id
        WHERE r.id=$1 AND mt.link_id=$2 AND mt.link_generation=$3 AND r.reviewer_account_id=$4 AND r.state='pending' AND r.expires_at>now()
        AND EXISTS(SELECT 1 FROM agents_platform.channel_outbound o WHERE o.member_link_id=mt.link_id AND o.member_task_id=mt.task_id
          AND o.request#>>'{memberReview,id}'=r.id::text AND o.request#>>'{memberReview,digest}'=r.request_digest
          AND o.ownership_generation=mt.link_generation AND o.state IN ('accepted','sent','delivered','read')
          AND ($5::text<>'telegram' OR o.provider_message_id=$6))`,[action[2],link.id,link.generation,link.account_id,link.kind,event.providerMessageId])).rows[0];
      if(!review)throw deny();
      await new ToolReviewStore(this.pool).decide({organizationId:link.organization_id,accountId:link.account_id},review.id,{decision:action[1]==='a'?'approve':'reject',requestDigest:review.request_digest});
      return;
    }
    if(event.kind!=='message'||event.echo||!event.privateChat)return;
    await transaction(this.pool,async db=>{
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[row.organization_id]);
      const link=await this.authorizedLink(db,row.member_link_id);
      if(link.sender_id!==event.senderId||link.chat_id!==event.externalConversationId)throw deny();
      await db.query("UPDATE agents_platform.member_channel_links SET latest_inbound_at=greatest(latest_inbound_at,$2::timestamptz),updated_at=now() WHERE id=$1",[link.id,event.occurredAt&&Date.parse(event.occurredAt)<=Date.now()?event.occurredAt:new Date(0)]);
      if(!event.text?.trim()) {
        await this.enqueue(db,link,null,`unsupported:${row.id}`,"Send a text message to continue.");
        return;
      }
      if(['/cancel','/status'].includes(event.text?.trim()??'')) {
        const task=(await db.query(`SELECT t.* FROM agents_platform.member_channel_tasks m JOIN agents_platform.tasks t ON t.id=m.task_id
          WHERE m.link_id=$1 AND m.link_generation=$2 AND t.state NOT IN ('completed','incomplete','refused','failed','cancelled','uncertain')
          ORDER BY t.created_at DESC LIMIT 1`,[link.id,link.generation])).rows[0];
        if(task&&event.text?.trim()==='/cancel')await requestTreeCancellationInTransaction(db,task.id);
        await this.enqueue(db,link,task?.id??null,`command:${row.id}`,!task?'No active request.':event.text?.trim()==='/cancel'?'Cancellation requested.':`Request ${task.state.replaceAll('_',' ')}.`);
        return;
      }
      const existing=(await db.query("SELECT task_id FROM agents_platform.member_channel_tasks WHERE ingress_id=$1",[row.id])).rows[0];
      if(existing)return;
      if((await db.query(`SELECT 1 FROM agents_platform.orchestration_instructions i
        JOIN agents_platform.member_channel_tasks m ON m.task_id=i.task_id
        WHERE i.request_key=$1 AND m.link_id=$2 AND m.link_generation=$3`,[row.id,link.id,link.generation])).rowCount)return;
      if((await db.query("SELECT 1 FROM agents_platform.channel_outbound WHERE member_link_id=$1 AND ownership_generation=$2 AND member_notice_key=$3",[link.id,link.generation,`instruction-rejected:${row.id}`])).rowCount)return;
      const active=(await db.query(`SELECT t.id FROM agents_platform.member_channel_tasks m JOIN agents_platform.tasks t ON t.id=m.task_id
        JOIN agents_platform.agent_versions v ON v.id=t.version_id
        WHERE m.link_id=$1 AND m.link_generation=$2 AND t.state NOT IN ('completed','incomplete','refused','failed','cancelled','uncertain','cancel_requested')
        AND v.configuration#>>'{capabilities,delegation,enabled}'='true'
        AND v.configuration#>>'{program,id}'='tool-directed' AND v.configuration#>>'{program,version}'='4'
        ORDER BY t.created_at DESC,t.id LIMIT 1`,[link.id,link.generation])).rows[0];
      if(active) {
        try {
          await authorizeOrchestration(db,active.id);
          if(event.text.trim().length>4000){await this.enqueue(db,link,active.id,`instruction-rejected:${row.id}`,"Message too long.");return;}
          await queueOrchestrationInstructionInTransaction(db,active.id,{instruction:event.text,requestKey:row.id});
          await this.enqueue(db,link,active.id,`instruction:${row.id}`,"Instructions queued.");
          return;
        } catch(error) {
          if(error instanceof PlatformError&&error.code==="INSTRUCTION_LIMIT"){await this.enqueue(db,link,active.id,`instruction-rejected:${row.id}`,"Instruction limit reached.");return;}
          if(!(error instanceof PlatformError)||error.code!=="TASK_TERMINAL")throw error;
        }
      }
      const version=(await db.query<VersionRecord>(`SELECT v.* FROM agents_platform.organization_assistants p JOIN agents_platform.agents a
        ON a.id=p.agent_id AND a.organization_id=p.organization_id AND a.deleted_at IS NULL
        JOIN LATERAL(SELECT * FROM agents_platform.agent_versions WHERE organization_id=p.organization_id AND agent_id=p.agent_id ORDER BY number DESC LIMIT 1) v ON true
        WHERE p.organization_id=$1 FOR SHARE OF a`,[row.organization_id])).rows[0];
      if(!version)throw new PlatformError("ASSISTANT_SETUP_REQUIRED",409,"Configure the assistant in the app");
      const user=(await db.query<Account>("SELECT * FROM agents_platform.accounts WHERE id=$1",[link.account_id])).rows[0];
      if(!user)throw deny();
      const authority:AdmissionAuthority={product:"agents",organizationId:row.organization_id,resourceId:version.agent_id,callerClientId:"agents-execution",principal:{kind:"human",issuer:user.issuer,subject:user.subject}};
      const config=version.configuration;
      const grant=executionGrantSchema.parse({...authority,id:randomUUID(),versionId:version.id,operations:operationsForConfiguration(config,true),sourceRevisionIds:sourceAuthorityIds(config),
        connectedToolBindingIds:connectedToolAuthorityIds(config),maxInputBytes:config.model.maxInputBytes,maxOutputTokens:config.model.maxOutputTokens,
        maxContextTokens:contextGrantCeiling(config),expiresAt:new Date(Date.now()+30*60_000).toISOString(),revokedAt:null});
      await this.store.createGrantInTransaction(db,{accountId:user.id,grant});
      const result=await this.store.admitTaskInTransaction(db,{authority,grantId:grant.id,versionId:version.id,input:event.text!,requestKey:`member:${row.id}`,
        conversationId:link.conversation_id??undefined,configurationMode:"current"});
      await db.query("INSERT INTO agents_platform.member_channel_tasks(task_id,organization_id,link_id,link_generation,ingress_id) VALUES($1,$2,$3,$4,$5)",[result.task.id,row.organization_id,link.id,link.generation,row.id]);
      await db.query("UPDATE agents_platform.member_channel_links SET conversation_id=$2,latest_inbound_at=greatest(latest_inbound_at,$3::timestamptz),updated_at=now() WHERE id=$1",[link.id,result.task.conversation_id,event.occurredAt&&Date.parse(event.occurredAt)<=Date.now()?event.occurredAt:new Date(0)]);
      await recordAssistantLifecycle(db,{organizationId:row.organization_id,key:result.task.id,action:"task_admitted",channel:link.kind});
      await this.enqueue(db,link,result.task.id,`accepted:${result.task.id}`,"Request received.");
    });
  }
  private async authorizedLink(db:PoolClient,id:string):Promise<Row> {
    const link=(await db.query(`SELECT l.*,c.kind,c.asset_id,c.metadata FROM agents_platform.member_channel_links l
      JOIN agents_platform.channel_connections c ON c.id=l.connection_id AND c.organization_id=l.organization_id
      JOIN agents_platform.memberships m ON m.organization_id=l.organization_id AND m.account_id=l.account_id
      WHERE l.id=$1 AND l.state='active' AND m.revoked_at IS NULL AND c.state='active'
      AND c.revision=l.connection_revision AND c.credential_revision=l.credential_revision FOR SHARE OF l,c,m`,[id])).rows[0];
    if(!link||!memberAssistantEnabled(link.organization_id))throw deny();
    return link;
  }
  async outboundAuthority(db:PoolClient,row:Row):Promise<{connection:Row;message:Row}> {
    const link=await this.authorizedLink(db,row.member_link_id);
    if(link.organization_id!==row.organization_id||link.connection_id!==row.connection_id||String(link.generation)!==String(row.ownership_generation)||requestDigest(row.request)!==row.digest||row.request.assetId!==link.asset_id||row.request.recipientId!==link.chat_id)throw deny();
    const connection=(await db.query("SELECT * FROM agents_platform.channel_connections WHERE id=$1",[link.connection_id])).rows[0];
    if(connection.revision!==row.connection_revision||connection.credential_revision!==row.credential_revision)throw deny();
    if(link.kind==='whatsapp'&&(!link.latest_inbound_at||Date.now()-link.latest_inbound_at.getTime()>=86400000||link.latest_inbound_at.getTime()>Date.now()))throw new PlatformError("CHANNEL_TEMPLATE_REQUIRED",409,"The result is available in the app");
    if(row.request.memberReview) {
      const review=(await db.query(`SELECT * FROM agents_platform.tool_invocation_reviews WHERE id=$1 AND root_task_id=$2
        AND reviewer_account_id=$3 AND state='pending' AND expires_at>now()`,[row.request.memberReview.id,row.member_task_id,link.account_id])).rows[0];
      if(!review||review.request_digest!==row.request.memberReview.digest)throw deny();
      const root=(await db.query("SELECT state FROM agents_platform.tasks WHERE id=$1",[row.member_task_id])).rows[0];
      if(!root||["completed","incomplete","refused","failed","cancelled","uncertain"].includes(root.state))throw deny();
      await assertCurrentAuthority(db,await loadExecution(db,review.task_id));
    }
    if(row.member_task_id) {
      const task=(await db.query(`SELECT t.*,c.deleted_at FROM agents_platform.tasks t JOIN agents_platform.member_channel_tasks m ON m.task_id=t.id
        JOIN agents_platform.conversations c ON c.id=t.conversation_id JOIN agents_platform.agents a ON a.id=c.agent_id AND a.deleted_at IS NULL
        WHERE t.id=$1 AND m.link_id=$2 AND m.link_generation=$3`,[row.member_task_id,link.id,link.generation])).rows[0];
      if(!task||task.deleted_at)throw deny();
      const evidence=new EvidenceStore(this.pool);
      await assertDelegationInputEvidence(db,task.id);
      await assertCurrentEvidence(db,task.id,await evidence.taskManifest(task.id),{requireActiveTask:false});
    }
    return {connection,message:{member_link_id:link.id,latest_inbound_at:link.latest_inbound_at,author_kind:'assistant',body:row.request.text,task_id:row.member_task_id}};
  }
  private async enqueue(db:PoolClient,link:Row,taskId:string|null,key:string,body:string,extra:Record<string,unknown>={}) {
    const current=await this.authorizedLink(db,link.id);
    for(const [segment,text] of channelSegments(body,4000).entries()) {
      const request={assetId:current.asset_id,recipientId:current.chat_id,text,...extra};
      await db.query(`INSERT INTO agents_platform.channel_outbound(id,organization_id,connection_id,member_link_id,member_task_id,member_notice_key,
        segment,ownership_generation,connection_revision,credential_revision,request,digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT(member_link_id,member_notice_key,segment) WHERE member_link_id IS NOT NULL DO NOTHING`,
      [randomUUID(),link.organization_id,link.connection_id,link.id,taskId,key,segment,current.generation,current.connection_revision,current.credential_revision,request,requestDigest(request)]);
    }
  }
  async collect(limit=16) {
    const rollout=memberAssistantPolicy();
    const progress=(await this.pool.query(`SELECT m.*,t.state FROM agents_platform.member_channel_tasks m JOIN agents_platform.tasks t ON t.id=m.task_id
      JOIN agents_platform.member_channel_links l ON l.id=m.link_id JOIN agents_platform.channel_connections c ON c.id=l.connection_id
      JOIN agents_platform.memberships mem ON mem.organization_id=l.organization_id AND mem.account_id=l.account_id
      WHERE t.state IN ('waiting_children','waiting_review','cancel_requested') AND ($2::boolean OR l.organization_id::text=ANY($3::text[])) AND l.state='active' AND l.generation=m.link_generation
      AND mem.revoked_at IS NULL AND c.state='active' AND c.revision=l.connection_revision AND c.credential_revision=l.credential_revision
      AND NOT EXISTS(SELECT 1 FROM agents_platform.channel_outbound o WHERE o.member_link_id=m.link_id AND o.member_notice_key='status:'||t.id::text||':'||t.state)
      AND NOT EXISTS(SELECT 1 FROM agents_platform.tool_invocation_reviews r WHERE r.root_task_id=t.id AND r.state='pending' AND r.reviewer_account_id=l.account_id)
      ORDER BY t.created_at LIMIT $1`,[limit,rollout.all,rollout.organizationIds])).rows;
    for(const task of progress)try {await transaction(this.pool,async db=>{
      const link=await this.authorizedLink(db,task.link_id);
      const body=task.state==='waiting_children'?'Working with a specialist.':task.state==='cancel_requested'?'Cancellation requested.':'Review required. Open the app to continue.';
      await this.enqueue(db,link,task.task_id,`status:${task.task_id}:${task.state}`,body);
    });}catch(error){if(!(error instanceof PlatformError)||error.statusCode>=500)throw error;}

    await this.pool.query(`UPDATE agents_platform.channel_outbound o SET state='suppressed',reason='member_task_terminal',updated_at=now()
      FROM agents_platform.member_channel_tasks m JOIN agents_platform.tasks t ON t.id=m.task_id
      WHERE o.member_link_id=m.link_id AND o.member_task_id=m.task_id AND o.state='pending' AND o.request ? 'memberReview'
        AND t.state IN ('completed','incomplete','refused','failed','cancelled','uncertain')`);
    const reviews=(await this.pool.query(`SELECT r.*,m.link_id,m.link_generation,m.task_id member_root,c.name connection_name,c.resource destination,b.binding reviewed_binding FROM agents_platform.tool_invocation_reviews r
      JOIN agents_platform.connections c ON c.id=r.connection_id JOIN agents_platform.capability_bindings b ON b.id=r.binding_id
      JOIN agents_platform.member_channel_tasks m ON m.task_id=r.root_task_id JOIN agents_platform.member_channel_links l ON l.id=m.link_id
      JOIN agents_platform.channel_connections cc ON cc.id=l.connection_id AND cc.state='active' AND cc.revision=l.connection_revision AND cc.credential_revision=l.credential_revision
      JOIN agents_platform.memberships mem ON mem.organization_id=l.organization_id AND mem.account_id=l.account_id AND mem.revoked_at IS NULL
      WHERE r.state='pending' AND r.expires_at>now() AND EXISTS(SELECT 1 FROM agents_platform.tasks rt WHERE rt.id=r.root_task_id AND rt.state NOT IN ('completed','incomplete','refused','failed','cancelled','uncertain','cancel_requested')) AND r.reviewer_account_id=l.account_id AND l.state='active' AND l.generation=m.link_generation
      AND ($2::boolean OR l.organization_id::text=ANY($3::text[]))
      AND NOT EXISTS(SELECT 1 FROM agents_platform.channel_outbound o WHERE o.member_link_id=m.link_id AND o.member_notice_key='review:'||r.id::text)
      ORDER BY r.created_at LIMIT $1`,[limit,rollout.all,rollout.organizationIds])).rows;
    for(const review of reviews)try {await transaction(this.pool,async db=>{
      const link=await this.authorizedLink(db,review.link_id);
      const details=JSON.stringify(review.arguments);
      const binding=capabilityBindingSchema.parse(review.reviewed_binding),target=binding.definition.remote?.target;
      const operation=target?.kind==='tool'?target.name:target?.kind==='prompt'?`Activate prompt ${target.name}`:target?.kind==='resource'?`Read ${target.uri}`:target?.kind==='template'?`Read ${binding.remoteSelection?.uri??target.uriTemplate}`:binding.definition.providerOperation;
      const context=`${operation} · ${review.connection_name}\n${JSON.stringify(review.destination)}`;
      const fits=Array.from(`Approve ${context}?\n${details}`).length<=(link.kind==='whatsapp'?1024:4000);
      const body=fits?`Approve ${context}?\n${details}`:'Action requires review. Open the app to continue.';
      await this.enqueue(db,link,review.member_root,`review:${review.id}`,body,fits?{
        memberReview:{id:review.id,digest:review.request_digest},buttons:[{title:'Approve',payload:`member:a:${review.id}`},{title:'Decline',payload:`member:r:${review.id}`}]}:{});
    });}catch(error){if(!(error instanceof PlatformError)||error.statusCode>=500)throw error;}
    const rows=(await this.pool.query(`SELECT m.*,t.state,t.output FROM agents_platform.member_channel_tasks m JOIN agents_platform.tasks t ON t.id=m.task_id
      WHERE NOT m.collected AND t.state IN ('completed','incomplete','refused','failed','cancelled','uncertain') ORDER BY t.created_at LIMIT $1`,[limit])).rows;
    for(const row of rows) await transaction(this.pool,async db=>{
      const current=(await db.query("SELECT * FROM agents_platform.member_channel_tasks WHERE task_id=$1 AND NOT collected FOR UPDATE",[row.task_id])).rows[0];
      if(!current)return;
      try {
        const link=await this.authorizedLink(db,row.link_id);
        if(link.generation===row.link_generation) {
          const output=row.output?.trim();
          const body=row.state==='completed'?(output||'Request completed. Open the app for details.')
            :row.state==='incomplete'&&output?`Request incomplete.\n${output}`:`Request ${row.state}. Open the app for details.`;
          await this.enqueue(db,link,row.task_id,`result:${row.task_id}`,body);
          if(row.state==='completed')await recordAssistantLifecycle(db,{organizationId:link.organization_id,key:row.task_id,action:'task_completed',channel:link.kind});
        }
      }catch(error){if(!(error instanceof PlatformError)||error.statusCode>=500)throw error;}
      await db.query("UPDATE agents_platform.member_channel_tasks SET collected=true WHERE task_id=$1",[row.task_id]);
    });
  }
}
