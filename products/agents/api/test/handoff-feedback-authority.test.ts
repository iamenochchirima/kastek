import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dropClosedTestDatabase } from "./support/database-cleanup";

// Exercise the SQL fence against PostgreSQL. Ordinary grant and skill checks are
// isolated here; their own integration tests exercise their full policies.
vi.mock("../src/execution/admission/trial-authority", () => ({ assertEvaluationTrial: vi.fn() }));
vi.mock("../src/execution/context/visitor-lineage", () => ({ currentVisitorLineageAllowed: vi.fn().mockResolvedValue(true) }));
vi.mock("../src/capabilities/skills/public-policy", () => ({ assertPublicSkillPolicy: vi.fn() }));
vi.mock("../src/capabilities/skills/current-policy", () => ({ assertCurrentSkillPolicy: vi.fn() }));
vi.mock("../src/capabilities/connected-tools/customer-native-policy", () => ({ assertCustomerNativeBindings: vi.fn() }));
vi.mock("../src/capabilities/tool-definitions", async importOriginal => ({ ...(await importOriginal<typeof import("../src/capabilities/tool-definitions")>()), assertPublishedTools: vi.fn() }));
vi.mock("../src/contracts/contracts", async importOriginal => {
  const original = await importOriginal<typeof import("../src/contracts/contracts")>();
  return { ...original, assertGrantAuthority: vi.fn(), executionGrantSchema: { parse: (value: unknown) => value } };
});
import { assertBaseAuthority, assertHandoffFeedbackAdmissionAuthority, assertHandoffFeedbackAuthority } from "../src/execution/lifecycle/authority";
import type { Execution } from "../src/contracts/execution";
import { InboxStore } from "../src/product/inbox/inbox-store";
import { inheritChannelPorts, registerChannelPorts } from "../src/infrastructure/channel-ports";
import type { ChannelExecutionPorts } from "../src/contracts/channel";
import { requestDigest } from "../src/contracts/contracts";
import { createDependencyManifest } from "../src/contracts/source-contracts";
import { HANDOFF_HARNESS_RELEASE } from "../src/contracts/execution";
const url = process.env.AGENTS_TEST_DATABASE_URL;
(url ? describe : describe.skip)("handoff feedback authority", () => {
  const database = `agents_feedback_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool, pool: Pool;
  beforeAll(async () => {
    admin = new Pool({ connectionString: url }); await admin.query(`CREATE DATABASE "${database}"`);
    const target = new URL(url!); target.pathname = `/${database}`; pool = new Pool({ connectionString: target.href });
    await pool.query(`CREATE SCHEMA agents_platform;
      CREATE TABLE agents_platform.pending_handoff_receipts(task_id uuid,conversation_id uuid,ownership_generation bigint,deadline timestamptz,outcome text,feedback_request_digest text,evidence_manifest jsonb);
      CREATE TABLE agents_platform.customer_conversations(id uuid,organization_id uuid,agent_id uuid,state text,ownership_generation bigint,return_watermark bigint,channel_kind text,deployment_id uuid,channel_deployment_id uuid,session_id uuid);
      CREATE TABLE agents_platform.customer_commands(conversation_id uuid,command_id uuid,action text,result jsonb);
      CREATE TABLE agents_platform.customer_task_links(task_id uuid,conversation_id uuid,input_message_id uuid,ownership_generation bigint);
      CREATE TABLE agents_platform.customer_messages(id uuid,conversation_id uuid,author_kind text,ownership_generation bigint,sequence bigint);
      CREATE TABLE agents_platform.execution_roots(root_task_id uuid,settled_at timestamptz);
      CREATE TABLE agents_platform.operations(id text,task_id uuid,kind text,name text,state text,reserved_tokens integer,reserved_ms integer,request jsonb,request_digest text);
      CREATE TABLE agents_platform.model_cost_reservations(operation_id text,task_id uuid,organization_id uuid,root_task_id uuid,state text);
      CREATE TABLE agents_platform.capacity_requests(id text,task_id uuid,state text);
      CREATE TABLE agents_platform.customer_cancellations(task_id uuid,completed_at timestamptz);
      CREATE TABLE agents_platform.website_deployments(id uuid,organization_id uuid,agent_id uuid,revoked_at timestamptz,paused boolean);
      CREATE TABLE agents_platform.channel_deployments(id uuid,organization_id uuid,agent_id uuid,state text,connection_id uuid);
      CREATE TABLE agents_platform.channel_connections(id uuid,organization_id uuid,state text);
      CREATE TABLE agents_platform.conversations(id uuid,deleted_at timestamptz);
      CREATE TABLE agents_platform.tasks(id uuid,parent_task_id uuid,conversation_id uuid);
      CREATE TABLE agents_platform.execution_grants(id uuid,organization_id uuid,revoked_at timestamptz,expires_at timestamptz,operations jsonb);
      CREATE TABLE agents_platform.agent_versions(id uuid,agent_id uuid,organization_id uuid);
      CREATE TABLE agents_platform.website_sessions(id uuid,deployment_id uuid,expires_at timestamptz);`);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); } });
  async function fixture() {
    const [task,org,agent,conv,msg,deploy,session,execConv,version,grant] = Array.from({length:10}, () => randomUUID());
    const operation = `handoff-feedback:${task}`;
    const db = await pool.connect();
    const inbox = new InboxStore(pool, {} as never, {} as never);
    registerChannelPorts(pool, { assertBinding: inbox.assertBinding.bind(inbox) } as ChannelExecutionPorts);
    inheritChannelPorts(pool, db);
    const execution = { task: { id:task, root_task_id:task, parent_task_id:null, organization_id:org, product:"agents", resource_id:deploy,
      caller_client_id:"website", principal:{kind:"visitor",deploymentId:deploy,sessionId:session}, version_id:version,grant_id:grant,
      conversation_id:execConv,state:"running",deadline_at:new Date(Date.now()+60000),evaluation_trial_id:null,harness_release:HANDOFF_HARNESS_RELEASE,
      channel_binding:{customerConversationId:conv,inputMessageId:msg,ownershipGeneration:"1"} }, agentId:agent,
      configuration:{ memory:{enabled:false}, capabilities:{delegation:{enabled:false},sandbox:{enabled:false},workflows:{enabled:false},businessActions:{enabled:false}},tools:["support.request_handoff_v2"],skillIds:[],connectedToolBindingIds:[] },toolBindings:[] } as unknown as Execution;
    await db.query("INSERT INTO agents_platform.customer_conversations VALUES($1,$2,$3,'handoff_pending',2,0,'website',$4,NULL,$5)",[conv,org,agent,deploy,session]);
    const request = { modelRequest:{model:"fixture",messages:[{role:"user",content:"hello"}],maxInputTokens:80,maxOutputTokens:20,maxDurationSeconds:1}, evidenceManifest:createDependencyManifest([]) };
    await db.query("INSERT INTO agents_platform.pending_handoff_receipts VALUES($1,$2,2,now()+interval '1 minute',NULL,$3,$4)",[task,conv,requestDigest(request),request.evidenceManifest]);
    await db.query("INSERT INTO agents_platform.customer_commands VALUES($1,$2,'request_handoff',$3)",[conv,task,{pendingReceiptTaskId:task,ownership_generation:"2"}]);
    await db.query("INSERT INTO agents_platform.customer_task_links VALUES($1,$2,$3,1)",[task,conv,msg]);
    await db.query("INSERT INTO agents_platform.customer_messages VALUES($1,$2,'visitor',1,1)",[msg,conv]);
    await db.query("INSERT INTO agents_platform.execution_roots VALUES($1,NULL)",[task]);
    await db.query("INSERT INTO agents_platform.operations VALUES($1,$2,'model','model.handoff_feedback','started',100,1000,$3,$4)",[operation,task,request,requestDigest(request)]);
    await db.query("INSERT INTO agents_platform.model_cost_reservations VALUES($1,$2,$3,$2,'reserved')",[operation,task,org]);
    await db.query("INSERT INTO agents_platform.capacity_requests VALUES($1,$2,'active')",[operation,task]);
    await db.query("INSERT INTO agents_platform.website_deployments VALUES($1,$2,$3,NULL,false)",[deploy,org,agent]);
    await db.query("INSERT INTO agents_platform.website_sessions VALUES($1,$2,now()+interval '1 minute')",[session,deploy]);
    await db.query("INSERT INTO agents_platform.agent_versions VALUES($1,$2,$3)",[version,agent,org]);
    await db.query("INSERT INTO agents_platform.conversations VALUES($1,NULL)",[execConv]);
    await db.query("INSERT INTO agents_platform.execution_grants VALUES($1,$2,NULL,now()+interval '1 minute','[]')",[grant,org]);
    return {db,execution,task,conv,grant,operation,request};
  }
  it("accepts only the recorded reserved operation and preserves the ordinary ownership fence", async () => {
    const f=await fixture(); try {
      await expect(assertHandoffFeedbackAuthority(f.db,f.execution,f.operation,f.request)).resolves.toBeUndefined();
      await expect(assertHandoffFeedbackAuthority(f.db,f.execution,"other",f.request)).rejects.toMatchObject({code:"HANDOFF_FEEDBACK_DENIED"});
      await expect(assertHandoffFeedbackAuthority(f.db,f.execution,f.operation,{...f.request,modelRequest:{...f.request.modelRequest,model:"changed"}})).rejects.toMatchObject({code:"HANDOFF_FEEDBACK_DENIED"});
      await expect(assertBaseAuthority(f.db,f.execution)).rejects.toMatchObject({code:"CHANNEL_OWNERSHIP_CHANGED"});
    } finally { f.db.release(); }
  });
  it("admits the exact receipt-bound snapshot before reserving capacity", async () => { const f=await fixture(); try {
    await f.db.query("DELETE FROM agents_platform.operations WHERE task_id=$1",[f.task]);
    await expect(assertHandoffFeedbackAdmissionAuthority(f.db,f.execution,f.operation,f.request)).resolves.toEqual(f.request);
    await expect(assertHandoffFeedbackAuthority(f.db,f.execution,f.operation,f.request)).rejects.toMatchObject({code:"HANDOFF_FEEDBACK_DENIED"});
  } finally {f.db.release();} });
  it("rejects the legacy release and changed receipt manifest", async () => { const f=await fixture(); try {
    f.execution.task.harness_release="product-capabilities-v11";
    await expect(assertHandoffFeedbackAdmissionAuthority(f.db,f.execution,f.operation,f.request)).rejects.toMatchObject({code:"HANDOFF_FEEDBACK_DENIED"});
    f.execution.task.harness_release=HANDOFF_HARNESS_RELEASE;
    await f.db.query("UPDATE agents_platform.pending_handoff_receipts SET evidence_manifest='{}' WHERE task_id=$1",[f.task]);
    await expect(assertHandoffFeedbackAdmissionAuthority(f.db,f.execution,f.operation,f.request)).rejects.toMatchObject({code:"HANDOFF_FEEDBACK_DENIED"});
  } finally {f.db.release();} });
  it("accepts a resumed visitor session only when the channel verifies lineage", async () => { const f=await fixture(); try {
    await f.db.query("UPDATE agents_platform.customer_conversations SET session_id=gen_random_uuid() WHERE id=$1",[f.conv]);
    const inbox = new InboxStore(pool, {} as never, {} as never);
    registerChannelPorts(pool, {assertBinding:inbox.assertBinding.bind(inbox),visitorLineage:async () => true} as ChannelExecutionPorts);
    inheritChannelPorts(pool,f.db);
    await expect(assertHandoffFeedbackAdmissionAuthority(f.db,f.execution,f.operation,f.request)).resolves.toEqual(f.request);
  } finally {f.db.release();} });
  it.each([
    ["missing receipt", "DELETE FROM agents_platform.pending_handoff_receipts WHERE task_id=$1"],
    ["missing operation", "DELETE FROM agents_platform.operations WHERE task_id=$1"],
    ["missing budget", "DELETE FROM agents_platform.model_cost_reservations WHERE task_id=$1"],
    ["missing capacity", "DELETE FROM agents_platform.capacity_requests WHERE task_id=$1"],
    ["deadline", "UPDATE agents_platform.pending_handoff_receipts SET deadline=now()-interval '1 second' WHERE task_id=$1"],
    ["takeover", "UPDATE agents_platform.customer_conversations SET state='human_owned',ownership_generation=3 WHERE id=(SELECT conversation_id FROM agents_platform.pending_handoff_receipts WHERE task_id=$1)"],
    ["queued cancellation", "INSERT INTO agents_platform.customer_cancellations VALUES($1,NULL)"],
    ["different visitor session", "UPDATE agents_platform.customer_conversations SET session_id=gen_random_uuid() WHERE id=(SELECT conversation_id FROM agents_platform.pending_handoff_receipts WHERE task_id=$1)"],
    ["settled root", "UPDATE agents_platform.execution_roots SET settled_at=now() WHERE root_task_id=$1"],
  ])("denies %s",async (_name,sql) => { const f=await fixture(); try { await f.db.query(sql,[f.task]); await expect(assertHandoffFeedbackAuthority(f.db,f.execution,f.operation,f.request)).rejects.toMatchObject({code:"HANDOFF_FEEDBACK_DENIED"}); } finally {f.db.release();} });
  it("rejects revoked grants and cancelled tasks", async () => { const f=await fixture(); try {
    await f.db.query("UPDATE agents_platform.execution_grants SET revoked_at=now() WHERE id=$1",[f.grant]);
    await expect(assertHandoffFeedbackAuthority(f.db,f.execution,f.operation,f.request)).rejects.toMatchObject({code:"GRANT_REVOKED"});
    f.execution.task.state="cancel_requested";
    await expect(assertHandoffFeedbackAuthority(f.db,f.execution,f.operation,f.request)).rejects.toMatchObject({code:"TASK_CANCELLED"});
  } finally { f.db.release(); } });
});
