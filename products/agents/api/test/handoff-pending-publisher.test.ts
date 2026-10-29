import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { defaultBusinessConfiguration } from "../src/contracts/contracts";
import { PlatformStore } from "../src/product/agents/store";
import { InboxStore } from "../src/product/inbox/inbox-store";
import { HANDOFF_RECEIPT } from "../src/product/inbox/handoff-receipt";
import { settleReceipt } from "../src/product/inbox/handoff-pending-receipt";
import { transaction } from "../src/infrastructure/database";
import { registerChannelPorts } from "../src/infrastructure/channel-ports";
import { connectFixtureModel } from "./model-fixture";
import { dropClosedTestDatabase } from "./support/database-cleanup";
import { createDependencyManifest } from "../src/contracts/source-contracts";
import { requestDigest } from "../src/contracts/contracts";
import { composeInbox } from "../src/composition/inbox";

const url = process.env.AGENTS_TEST_DATABASE_URL;
(url ? describe : describe.skip)("pending handoff publisher", () => {
  const database = `agents_publisher_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool, pool: Pool, platform: PlatformStore;
  beforeAll(async () => {
    admin = new Pool({connectionString:url}); await admin.query(`CREATE DATABASE "${database}"`);
    const target=new URL(url!); target.pathname=`/${database}`; pool=new Pool({connectionString:target.href});
    await setupPlatformSchema(pool);
    platform=new PlatformStore(pool);
  });
  afterAll(async () => {await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}});
  async function fixture(commit = true, withFeedback = false) {
    const account=await platform.ensureAccount({issuer:"https://identity.test",subject:randomUUID(),email:"receipt@example.test",displayName:"Staff"});
    const org=await platform.createOrganization(account.id,"Receipt fixture"); await connectFixtureModel(pool,account.id,org.id);
    const configuration=defaultBusinessConfiguration(); configuration.tools=["channel.request_handoff"];
    const agent=await platform.createAgent({accountId:account.id,organizationId:org.id,name:"Support",configuration});
    const version=await platform.createVersion({accountId:account.id,organizationId:org.id,agentId:agent.id,expectedRevision:1});
    const deployment=await platform.publishWebsite({accountId:account.id,organizationId:org.id,agentId:agent.id,versionId:version.id,allowedOrigins:["https://customer.test"]});
    const sessionId=randomUUID(), token=randomBytes(32).toString("base64url");
    await pool.query("INSERT INTO agents_platform.website_sessions(id,deployment_id,token_hash,origin) VALUES($1,$2,$3,$4)",[sessionId,deployment.id,createHash("sha256").update(token).digest("hex"),"https://customer.test"]);
    const grant=await platform.createWebsiteGrant({deploymentId:deployment.id,origin:"https://customer.test",sessionId});
    let evidenceAllowed=true;
    const inbox=new InboxStore(pool,{
      async admit(db,input) {return (await platform.admitTaskInTransaction(db,{authority:{product:"agents",organizationId:org.id,resourceId:deployment.id,callerClientId:"agents-website",principal:{kind:"visitor",deploymentId:deployment.id,sessionId}},grantId:grant.id,versionId:version.id,input:input.input,requestKey:input.requestKey,conversationId:input.executionConversationId ?? undefined,channelBinding:input.channelBinding})).task;},
      async readableOutput(_db,_id,body){return body;},async cancelRoot(){},
      async verifyPendingHandoffReceipt(){return evidenceAllowed;},
    });
    registerChannelPorts(pool,{assertBinding:(...args)=>inbox.assertBinding(...args),requestHandoff:(...args)=>inbox.requestHandoff(...args),publishAutomated:(...args)=>inbox.publishAutomated(...args),context:(...args)=>inbox.context(...args)});
    const visitor={deploymentId:deployment.id,sessionId}, conversation=await inbox.open(visitor);
    const previous=await inbox.ingress(visitor,conversation.id,{requestKey:randomUUID(),body:"Earlier message"});
    const incoming=await inbox.ingress(visitor,conversation.id,{requestKey:randomUUID(),body:"A person please"});
    const taskId=incoming.message.task_id!;
    const binding={customerConversationId:conversation.id,ownershipGeneration:"1",inputMessageId:incoming.message.id};
    const brief={reason:"Customer requested a person",brief:"The customer requested human support."};
    const feedback=withFeedback ? {modelRequest:{model:"fixture",messages:[{role:"user" as const,content:"A person please"}],maxInputTokens:100,maxOutputTokens:50,maxDurationSeconds:5},evidenceManifest:createDependencyManifest([])} : undefined;
    if (commit) await transaction(pool,db=>inbox.requestHandoffV2(db,binding,taskId,brief,60000,feedback));
    const publish=inbox.publishPendingHandoffReceipt.bind(inbox);
    return {taskId,previousTaskId:previous.message.task_id!,conversation,org,grant,deployment,publish,inbox,binding,brief,feedback,visitor,scope:{accountId:account.id,organizationId:org.id},denyEvidence:()=>{evidenceAllowed=false;}};
  }
  it("commits controller feedback metadata with the request and rejects altered replay",async()=>{
    const f=await fixture(true,true);
    const receipt=(await pool.query("SELECT feedback_request_digest,evidence_manifest FROM agents_platform.pending_handoff_receipts WHERE task_id=$1",[f.taskId])).rows[0];
    expect(receipt).toEqual({feedback_request_digest:requestDigest(f.feedback),evidence_manifest:f.feedback!.evidenceManifest});
    await transaction(pool,db=>f.inbox.requestHandoffV2(db,f.binding,f.taskId,f.brief,60000,f.feedback));
    await expect(transaction(pool,db=>f.inbox.requestHandoffV2(db,f.binding,f.taskId,f.brief,60000))).rejects.toThrow();
  });
  it("reuses an existing handoff for uncertain connected recovery without duplicating its receipt",async()=>{
    const f=await fixture(false);
    await transaction(pool,db=>f.inbox.requestHandoff(db,f.binding,f.taskId));
    const input={operationId:'fixture-operation',taskId:f.taskId,organizationId:f.org.id,conversationId:f.conversation.id,inputMessageId:f.binding.inputMessageId,ownershipGeneration:f.binding.ownershipGeneration};
    expect(await transaction(pool,db=>f.inbox.recoverUncertainConnectedHandoff(db,input))).toEqual({outcome:'recorded',commandId:f.taskId});
    expect(await transaction(pool,db=>f.inbox.recoverUncertainConnectedHandoff(db,input))).toEqual({outcome:'recorded',commandId:f.taskId});
    expect((await pool.query("SELECT count(*) n FROM agents_platform.customer_commands WHERE conversation_id=$1 AND action='request_handoff'",[f.conversation.id])).rows[0].n).toBe('1');
    expect((await pool.query("SELECT count(*) n FROM agents_platform.customer_messages WHERE conversation_id=$1 AND request_key=$2",[f.conversation.id,`handoff:${f.taskId}`])).rows[0].n).toBe('1');
  });
  it("creates the existing receipt once and rejects a stale recovery episode",async()=>{
    const f=await fixture(false);
    const input={operationId:'fixture-operation',taskId:f.taskId,organizationId:f.org.id,conversationId:f.conversation.id,inputMessageId:f.binding.inputMessageId,ownershipGeneration:f.binding.ownershipGeneration};
    expect(await transaction(pool,db=>f.inbox.recoverUncertainConnectedHandoff(db,input))).toEqual({outcome:'recorded',commandId:f.taskId});
    await pool.query("UPDATE agents_platform.customer_conversations SET state='automation_active',return_watermark=next_sequence-1,ownership_generation=ownership_generation+1 WHERE id=$1",[f.conversation.id]);
    expect(await transaction(pool,db=>f.inbox.recoverUncertainConnectedHandoff(db,input))).toEqual({outcome:'ownership_changed'});
  });
  it("commits one handoff, brief, pending deadline and alert without an immediate message",async()=>{
    const f=await fixture();
    await transaction(pool,db=>f.inbox.requestHandoffV2(db,f.binding,f.taskId,f.brief,60000));
    const cmd=(await pool.query("SELECT result FROM agents_platform.customer_commands WHERE command_id=$1",[f.taskId])).rows[0].result;
    expect(cmd).toMatchObject({pendingReceiptTaskId:f.taskId,handoffBrief:f.brief,ownership_generation:"2"});
    expect((await pool.query("SELECT count(*) n FROM agents_platform.pending_handoff_receipts WHERE task_id=$1",[f.taskId])).rows[0].n).toBe("1");
    expect((await pool.query("SELECT count(*) n FROM agents_platform.support_staff_alerts WHERE task_id=$1 AND stage=0",[f.taskId])).rows[0].n).toBe("1");
    expect((await pool.query("SELECT count(*) n FROM agents_platform.customer_messages WHERE conversation_id=$1 AND author_kind='assistant'",[f.conversation.id])).rows[0].n).toBe("0");
    expect((await f.inbox.readStaff(f.scope,f.conversation.id)).handoffBrief).toEqual(f.brief);
    expect((await pool.query("SELECT count(*) n FROM agents_platform.customer_cancellations WHERE task_id=$1",[f.taskId])).rows[0].n).toBe("0");
    expect((await pool.query("SELECT count(*) n FROM agents_platform.customer_cancellations WHERE task_id=$1",[f.previousTaskId])).rows[0].n).toBe("1");
    await expect(transaction(pool,db=>f.inbox.requestHandoffV2(db,f.binding,f.taskId,f.brief,100))).rejects.toThrow();
  });
  it("rolls the complete handoff back if the transaction fails",async()=>{
    const f=await fixture(false);
    await expect(transaction(pool,db=>f.inbox.requestHandoffV2(db,f.binding,f.taskId,f.brief,0))).rejects.toThrow("INVALID_RECEIPT_DEADLINE");
    expect((await pool.query("SELECT state,ownership_generation FROM agents_platform.customer_conversations WHERE id=$1",[f.conversation.id])).rows[0]).toMatchObject({state:"automation_active",ownership_generation:"1"});
    expect((await pool.query("SELECT count(*) n FROM agents_platform.customer_commands WHERE command_id=$1",[f.taskId])).rows[0].n).toBe("0");
    expect((await pool.query("SELECT count(*) n FROM agents_platform.support_staff_alerts WHERE task_id=$1",[f.taskId])).rows[0].n).toBe("0");
    expect((await pool.query("SELECT count(*) n FROM agents_platform.pending_handoff_receipts WHERE task_id=$1",[f.taskId])).rows[0].n).toBe("0");
  });
  it("publishes only for the committed task and receipt",async()=>{
    const f=await fixture();
    expect(await settleReceipt(pool,f.taskId,null,HANDOFF_RECEIPT,f.publish,true)).toBe("fallback");
    expect((await pool.query("SELECT count(*) AS n FROM agents_platform.customer_messages WHERE conversation_id=$1 AND request_key=$2",[f.conversation.id,`handoff-receipt:${f.taskId}`])).rows[0].n).toBe("1");
  });
  it("accepts the real website lineage for a fallback and fails closed when its session expires",async()=>{
    const good=await fixture();
    const composed=composeInbox(pool,{publicOrigin:"https://customer.test",assertServices:async()=>{}});
    expect(await settleReceipt(pool,good.taskId,null,HANDOFF_RECEIPT,composed.publishPendingHandoffReceipt.bind(composed),true)).toBe("fallback");
    const transcript=await composed.readVisitor(good.visitor,good.conversation.id);
    expect(transcript.messages.at(-1)?.body).toBe(HANDOFF_RECEIPT);
    const expired=await fixture();
    await pool.query("UPDATE agents_platform.website_sessions SET expires_at=now()-interval '1 second' WHERE deployment_id=$1",[expired.deployment.id]);
    expect(await settleReceipt(pool,expired.taskId,null,HANDOFF_RECEIPT,composed.publishPendingHandoffReceipt.bind(composed),true)).toBe("suppressed");
  });
  it("suppresses when the execution grant is revoked or evidence is withdrawn",async()=>{
    const revoked=await fixture(); await pool.query("UPDATE agents_platform.execution_grants SET revoked_at=now() WHERE id=$1",[revoked.grant.id]);
    expect(await settleReceipt(pool,revoked.taskId,null,HANDOFF_RECEIPT,revoked.publish,true)).toBe("suppressed");
    const evidence=await fixture(); evidence.denyEvidence();
    expect(await settleReceipt(pool,evidence.taskId,null,HANDOFF_RECEIPT,evidence.publish,true)).toBe("suppressed");
  });
  it("suppresses if the channel is disconnected or the command is not the new contract",async()=>{
    const disconnected=await fixture(); await pool.query("UPDATE agents_platform.website_deployments SET paused=true WHERE id=$1",[disconnected.deployment.id]);
    expect(await settleReceipt(pool,disconnected.taskId,null,HANDOFF_RECEIPT,disconnected.publish,true)).toBe("suppressed");
    const missing=await fixture(); await pool.query("UPDATE agents_platform.customer_commands SET result=result-'pendingReceiptTaskId' WHERE command_id=$1",[missing.taskId]);
    expect(await settleReceipt(pool,missing.taskId,null,HANDOFF_RECEIPT,missing.publish,true)).toBe("suppressed");
  });
});
