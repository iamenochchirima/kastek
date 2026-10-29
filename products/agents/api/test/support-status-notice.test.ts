import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertSupportStatusNotice, assertSupportStatusNoticeVisible, publishSupportStatus, type StatusNoticeBinding } from "../src/product/inbox/support-status-notice";
import { transaction } from "../src/infrastructure/database";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const url=process.env.AGENTS_TEST_DATABASE_URL;
(url?describe:describe.skip)("support status notice authorization draft",()=>{
  const database=`agents_status_${randomUUID().replaceAll("-","")}`;
  let admin:Pool,pool:Pool;
  beforeAll(async()=>{
    admin=new Pool({connectionString:url});await admin.query(`CREATE DATABASE "${database}"`);
    const target=new URL(url!);target.pathname=`/${database}`;pool=new Pool({connectionString:target.href});
    await pool.query(`CREATE SCHEMA agents_platform;
      CREATE TABLE agents_platform.organizations(id uuid PRIMARY KEY);
      CREATE TABLE agents_platform.customer_conversations(id uuid PRIMARY KEY,organization_id uuid,state text,ownership_generation bigint,channel_kind text,deployment_id uuid,session_id uuid,channel_deployment_id uuid);
      CREATE TABLE agents_platform.customer_messages(id uuid PRIMARY KEY,conversation_id uuid,author_kind text,ownership_generation bigint,sequence bigint,body text,request_key text);
      CREATE TABLE agents_platform.website_deployments(id uuid PRIMARY KEY,organization_id uuid,revoked_at timestamptz,paused boolean);
      CREATE TABLE agents_platform.website_sessions(id uuid PRIMARY KEY,deployment_id uuid,expires_at timestamptz);
      CREATE TABLE agents_platform.channel_deployments(id uuid PRIMARY KEY,organization_id uuid,connection_id uuid,state text);
      CREATE TABLE agents_platform.channel_connections(id uuid PRIMARY KEY,organization_id uuid,state text);
      CREATE TABLE agents_platform.tasks(id uuid PRIMARY KEY,root_task_id uuid,organization_id uuid,execution_purpose text,grant_id uuid,principal jsonb,product text,resource_id text,version_id uuid,caller_client_id text,state text,deadline_at timestamptz DEFAULT now()+interval '1 minute');
      CREATE TABLE agents_platform.customer_cancellations(task_id uuid,completed_at timestamptz);
      CREATE TABLE agents_platform.execution_grants(id uuid PRIMARY KEY,organization_id uuid,revoked_at timestamptz,expires_at timestamptz,principal jsonb,product text,resource_id text,version_id uuid,caller_client_id text);
      CREATE TABLE agents_platform.support_waiting(task_id uuid PRIMARY KEY,conversation_id uuid,ownership_generation bigint);
      CREATE TABLE agents_platform.support_status_executions(task_id uuid PRIMARY KEY,organization_id uuid,conversation_id uuid,input_message_id uuid,episode_command_id uuid,ownership_generation bigint);
      CREATE TABLE agents_platform.operations(id text PRIMARY KEY,task_id uuid,kind text,name text,state text,output jsonb);
      CREATE TABLE agents_platform.test_outbound(message_id uuid PRIMARY KEY);`);
    await pool.query(await readFile(join(__dirname,"fixtures/support-status-notice-minimal.sql"),"utf8"));
  });
  afterAll(async()=>{await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}});
  async function fixture(){
    const taskId=randomUUID(),organizationId=randomUUID(),conversationId=randomUUID(),inputMessageId=randomUUID(),episodeCommandId=randomUUID(),deploymentId=randomUUID(),sessionId=randomUUID(),grantId=randomUUID(),versionId=randomUUID();
    const principal={kind:"visitor",deploymentId,sessionId},body="Your request is still waiting for support.";
    await pool.query("INSERT INTO agents_platform.organizations VALUES($1)",[organizationId]);
    await pool.query("INSERT INTO agents_platform.website_deployments VALUES($1,$2,NULL,false)",[deploymentId,organizationId]);
    await pool.query("INSERT INTO agents_platform.website_sessions VALUES($1,$2,now()+interval '1 hour')",[sessionId,deploymentId]);
    await pool.query("INSERT INTO agents_platform.customer_conversations VALUES($1,$2,'handoff_pending',2,'website',$3,$4,NULL)",[conversationId,organizationId,deploymentId,sessionId]);
    await pool.query("INSERT INTO agents_platform.customer_messages VALUES($1,$2,'visitor',2,1,'Any update?','visitor')",[inputMessageId,conversationId]);
    await pool.query("INSERT INTO agents_platform.execution_grants VALUES($1,$2,NULL,now()+interval '1 hour',$3,'agents',$4,$5,'fixture')",[grantId,organizationId,principal,deploymentId,versionId]);
    await pool.query("INSERT INTO agents_platform.tasks(id,root_task_id,organization_id,execution_purpose,grant_id,principal,product,resource_id,version_id,caller_client_id,state) VALUES($1,$1,$2,'support_status_v1',$3,$4,'agents',$5,$6,'fixture','running')",[taskId,organizationId,grantId,principal,deploymentId,versionId]);
    await pool.query("INSERT INTO agents_platform.support_waiting VALUES($1,$2,2)",[episodeCommandId,conversationId]);
    await pool.query("INSERT INTO agents_platform.support_status_executions VALUES($1,$2,$3,$4,$5,2)",[taskId,organizationId,conversationId,inputMessageId,episodeCommandId]);
    await pool.query("INSERT INTO agents_platform.operations VALUES($1,$2,'model','model.support_status','completed',$3)",[`support-status:${taskId}`,taskId,{finishReason:"stop",message:{role:"assistant",content:JSON.stringify({reply:body})}}]);
    const binding:StatusNoticeBinding={taskId,organizationId,conversationId,inputMessageId,episodeCommandId,ownershipGeneration:"2"};
    let allowed=true;
    const verify=async()=>allowed;
    const append=async(db:any,_binding:StatusNoticeBinding,text:string)=>{
      const id=randomUUID();await db.query("INSERT INTO agents_platform.customer_messages VALUES($1,$2,'assistant',2,2,$3,$4)",[id,conversationId,text,`support-status:${taskId}`]);
      await db.query("INSERT INTO agents_platform.test_outbound VALUES($1)",[id]);return id;
    };
    const publish=()=>transaction(pool,db=>publishSupportStatus(db,binding,body,verify,append));
    const check=(id:string)=>transaction(pool,db=>assertSupportStatusNotice(db,binding,id,body,verify));
    const visible=(id:string)=>transaction(pool,db=>assertSupportStatusNoticeVisible(db,binding,id,body,verify));
    return {binding,body,publish,check,visible,deny:()=>{allowed=false;},deploymentId};
  }
  it("publishes one receipt and one outbound intent under concurrent retries",async()=>{
    const f=await fixture();const ids=await Promise.all([f.publish(),f.publish()]);
    expect(ids[0]).toBeTruthy();expect(ids[1]).toBe(ids[0]);expect(await f.check(ids[0]!)).toBe(true);
    expect((await pool.query("SELECT count(*) n FROM agents_platform.test_outbound WHERE message_id=$1",[ids[0]])).rows[0].n).toBe("1");
    await expect(pool.query("UPDATE agents_platform.support_status_notices SET body_digest=$2 WHERE task_id=$1",[f.binding.taskId,"0".repeat(64)])).rejects.toMatchObject({code:"23514"});
    await expect(pool.query("DELETE FROM agents_platform.support_status_notices WHERE task_id=$1",[f.binding.taskId])).rejects.toMatchObject({code:"23514"});
    await pool.query("UPDATE agents_platform.tasks SET state='completed' WHERE id=$1",[f.binding.taskId]);
    expect((await pool.query("DELETE FROM agents_platform.support_status_notices WHERE task_id=$1",[f.binding.taskId])).rowCount).toBe(1);
  });
  it("rejects stale ownership, newer messages, revoked grants and disconnected recipients",async()=>{
    for(const kind of ["ownership","newer","grant","disconnected","cancelled","deadline"]){
      const f=await fixture(),b=f.binding;
      if(kind==="ownership")await pool.query("UPDATE agents_platform.customer_conversations SET ownership_generation=3 WHERE id=$1",[b.conversationId]);
      if(kind==="newer")await pool.query("INSERT INTO agents_platform.customer_messages VALUES($1,$2,'visitor',2,3,'More','new')",[randomUUID(),b.conversationId]);
      if(kind==="grant")await pool.query("UPDATE agents_platform.execution_grants SET revoked_at=now() WHERE id=(SELECT grant_id FROM agents_platform.tasks WHERE id=$1)",[b.taskId]);
      if(kind==="disconnected")await pool.query("UPDATE agents_platform.website_deployments SET paused=true WHERE id=$1",[f.deploymentId]);
      if(kind==="cancelled")await pool.query("UPDATE agents_platform.tasks SET state='cancel_requested' WHERE id=$1",[b.taskId]);
      if(kind==="deadline")await pool.query("UPDATE agents_platform.tasks SET deadline_at=now()-interval '1 second' WHERE id=$1",[b.taskId]);
      expect(await f.publish()).toBeNull();
    }
  });
  it("suppresses reads and deliveries after a human reply or evidence withdrawal",async()=>{
    const f=await fixture(),id=await f.publish();expect(id).toBeTruthy();
    f.deny();expect(await f.check(id!)).toBe(false);
    const other=await fixture(),otherId=await other.publish();
    await pool.query("INSERT INTO agents_platform.customer_messages VALUES($1,$2,'human',2,3,'Hello','human')",[randomUUID(),other.binding.conversationId]);
    expect(await other.check(otherId!)).toBe(false);
    expect(await other.visible(otherId!)).toBe(true);
    await pool.query("UPDATE agents_platform.customer_conversations SET state='human_owned',ownership_generation=3 WHERE id=$1",[other.binding.conversationId]);
    await pool.query("INSERT INTO agents_platform.customer_messages VALUES($1,$2,'visitor',3,4,'Thanks','later')",[randomUUID(),other.binding.conversationId]);
    expect(await other.visible(otherId!)).toBe(true);
    other.deny();expect(await other.visible(otherId!)).toBe(false);
  });
  it("rejects uncompleted operations and mismatched model output",async()=>{
    const f=await fixture();await pool.query("UPDATE agents_platform.operations SET output=$2 WHERE task_id=$1",[f.binding.taskId,{finishReason:"stop",message:{role:"assistant",content:JSON.stringify({reply:"different"})}}]);expect(await f.publish()).toBeNull();
    const other=await fixture();await pool.query("UPDATE agents_platform.operations SET state='started' WHERE task_id=$1",[other.binding.taskId]);expect(await other.publish()).toBeNull();
  });
});
