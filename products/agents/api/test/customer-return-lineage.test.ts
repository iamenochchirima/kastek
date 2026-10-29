import { randomUUID,randomBytes,createHash } from "node:crypto";
import { Pool } from "pg";
import { afterAll,beforeAll,describe,expect,it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { composeInbox } from "../src/composition/inbox";
import { PlatformStore } from "../src/product/agents/store";
import { CustomerFollowupChallenges } from "../src/product/customer-followup/challenges";
import { CustomerFollowupNotifications,customerFollowupFailures } from "../src/product/customer-followup/notifications";
import { verifiedVisitorLineage } from "../src/product/customer-followup/lineage";
import { KnowledgeStore } from "../src/capabilities/knowledge/knowledge";
import { EvidenceStore } from "../src/execution/context/evidence";
import { defaultBusinessConfiguration } from "../src/contracts/contracts";
import { textDigest } from "../src/contracts/source-contracts";
import { beginOperation,finishOperation,settleTask,loadExecution,assertCurrentAuthority } from "../src/execution/lifecycle/execution";
import { connectFixtureModel } from "./model-fixture";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const databaseUrl=process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip)("verified website-return execution and evidence lineage",()=>{
  let admin:Pool,pool:Pool,store:PlatformStore,knowledge:KnowledgeStore,evidence:EvidenceStore;
  const database=`agents_return_lineage_${randomUUID().replaceAll("-","")}`,objects=new Map<string,Uint8Array>();
  beforeAll(async()=>{
    admin=new Pool({connectionString:databaseUrl});await admin.query(`CREATE DATABASE "${database}"`);
    const url=new URL(databaseUrl!);url.pathname=`/${database}`;pool=new Pool({connectionString:url.href});await setupPlatformSchema(pool);
    store=new PlatformStore(pool);
    const storage={async put(key:string,value:Uint8Array){objects.set(key,Buffer.from(value));},async get(key:string){const value=objects.get(key);if(!value)throw Error("Missing fixture object");return value;},async delete(key:string){objects.delete(key);}};
    knowledge=new KnowledgeStore(pool,storage);evidence=new EvidenceStore(pool,storage);
  });
  afterAll(async()=>{await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}});
  async function fixture(){
    const account=await store.ensureAccount({issuer:"https://lineage.fixture.test",subject:randomUUID(),email:"owner@lineage.test",displayName:"Owner"});
    const org=await store.createOrganization(account.id,"Website return lineage"),scope={organizationId:org.id,accountId:account.id};await connectFixtureModel(pool,account.id,org.id);
    const text="Approved public support facts",job=await knowledge.admitUpload(scope,{operationId:randomUUID(),title:"Support facts",contentType:"text/plain",content:Buffer.from(text),parserRelease:"document-v1"});
    await pool.query("UPDATE agents_platform.ingestion_jobs SET state='extracting' WHERE id=$1",[job.id]);const chunkId=randomUUID();
    await knowledge.publishExtraction(job.id,{text,acquiredAt:new Date().toISOString(),normalizerRelease:"text-v1",chunks:[{id:chunkId,revisionId:job.revisionId,ordinal:0,start:0,end:text.length,page:null,section:null,text,digest:textDigest(text),tokens:10}]});
    await knowledge.setPolicy(scope,job.sourceId,{operationId:randomUUID(),expectedGeneration:1,action:"visibility",visibility:"public"});
    await knowledge.setPolicy(scope,job.sourceId,{operationId:randomUUID(),expectedGeneration:2,action:"approve",revisionId:job.revisionId});
    const configuration=defaultBusinessConfiguration();configuration.sourceRevisionIds=[job.revisionId];configuration.tools=["knowledge.search","knowledge.read","channel.request_handoff"];
    const agent=await store.createAgent({...scope,name:"Support",configuration}),version=await store.createVersion({...scope,agentId:agent.id,expectedRevision:1});
    const deployment=await store.publishWebsite({...scope,agentId:agent.id,versionId:version.id,allowedOrigins:["https://customer.fixture.test"]});
    const session=async()=>{const sessionId=randomUUID();await pool.query("INSERT INTO agents_platform.website_sessions(id,deployment_id,token_hash,origin) VALUES($1,$2,$3,$4)",[sessionId,deployment.id,createHash("sha256").update(randomBytes(32)).digest("hex"),"https://customer.fixture.test"]);return{deploymentId:deployment.id,sessionId};};
    const original=await session(),returned=await session(),stranger=await session(),inbox=composeInbox(pool,{publicOrigin:"https://agents.fixture.test",followupEnabled:true,assertServices:async()=>{}});
    const conversation=await inbox.open(original),incoming=await inbox.ingress(original,conversation.id,{requestKey:randomUUID(),body:"Original question"}),originalTask=incoming.message.task_id!;
    const operationId=`knowledge:${originalTask}:initial`;await beginOperation(pool,originalTask,{id:operationId,kind:"tool",name:"knowledge.search",request:{query:"support"},reservedTokens:0,reservedMs:1000,retrySafe:true});
    const passage=await evidence.recordChunk(originalTask,operationId,chunkId),snapshot=`context:${originalTask}:0`,payload={messages:[{role:"system",content:`[${passage.label}] ${passage.text}`}]};
    await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,0,$3,$4,0)",[snapshot,originalTask,textDigest(JSON.stringify(payload)),payload]);await evidence.supplyContext(originalTask,snapshot,[passage.reference.id]);
    await finishOperation(pool,originalTask,operationId,"completed",{fixture:true},null,0);await settleTask(pool,originalTask,{state:"completed",output:`Approved answer [${passage.label}]`});
    const challenges=new CustomerFollowupChallenges(pool),visitor={...original,conversationId:conversation.id},verify=await challenges.requestVerification(visitor,"customer@lineage.test");await challenges.verifyEmail(visitor,verify.secret);
    const command=async(action:"claim"|"takeover"|"reply"|"return",body?:string)=>{const current=await inbox.readStaff(scope,conversation.id);return inbox.command(scope,conversation.id,{action,commandId:randomUUID(),expectedRevision:current.conversation.revision,...body?{body}:{}});};
    await command("claim");await command("takeover");await command("reply","A human replied.");
    const notification=(await pool.query("SELECT id FROM agents_platform.customer_followup_notifications WHERE conversation_id=$1",[conversation.id])).rows[0];let secret="";
    const sender=new CustomerFollowupNotifications(pool,async(message,before)=>{await before?.();secret=new URL(message.text.split("\n").at(-1)!).hash.slice(1);return{state:"accepted",providerId:"controlled-mailbox"};},"https://agents.fixture.test");
    expect(await sender.deliver(notification.id)).toBe("accepted");await challenges.exchangeReturn(returned,secret);await command("return");
    return{scope,agent,version,deployment,original,returned,stranger,inbox,conversation,originalTask,passage,challenges,visitor,job};
  }
  async function returnedTurn(f:Awaited<ReturnType<typeof fixture>>){return(await f.inbox.ingress(f.returned,f.conversation.id,{requestKey:randomUUID(),body:"Follow-up after verified return"})).message.task_id!;}
  it("admits a verified return into only its existing conversation and inherits current source evidence",async()=>{
    const f=await fixture(),taskId=await returnedTurn(f);
    const original=(await loadExecution(pool,f.originalTask)).task,current=(await loadExecution(pool,taskId)).task;
    expect(current.conversation_id).toBe(original.conversation_id);expect(current.principal).toMatchObject({kind:"visitor",sessionId:f.returned.sessionId});
    expect((await evidence.checkHistory(taskId,[f.originalTask]))[0]?.eligible).toBe(true);
    const id=`context:${taskId}:0`,payload={historyGroupIds:[f.originalTask],messages:[{role:"assistant",content:`Approved answer [${f.passage.label}]`}]};
    await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,0,$3,$4,1)",[id,taskId,textDigest(JSON.stringify(payload)),payload]);
    await evidence.inheritHistory(taskId,id,[f.originalTask]);expect((await evidence.validateCitations(taskId,`Follow-up [${f.passage.label}]`))[0]?.reference.id).toBe(f.passage.reference.id);
    await knowledge.setPolicy(f.scope,f.job.sourceId,{operationId:randomUUID(),expectedGeneration:2,action:"withdraw"});
    expect((await evidence.checkHistory(taskId,[f.originalTask]))[0]?.eligible).toBe(false);
    await expect(evidence.validateCitations(taskId,`Follow-up [${f.passage.label}]`)).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
  });
  it("rejects unverified sessions and forged cross-conversation lineage",async()=>{
    const f=await fixture(),execution=await loadExecution(pool,f.originalTask),base={organizationId:f.scope.organizationId,agentId:f.agent.id,executionConversationId:execution.task.conversation_id,customerConversationId:f.conversation.id,current:f.returned,origin:f.original};
    expect(await verifiedVisitorLineage(pool,base)).toBe(true);expect(await verifiedVisitorLineage(pool,{...base,current:f.stranger})).toBe(false);
    expect(await verifiedVisitorLineage(pool,{...base,organizationId:randomUUID()})).toBe(false);expect(await verifiedVisitorLineage(pool,{...base,customerConversationId:randomUUID()})).toBe(false);
    await expect(f.inbox.ingress(f.stranger,f.conversation.id,{requestKey:randomUUID(),body:"Guessing a conversation"})).rejects.toMatchObject({code:"INBOX_ACCESS_DENIED"});
    const legitimate=await f.inbox.ingress(f.original,f.conversation.id,{requestKey:randomUUID(),body:"Authorized current question"}),grant=await store.createWebsiteGrant({deploymentId:f.deployment.id,sessionId:f.stranger.sessionId,origin:"https://customer.fixture.test"});
    await expect(store.admitTask({authority:{product:"agents",organizationId:f.scope.organizationId,resourceId:f.deployment.id,callerClientId:"agents-website",principal:{kind:"visitor",...f.stranger}},grantId:grant.id,versionId:f.version.id,conversationId:execution.task.conversation_id,requestKey:randomUUID(),input:"Forged return",channelBinding:{customerConversationId:f.conversation.id,ownershipGeneration:legitimate.conversation.ownership_generation,inputMessageId:legitimate.message.id}})).rejects.toMatchObject({code:"ACCESS_DENIED"});
  });
  it("revokes active execution when the return preference is revoked",async()=>{
    const f=await fixture(),taskId=await returnedTurn(f);await assertCurrentAuthority(pool,await loadExecution(pool,taskId));
    await f.challenges.revoke(f.visitor);
    await expect(assertCurrentAuthority(pool,await loadExecution(pool,taskId))).rejects.toMatchObject({code:"DEPLOYMENT_SCOPE_DENIED"});
    await expect(f.inbox.readVisitor(f.returned,f.conversation.id)).rejects.toMatchObject({code:"INBOX_ACCESS_DENIED"});
    await expect(evidence.checkHistory(taskId,[f.originalTask])).rejects.toMatchObject({code:"DEPLOYMENT_SCOPE_DENIED"});
  });
  it("hides completed returned-session output after preference revocation",async()=>{
    const f=await fixture(),taskId=await returnedTurn(f),operation=`knowledge:${taskId}:controlled`;
    await beginOperation(pool,taskId,{id:operation,kind:"tool",name:"knowledge.search",request:{query:"support"},reservedTokens:0,reservedMs:1000,retrySafe:true});
    await finishOperation(pool,taskId,operation,"completed",{fixture:true},null,0);await settleTask(pool,taskId,{state:"completed",output:"Controlled returned-session output"});
    expect((await f.inbox.readStaff(f.scope,f.conversation.id)).messages.at(-1)?.body).toBe("Controlled returned-session output");
    await f.challenges.revoke(f.visitor);
    expect((await f.inbox.readStaff(f.scope,f.conversation.id)).messages.at(-1)?.body).toBe("[Response unavailable]");
  });
  it("recovers a process-lost send claim as unknown without resending and exposes the failure to staff",async()=>{
    const f=await fixture(),notificationId=(await pool.query("SELECT id FROM agents_platform.customer_followup_notifications WHERE conversation_id=$1",[f.conversation.id])).rows[0].id;
    await pool.query("UPDATE agents_platform.customer_followup_notifications SET state='sending',updated_at=now() WHERE id=$1",[notificationId]);let sends=0;
    const recovered=new CustomerFollowupNotifications(pool,async()=>{sends++;return{state:"accepted",providerId:"unexpected"};},"https://agents.fixture.test");
    expect(await recovered.deliver(notificationId)).toBe("in_progress");expect(sends).toBe(0);
    await pool.query("UPDATE agents_platform.customer_followup_notifications SET updated_at=now()-interval '61 seconds' WHERE id=$1",[notificationId]);
    expect(await recovered.deliver(notificationId)).toBe("unknown");expect(await recovered.deliver(notificationId)).toBe("not_pending");expect(sends).toBe(0);
    expect(await customerFollowupFailures(pool,f.conversation.id)).toMatchObject([{id:notificationId,state:"unknown"}]);
  });
  it("does not revive a revoked returned-session origin when the current session is the original visitor",async()=>{
    const f=await fixture(),returned=await returnedTurn(f),operation=`knowledge:${returned}:controlled`;
    await beginOperation(pool,returned,{id:operation,kind:"tool",name:"knowledge.search",request:{query:"support"},reservedTokens:0,reservedMs:1000,retrySafe:true});
    await finishOperation(pool,returned,operation,"completed",{fixture:true},null,0);await settleTask(pool,returned,{state:"completed",output:"Controlled returned-session output"});
    const next=(await f.inbox.ingress(f.original,f.conversation.id,{requestKey:randomUUID(),body:"Original visitor again"})).message.task_id!;
    expect((await evidence.checkHistory(next,[returned]))[0]?.eligible).toBe(true);
    await f.challenges.revoke(f.visitor);await expect(evidence.checkHistory(next,[returned])).rejects.toMatchObject({code:"EVIDENCE_SCOPE_DENIED"});
  });
});
