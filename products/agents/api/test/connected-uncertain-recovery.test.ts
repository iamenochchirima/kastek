import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll,beforeAll,describe,expect,it,vi } from "vitest";
import { requestDigest } from "../src/contracts/contracts";
import { transaction } from "../src/infrastructure/database";
import { dropClosedTestDatabase } from "./support/database-cleanup";
vi.mock("../src/contracts/capability-catalog",()=>({capabilityBindingSchema:{safeParse:(value:unknown)=>({success:true,data:value})}}));
import { captureConnectedUncertain,captureConnectedUncertainBatch,processConnectedUncertain,processConnectedUncertainBatch } from "../src/product/inbox/connected-uncertain-recovery";

const url=process.env.AGENTS_TEST_DATABASE_URL;
(url?describe:describe.skip)("uncertain connected write recovery",()=>{
  const database=`agents_uncertain_${randomUUID().replaceAll("-","")}`;let admin:Pool,pool:Pool;
  beforeAll(async()=>{
    admin=new Pool({connectionString:url});await admin.query(`CREATE DATABASE "${database}"`);
    const target=new URL(url!);target.pathname=`/${database}`;pool=new Pool({connectionString:target.href});
    await pool.query(`CREATE SCHEMA agents_platform;
      CREATE TABLE agents_platform.organizations(id uuid PRIMARY KEY);
      CREATE TABLE agents_platform.agents(id uuid PRIMARY KEY,organization_id uuid,deleted_at timestamptz);
      CREATE TABLE agents_platform.customer_conversations(id uuid PRIMARY KEY,organization_id uuid,agent_id uuid,channel_kind text,deployment_id uuid,session_id uuid,channel_deployment_id uuid,UNIQUE(organization_id,id));
      CREATE TABLE agents_platform.customer_messages(id uuid PRIMARY KEY,conversation_id uuid,author_kind text,ownership_generation bigint);
      CREATE TABLE agents_platform.customer_commands(conversation_id uuid,command_id uuid,action text,PRIMARY KEY(conversation_id,command_id));
      CREATE TABLE agents_platform.website_deployments(id uuid PRIMARY KEY,organization_id uuid,revoked_at timestamptz,paused boolean);
      CREATE TABLE agents_platform.website_sessions(id uuid PRIMARY KEY,deployment_id uuid,expires_at timestamptz);
      CREATE TABLE agents_platform.channel_deployments(id uuid PRIMARY KEY,organization_id uuid,connection_id uuid,state text);
      CREATE TABLE agents_platform.channel_connections(id uuid PRIMARY KEY,organization_id uuid,state text);
      CREATE TABLE agents_platform.connections(id uuid PRIMARY KEY,organization_id uuid,state text,policy_revision int);
      CREATE TABLE agents_platform.tasks(id uuid PRIMARY KEY,organization_id uuid,root_task_id uuid,product text,principal jsonb,channel_binding jsonb,grant_id uuid,version_id uuid,resource_id text,caller_client_id text,UNIQUE(organization_id,id));
      CREATE TABLE agents_platform.execution_grants(id uuid PRIMARY KEY,organization_id uuid,revoked_at timestamptz,expires_at timestamptz,principal jsonb,product text,resource_id text,version_id uuid,caller_client_id text);
      CREATE TABLE agents_platform.customer_task_links(task_id uuid PRIMARY KEY,conversation_id uuid,input_message_id uuid,ownership_generation bigint);
      CREATE TABLE agents_platform.capability_bindings(id uuid PRIMARY KEY,organization_id uuid,connection_id uuid,digest text,binding jsonb);
      CREATE TABLE agents_platform.connected_reads(operation_id text PRIMARY KEY,task_id uuid,organization_id uuid,root_task_id uuid,connection_id uuid,binding_id uuid,request_digest text,state text,claim_expires_at timestamptz,error_code text,updated_at timestamptz DEFAULT now());
      CREATE TABLE agents_platform.tool_invocation_reviews(id uuid PRIMARY KEY,organization_id uuid,task_id uuid,root_task_id uuid,operation_id text,binding_id uuid,binding_digest text,request_digest text,arguments jsonb,connection_id uuid,connection_policy_revision int,state text,approved_at timestamptz,claimed_at timestamptz,expires_at timestamptz);`);
    await pool.query(await readFile(join(__dirname,"../schema/090_connected_uncertain_escalations.sql"),"utf8"));
  });
  afterAll(async()=>{await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}});
  async function fixture(state="uncertain"){
    const organizationId=randomUUID(),agentId=randomUUID(),conversationId=randomUUID(),inputMessageId=randomUUID(),taskId=randomUUID(),deploymentId=randomUUID(),sessionId=randomUUID(),grantId=randomUUID(),versionId=randomUUID(),connectionId=randomUUID(),bindingId=randomUUID(),operationId=randomUUID();
    const digest="a".repeat(64),args={email:"fixture@example.test"},binding={id:bindingId,digest,connection:{profileId:"hubspot-contacts-v1"},policy:{effect:"reviewed_write"}},principal={kind:"visitor",deploymentId,sessionId},channelBinding={customerConversationId:conversationId,inputMessageId,ownershipGeneration:"1"};
    await pool.query("INSERT INTO agents_platform.organizations VALUES($1)",[organizationId]);
    await pool.query("INSERT INTO agents_platform.agents VALUES($1,$2,NULL)",[agentId,organizationId]);
    await pool.query("INSERT INTO agents_platform.customer_conversations VALUES($1,$2,$3,'website',$4,$5,NULL)",[conversationId,organizationId,agentId,deploymentId,sessionId]);
    await pool.query("INSERT INTO agents_platform.customer_messages VALUES($1,$2,'visitor',1)",[inputMessageId,conversationId]);
    await pool.query("INSERT INTO agents_platform.website_deployments VALUES($1,$2,NULL,false)",[deploymentId,organizationId]);
    await pool.query("INSERT INTO agents_platform.website_sessions VALUES($1,$2,now()+interval '1 hour')",[sessionId,deploymentId]);
    await pool.query("INSERT INTO agents_platform.connections VALUES($1,$2,'active',1)",[connectionId,organizationId]);
    await pool.query("INSERT INTO agents_platform.execution_grants VALUES($1,$2,NULL,now()+interval '1 hour',$3,'agents',$4,$5,'fixture')",[grantId,organizationId,principal,deploymentId,versionId]);
    await pool.query("INSERT INTO agents_platform.tasks VALUES($1,$2,$1,'agents',$3,$4,$5,$6,$7,'fixture')",[taskId,organizationId,principal,channelBinding,grantId,versionId,deploymentId]);
    await pool.query("INSERT INTO agents_platform.customer_task_links VALUES($1,$2,$3,1)",[taskId,conversationId,inputMessageId]);
    await pool.query("INSERT INTO agents_platform.capability_bindings VALUES($1,$2,$3,$4,$5)",[bindingId,organizationId,connectionId,digest,binding]);
    await pool.query("INSERT INTO agents_platform.connected_reads VALUES($1,$2,$3,$2,$4,$5,$6,$7,now()-interval '1 second',NULL,now())",[operationId,taskId,organizationId,connectionId,bindingId,requestDigest({bindingId,bindingDigest:digest,args}),state]);
    await pool.query("INSERT INTO agents_platform.tool_invocation_reviews VALUES($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,1,'claimed',now()-interval '2 minutes',now()-interval '1 minute',now()+interval '1 hour')",[randomUUID(),organizationId,taskId,operationId,bindingId,digest,requestDigest({bindingDigest:digest,arguments:args}),args,connectionId]);
    return{organizationId,conversationId,inputMessageId,taskId,operationId,connectionId,deploymentId};
  }
  it("captures expired claimed writes atomically and deduplicates recovery",async()=>{
    const f=await fixture("started");
    expect(await captureConnectedUncertainBatch(pool)).toBe(1);
    expect((await pool.query("SELECT state FROM agents_platform.connected_reads WHERE operation_id=$1",[f.operationId])).rows[0].state).toBe("uncertain");
    expect(await transaction(pool,db=>captureConnectedUncertain(db,f.operationId))).toBe(true);
    expect((await pool.query("SELECT count(*) n FROM agents_platform.connected_uncertain_escalations WHERE operation_id=$1",[f.operationId])).rows[0].n).toBe("1");
  });
  it("records one existing handoff without changing its command and retries safely",async()=>{
    const f=await fixture();await transaction(pool,db=>captureConnectedUncertain(db,f.operationId));
    await pool.query("INSERT INTO agents_platform.customer_commands VALUES($1,$2,'request_handoff')",[f.conversationId,f.taskId]);
    let calls=0;
    const callback=async()=>{calls++;return{outcome:"recorded" as const,commandId:f.taskId};};
    expect(await Promise.all([processConnectedUncertain(pool,f.operationId,callback),processConnectedUncertain(pool,f.operationId,callback)])).toEqual(["recorded","recorded"]);
    expect(calls).toBe(1);
    expect((await pool.query("SELECT command_id FROM agents_platform.connected_uncertain_escalations WHERE operation_id=$1",[f.operationId])).rows[0].command_id).toBe(f.taskId);
  });
  it("rejects unclaimed/noncustomer effects and suppresses revoked authority",async()=>{
    const unclaimed=await fixture();await pool.query("UPDATE agents_platform.tool_invocation_reviews SET state='approved',claimed_at=NULL WHERE operation_id=$1",[unclaimed.operationId]);
    expect(await transaction(pool,db=>captureConnectedUncertain(db,unclaimed.operationId))).toBe(false);
    const revoked=await fixture();await transaction(pool,db=>captureConnectedUncertain(db,revoked.operationId));
    await pool.query("UPDATE agents_platform.execution_grants SET revoked_at=now() WHERE id=(SELECT grant_id FROM agents_platform.tasks WHERE id=$1)",[revoked.taskId]);
    let calls=0;expect(await processConnectedUncertain(pool,revoked.operationId,async()=>{calls++;return{outcome:"ownership_changed"};})).toBe("authority_unavailable");expect(calls).toBe(0);
    expect((await pool.query("SELECT state,last_error_code,next_attempt_at>now() AS delayed FROM agents_platform.connected_uncertain_escalations WHERE operation_id=$1",[revoked.operationId])).rows[0]).toMatchObject({state:"pending",last_error_code:"authority_unavailable",delayed:true});
    for(let attempt=1;attempt<8;attempt++)await processConnectedUncertain(pool,revoked.operationId,async()=>{calls++;return{outcome:"ownership_changed"};});
    expect((await pool.query("SELECT state,attempt_count,next_attempt_at,last_error_code FROM agents_platform.connected_uncertain_escalations WHERE operation_id=$1",[revoked.operationId])).rows[0]).toMatchObject({state:"pending",attempt_count:8,next_attempt_at:null,last_error_code:"authority_unavailable"});
  });
  it("rolls back incomplete publication and refuses a foreign command",async()=>{
    const f=await fixture();await transaction(pool,db=>captureConnectedUncertain(db,f.operationId));
    await expect(processConnectedUncertain(pool,f.operationId,async()=>({outcome:"recorded",commandId:randomUUID()}))).rejects.toThrow("CONNECTED_ESCALATION_COMMAND_INVALID");
    expect((await pool.query("SELECT state FROM agents_platform.connected_uncertain_escalations WHERE operation_id=$1",[f.operationId])).rows[0].state).toBe("pending");
  });
  it("backs off failed recovery and continues processing other pending work",async()=>{
    const failed=await fixture(),successful=await fixture();
    await transaction(pool,db=>captureConnectedUncertain(db,failed.operationId));
    await transaction(pool,db=>captureConnectedUncertain(db,successful.operationId));
    await pool.query("INSERT INTO agents_platform.customer_commands VALUES($1,$2,'request_handoff')",[successful.conversationId,successful.taskId]);
    const errors:string[]=[];
    await processConnectedUncertainBatch(pool,async(_db,input)=>{
      if(input.operationId===failed.operationId)throw new Error("temporary failure");
      return {outcome:"recorded",commandId:successful.taskId};
    },100,code=>errors.push(code));
    expect(errors).toContain("CONNECTED_ESCALATION_RETRY");
    expect((await pool.query("SELECT state,attempt_count,next_attempt_at>now() AS delayed FROM agents_platform.connected_uncertain_escalations WHERE operation_id=$1",[failed.operationId])).rows[0]).toMatchObject({state:"pending",attempt_count:1,delayed:true});
    expect((await pool.query("SELECT state FROM agents_platform.connected_uncertain_escalations WHERE operation_id=$1",[successful.operationId])).rows[0].state).toBe("recorded");
  });
});
