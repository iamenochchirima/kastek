import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll,beforeAll,describe,expect,it } from "vitest";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const url=process.env.AGENTS_TEST_DATABASE_URL;
(url?describe:describe.skip)("staff reconciliation receipt schema draft",()=>{
  const database=`agents_reconcile_${randomUUID().replaceAll("-","")}`;let admin:Pool,pool:Pool;
  beforeAll(async()=>{
    admin=new Pool({connectionString:url});await admin.query(`CREATE DATABASE "${database}"`);
    const target=new URL(url!);target.pathname=`/${database}`;pool=new Pool({connectionString:target.href});
    await pool.query(`CREATE SCHEMA agents_platform;
      CREATE TABLE agents_platform.accounts(id uuid PRIMARY KEY);
      CREATE TABLE agents_platform.customer_conversations(id uuid PRIMARY KEY,organization_id uuid NOT NULL,UNIQUE(organization_id,id));
      CREATE TABLE agents_platform.connected_uncertain_escalations(operation_id text PRIMARY KEY,organization_id uuid NOT NULL,conversation_id uuid NOT NULL,claim_digest text NOT NULL);`);
    await pool.query(await readFile(join(__dirname,"../schema/091_connected_reconciliation.sql"),"utf8"));
  });
  afterAll(async()=>{await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}});
  async function fixture(){
    const organizationId=randomUUID(),conversationId=randomUUID(),accountId=randomUUID(),operationId=randomUUID(),claimDigest="a".repeat(64);
    await pool.query("INSERT INTO agents_platform.accounts VALUES($1)",[accountId]);
    await pool.query("INSERT INTO agents_platform.customer_conversations VALUES($1,$2)",[conversationId,organizationId]);
    await pool.query("INSERT INTO agents_platform.connected_uncertain_escalations VALUES($1,$2,$3,$4)",[operationId,organizationId,conversationId,claimDigest]);
    const insert=async(id=randomUUID(),requestKey=randomUUID(),offset="20 seconds")=>pool.query(`INSERT INTO agents_platform.connected_reconciliation_attempts
      (id,organization_id,conversation_id,operation_id,requested_by,request_key,request_digest,source_claim_digest,connection_policy_revision,created_at,deadline_at)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8,1,t,t+$9::interval FROM (SELECT clock_timestamp() t) clock RETURNING *`,
      [id,organizationId,conversationId,operationId,accountId,requestKey,"b".repeat(64),claimDigest,offset]);
    return{organizationId,conversationId,accountId,operationId,claimDigest,insert};
  }
  it("enforces one active attempt and staff request idempotency",async()=>{
    const f=await fixture(),requestKey=randomUUID(),id=randomUUID();await f.insert(id,requestKey);
    await expect(f.insert(randomUUID(),randomUUID())).rejects.toMatchObject({code:"23505"});
    await pool.query("UPDATE agents_platform.connected_reconciliation_attempts SET state='unavailable',observed_at=now(),reason='provider_unavailable' WHERE id=$1",[id]);
    await expect(f.insert(randomUUID(),requestKey)).rejects.toMatchObject({code:"23505"});
    expect((await f.insert()).rowCount).toBe(1);
  });
  it("binds the exact originating organization, conversation and claim",async()=>{
    const f=await fixture();
    await expect(pool.query(`INSERT INTO agents_platform.connected_reconciliation_attempts
      (id,organization_id,conversation_id,operation_id,requested_by,request_key,request_digest,source_claim_digest,connection_policy_revision,created_at,deadline_at)
      SELECT $1,$2,$3,$4,$5,$6,$7,$8,1,t,t+interval '20 seconds' FROM (SELECT clock_timestamp() t) clock`,
      [randomUUID(),f.organizationId,f.conversationId,f.operationId,f.accountId,randomUUID(),"b".repeat(64),"c".repeat(64)])).rejects.toMatchObject({code:"23514"});
  });
  it("enforces bounded deadlines and immutable terminal observations",async()=>{
    const f=await fixture();await expect(f.insert(randomUUID(),randomUUID(),"31 seconds")).rejects.toMatchObject({code:"23514"});
    const id=randomUUID();await f.insert(id);
    await pool.query("UPDATE agents_platform.connected_reconciliation_attempts SET state='claimed',lease_token=$2,lease_until=deadline_at WHERE id=$1",[id,randomUUID()]);
    await pool.query("UPDATE agents_platform.connected_reconciliation_attempts SET state='found',lease_token=NULL,lease_until=NULL,observed_at=now(),provider_response_digest=$2,reason='matching_record_observed' WHERE id=$1",[id,"d".repeat(64)]);
    await expect(pool.query("UPDATE agents_platform.connected_reconciliation_attempts SET reason='mismatch' WHERE id=$1",[id])).rejects.toMatchObject({code:"23514"});
    await expect(pool.query("DELETE FROM agents_platform.connected_reconciliation_attempts WHERE id=$1",[id])).rejects.toMatchObject({code:"23514"});
  });
  it("rejects stale claim publication while permitting timeout as unavailable",async()=>{
    const f=await fixture(),id=randomUUID();await f.insert(id);
    await pool.query("UPDATE agents_platform.connected_reconciliation_attempts SET state='claimed',lease_token=$2,lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[id,randomUUID()]);
    await expect(pool.query("UPDATE agents_platform.connected_reconciliation_attempts SET state='found',lease_token=NULL,lease_until=NULL,observed_at=now(),provider_response_digest=$2,reason='matching_record_observed' WHERE id=$1",[id,"d".repeat(64)])).rejects.toMatchObject({code:"23514"});
    await pool.query("UPDATE agents_platform.connected_reconciliation_attempts SET state='unavailable',lease_token=NULL,lease_until=NULL,observed_at=now(),reason='deadline_expired' WHERE id=$1",[id]);
    expect((await pool.query("SELECT state FROM agents_platform.connected_reconciliation_attempts WHERE id=$1",[id])).rows[0].state).toBe("unavailable");
  });
});
