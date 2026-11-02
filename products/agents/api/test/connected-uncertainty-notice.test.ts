import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll,beforeAll,describe,expect,it,vi } from "vitest";
import { requestDigest } from "../src/contracts/contracts";
import { transaction } from "../src/infrastructure/database";
import { HANDOFF_RECEIPT } from "../src/product/inbox/handoff-receipt";
import { assertConnectedUncertaintyNotice,CONNECTED_UNCERTAINTY_NOTICE,publishConnectedUncertaintyBatch,publishConnectedUncertaintyUpdate } from "../src/product/inbox/connected-uncertainty-notice";
import { dropClosedTestDatabase } from "./support/database-cleanup";
vi.mock("../src/capabilities/connected-tools/customer-native-policy",()=>({assertCustomerNativeBindings:async()=>[]}));

const url=process.env.AGENTS_TEST_DATABASE_URL;
(url?describe:describe.skip)("connected uncertainty lifecycle notice",()=>{
 const database=`agents_notice_${randomUUID().replaceAll("-","")}`;let admin:Pool,pool:Pool;
 beforeAll(async()=>{
  admin=new Pool({connectionString:url});await admin.query(`CREATE DATABASE "${database}"`);const target=new URL(url!);target.pathname=`/${database}`;pool=new Pool({connectionString:target.href});
  await pool.query(`CREATE SCHEMA agents_platform;
   CREATE TABLE agents_platform.organizations(id uuid PRIMARY KEY);
   CREATE TABLE agents_platform.agents(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz);
   CREATE TABLE agents_platform.customer_conversations(id uuid PRIMARY KEY,organization_id uuid,agent_id uuid,state text,ownership_generation bigint,next_sequence bigint,updated_at timestamptz,channel_kind text,deployment_id uuid,session_id uuid,channel_deployment_id uuid,UNIQUE(organization_id,id));
   CREATE TABLE agents_platform.customer_messages(id uuid PRIMARY KEY,conversation_id uuid,sequence bigint,author_kind text,body text,request_key text,request_digest text,task_id uuid,ownership_generation bigint,UNIQUE(conversation_id,request_key));
   CREATE TABLE agents_platform.customer_commands(conversation_id uuid,command_id uuid,action text,result jsonb,PRIMARY KEY(conversation_id,command_id));
   CREATE TABLE agents_platform.customer_task_links(task_id uuid PRIMARY KEY,conversation_id uuid,input_message_id uuid,ownership_generation bigint);
   CREATE TABLE agents_platform.website_deployments(id uuid PRIMARY KEY,organization_id uuid,agent_id uuid,version_id uuid,revoked_at timestamptz,paused boolean);
   CREATE TABLE agents_platform.website_sessions(id uuid PRIMARY KEY,deployment_id uuid,expires_at timestamptz);
   CREATE TABLE agents_platform.channel_deployments(id uuid PRIMARY KEY,organization_id uuid,agent_id uuid,version_id uuid,connection_id uuid,state text);
   CREATE TABLE agents_platform.channel_connections(id uuid PRIMARY KEY,organization_id uuid,state text);
   CREATE TABLE agents_platform.connections(id uuid PRIMARY KEY,organization_id uuid,state text,expires_at timestamptz,profile_id text,policy_revision int,revision int);
   CREATE TABLE agents_platform.connection_credentials(connection_id uuid,revision int,envelope jsonb);
   CREATE TABLE agents_platform.native_provider_connections(connection_id uuid,organization_id uuid,status text,sharing text,selected_operations text[],binding_ids uuid[],token_expires_at timestamptz);
   CREATE TABLE agents_platform.tasks(id uuid PRIMARY KEY,organization_id uuid,root_task_id uuid,product text,principal jsonb,channel_binding jsonb,grant_id uuid,version_id uuid,resource_id text,caller_client_id text);
   CREATE TABLE agents_platform.execution_grants(id uuid PRIMARY KEY,organization_id uuid,revoked_at timestamptz,expires_at timestamptz,principal jsonb,product text,resource_id text,version_id uuid,caller_client_id text,operations jsonb,connected_tool_binding_ids uuid[]);
   CREATE TABLE agents_platform.version_connected_tools(organization_id uuid,version_id uuid,binding_id uuid);
   CREATE TABLE agents_platform.support_waiting(task_id uuid PRIMARY KEY,source_task_id uuid,conversation_id uuid,ownership_generation bigint);
   CREATE TABLE agents_platform.capability_bindings(id uuid PRIMARY KEY,organization_id uuid,digest text,binding jsonb);
   CREATE TABLE agents_platform.connected_reads(operation_id text PRIMARY KEY,task_id uuid,organization_id uuid,root_task_id uuid,connection_id uuid,binding_id uuid,request_digest text,state text);
   CREATE TABLE agents_platform.tool_invocation_reviews(id uuid PRIMARY KEY,organization_id uuid,task_id uuid,operation_id text,binding_id uuid,connection_id uuid,binding_digest text,request_digest text,arguments jsonb,connection_policy_revision int,state text,approved_at timestamptz,claimed_at timestamptz,expires_at timestamptz);
   CREATE TABLE agents_platform.connected_uncertain_escalations(operation_id text PRIMARY KEY,organization_id uuid,task_id uuid,conversation_id uuid,input_message_id uuid,ownership_generation bigint,claim_digest text,state text,command_id uuid);
   CREATE TABLE agents_platform.connected_reconciliation_attempts(operation_id text,state text);`);
  await pool.query(await readFile(join(__dirname,"../schema/092_connected_uncertainty_notices.sql"),"utf8"));
 });
 afterAll(async()=>{await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}});
 async function fixture(){
  const organizationId=randomUUID(),agentId=randomUUID(),conversationId=randomUUID(),inputId=randomUUID(),receiptId=randomUUID(),taskId=randomUUID(),deploymentId=randomUUID(),sessionId=randomUUID(),grantId=randomUUID(),versionId=randomUUID(),connectionId=randomUUID(),bindingId=randomUUID(),reviewId=randomUUID(),operationId=randomUUID();
  const bindingDigest="a".repeat(64),args={email:"customer@example.test"},reviewDigest=requestDigest({bindingDigest,arguments:args}),connectedDigest=requestDigest({bindingId,bindingDigest,args});
  const approvedAt=new Date("2026-01-01T00:00:00Z"),claimedAt=new Date("2026-01-01T00:01:00Z"),reviewExpiresAt=new Date("2026-01-02T00:00:00Z");
  const claimDigest=requestDigest({operationId,organizationId,taskId,rootTaskId:taskId,bindingId,bindingDigest,connectionId,connectedDigest,reviewId,reviewDigest,connectionPolicyRevision:1,approvedAt:approvedAt.toISOString(),claimedAt:claimedAt.toISOString(),reviewExpiresAt:reviewExpiresAt.toISOString()});
  const principal={kind:"visitor",deploymentId,sessionId},channelBinding={customerConversationId:conversationId,inputMessageId:inputId,ownershipGeneration:"1"};
  await pool.query("INSERT INTO agents_platform.organizations VALUES($1)",[organizationId]);
  await pool.query("INSERT INTO agents_platform.agents VALUES($1,$2,NULL)",[agentId,organizationId]);
  await pool.query("INSERT INTO agents_platform.customer_conversations VALUES($1,$2,$3,'handoff_pending',2,3,now(),'website',$4,$5,NULL)",[conversationId,organizationId,agentId,deploymentId,sessionId]);
  await pool.query("INSERT INTO agents_platform.customer_messages VALUES($1,$2,1,'visitor','Save my contact','visitor','digest',$3,1)",[inputId,conversationId,taskId]);
  await pool.query("INSERT INTO agents_platform.customer_messages VALUES($1,$2,2,'assistant',$3,'handoff','digest',$4,2)",[receiptId,conversationId,HANDOFF_RECEIPT,taskId]);
  await pool.query("INSERT INTO agents_platform.customer_commands VALUES($1,$2,'request_handoff',$3)",[conversationId,taskId,{handoffReceiptId:receiptId,ownership_generation:"2"}]);
  await pool.query("INSERT INTO agents_platform.customer_task_links VALUES($1,$2,$3,1)",[taskId,conversationId,inputId]);
  await pool.query("INSERT INTO agents_platform.website_deployments VALUES($1,$2,$3,$4,NULL,false)",[deploymentId,organizationId,agentId,versionId]);
  await pool.query("INSERT INTO agents_platform.website_sessions VALUES($1,$2,now()+interval '1 hour')",[sessionId,deploymentId]);
  await pool.query("INSERT INTO agents_platform.connections VALUES($1,$2,'active',now()+interval '1 hour','hubspot-contacts-v1',1,1)",[connectionId,organizationId]);
  await pool.query("INSERT INTO agents_platform.connection_credentials VALUES($1,1,$2)",[connectionId,{fixture:true}]);
  await pool.query("INSERT INTO agents_platform.native_provider_connections VALUES($1,$2,'ready','organization_service',ARRAY['contacts.create'],ARRAY[$3]::uuid[],now()+interval '1 hour')",[connectionId,organizationId,bindingId]);
  await pool.query("INSERT INTO agents_platform.execution_grants VALUES($1,$2,NULL,now()+interval '1 hour',$3,'agents',$4,$5,'fixture',$6,ARRAY[$7]::uuid[])",[grantId,organizationId,principal,deploymentId,versionId,JSON.stringify(["connected.execute"]),bindingId]);
  await pool.query("INSERT INTO agents_platform.tasks VALUES($1,$2,$1,'agents',$3,$4,$5,$6,$7,'fixture')",[taskId,organizationId,principal,channelBinding,grantId,versionId,deploymentId]);
  await pool.query("INSERT INTO agents_platform.version_connected_tools VALUES($1,$2,$3)",[organizationId,versionId,bindingId]);
  await pool.query("INSERT INTO agents_platform.support_waiting VALUES($1,$1,$2,2)",[taskId,conversationId]);
  await pool.query("INSERT INTO agents_platform.capability_bindings VALUES($1,$2,$3,$4)",[bindingId,organizationId,bindingDigest,{connection:{profileId:"hubspot-contacts-v1"},policy:{effect:"reviewed_write"}}]);
  await pool.query("INSERT INTO agents_platform.connected_reads VALUES($1,$2,$3,$2,$4,$5,$6,'uncertain')",[operationId,taskId,organizationId,connectionId,bindingId,connectedDigest]);
  await pool.query("INSERT INTO agents_platform.tool_invocation_reviews VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,1,'uncertain',$10,$11,$12)",[reviewId,organizationId,taskId,operationId,bindingId,connectionId,bindingDigest,reviewDigest,args,approvedAt,claimedAt,reviewExpiresAt]);
  await pool.query("INSERT INTO agents_platform.connected_uncertain_escalations VALUES($1,$2,$3,$4,$5,1,$6,'recorded',$3)",[operationId,organizationId,taskId,conversationId,inputId,claimDigest]);
  return{operationId,conversationId,organizationId,taskId,connectionId,grantId};
 }
 it("publishes once, with immutable provenance, under concurrent retry",async()=>{
  const f=await fixture(),result=await Promise.all([publishConnectedUncertaintyUpdate(pool,f.operationId),publishConnectedUncertaintyUpdate(pool,f.operationId)]);
  expect(result.sort()).toEqual(["already_published","published"]);
  const n=(await pool.query("SELECT * FROM agents_platform.connected_uncertainty_notices WHERE operation_id=$1",[f.operationId])).rows[0];
  expect((await pool.query("SELECT body,task_id FROM agents_platform.customer_messages WHERE id=$1",[n.message_id])).rows[0]).toEqual({body:CONNECTED_UNCERTAINTY_NOTICE,task_id:null});
  expect(await transaction(pool,db=>assertConnectedUncertaintyNotice(db,f.operationId,n.message_id,"send"))).toBe(true);
  await expect(pool.query("DELETE FROM agents_platform.connected_uncertainty_notices WHERE operation_id=$1",[f.operationId])).rejects.toMatchObject({code:"23514"});
 });
 it("suppresses publication after confirmed reconciliation, takeover or revoked provider",async()=>{
  const found=await fixture();await pool.query("INSERT INTO agents_platform.connected_reconciliation_attempts VALUES($1,'found')",[found.operationId]);expect(await publishConnectedUncertaintyUpdate(pool,found.operationId)).toBe("suppressed");
  const takeover=await fixture();await pool.query("UPDATE agents_platform.customer_conversations SET state='human_owned',ownership_generation=3 WHERE id=$1",[takeover.conversationId]);expect(await publishConnectedUncertaintyUpdate(pool,takeover.operationId)).toBe("suppressed");
  const revoked=await fixture();await pool.query("UPDATE agents_platform.connections SET state='revoked' WHERE id=$1",[revoked.connectionId]);expect(await publishConnectedUncertaintyUpdate(pool,revoked.operationId)).toBe("suppressed");
 });
 it("serializes against an in-flight confirmed reconciliation",async()=>{
  const f=await fixture(),db=await pool.connect();
  try {
   await db.query("BEGIN");
   await db.query("SELECT operation_id FROM agents_platform.connected_uncertain_escalations WHERE operation_id=$1 FOR SHARE",[f.operationId]);
   const publication=publishConnectedUncertaintyUpdate(pool,f.operationId);
   await db.query("INSERT INTO agents_platform.connected_reconciliation_attempts VALUES($1,'found')",[f.operationId]);
   await db.query("COMMIT");
   expect(await publication).toBe("suppressed");
   expect((await pool.query("SELECT count(*) n FROM agents_platform.connected_uncertainty_notices WHERE operation_id=$1",[f.operationId])).rows[0].n).toBe("0");
  } finally {db.release();}
 });
 it("keeps a historical notice visible while suppressing later sending",async()=>{
  const f=await fixture();expect(await publishConnectedUncertaintyUpdate(pool,f.operationId)).toBe("published");
  const n=(await pool.query("SELECT message_id FROM agents_platform.connected_uncertainty_notices WHERE operation_id=$1",[f.operationId])).rows[0];
  await pool.query("INSERT INTO agents_platform.connected_reconciliation_attempts VALUES($1,'found')",[f.operationId]);
  await pool.query("UPDATE agents_platform.customer_conversations SET state='human_owned',ownership_generation=3 WHERE id=$1",[f.conversationId]);
  expect(await transaction(pool,db=>assertConnectedUncertaintyNotice(db,f.operationId,n.message_id,"send"))).toBe(false);
  expect(await transaction(pool,db=>assertConnectedUncertaintyNotice(db,f.operationId,n.message_id,"history"))).toBe(true);
  await pool.query("UPDATE agents_platform.execution_grants SET revoked_at=now() WHERE id=$1",[f.grantId]);
  expect(await transaction(pool,db=>assertConnectedUncertaintyNotice(db,f.operationId,n.message_id,"history"))).toBe(false);
 });
 it("does not let an ineligible earlier episode starve eligible work",async()=>{
  for(let i=0;i<22;i++){const f=await fixture();await pool.query("UPDATE agents_platform.customer_conversations SET state='resolved' WHERE id=$1",[f.conversationId]);}
  const eligible=await fixture();expect(await publishConnectedUncertaintyBatch(pool,1)).toBe(1);
  expect((await pool.query("SELECT count(*) n FROM agents_platform.connected_uncertainty_notices WHERE operation_id=$1",[eligible.operationId])).rows[0].n).toBe("1");
 });
});
