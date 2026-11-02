import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cancelExpiredReceiptRoot, reserveReceipt, settleReceipt, type Publisher } from "../src/product/inbox/handoff-pending-receipt";
import { dispatchReceiptsOnce } from "../src/product/inbox/handoff-pending-receipt-runtime";
import { dropClosedTestDatabase } from "./support/database-cleanup";
import { createDependencyManifest } from "../src/contracts/source-contracts";
import { requestDigest } from "../src/contracts/contracts";

const url = process.env.AGENTS_TEST_DATABASE_URL;
(url ? describe : describe.skip)("pending handoff receipt", () => {
  const database = `agents_receipt_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool, pool: Pool;
  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE DATABASE "${database}"`);
    const target = new URL(url!); target.pathname = `/${database}`;
    pool = new Pool({ connectionString: target.href });
    await pool.query(`CREATE SCHEMA agents_platform;
      CREATE TABLE agents_platform.tasks(id uuid PRIMARY KEY);
      CREATE TABLE agents_platform.customer_conversations(id uuid PRIMARY KEY,state text NOT NULL,ownership_generation bigint NOT NULL);
      CREATE TABLE agents_platform.customer_messages(id uuid PRIMARY KEY, conversation_id uuid NOT NULL, body text NOT NULL);
      CREATE TABLE agents_platform.customer_cancellations(task_id uuid PRIMARY KEY REFERENCES agents_platform.tasks(id));
      CREATE TABLE agents_platform.test_outbound(message_id uuid PRIMARY KEY REFERENCES agents_platform.customer_messages(id));`);
    await pool.query(await readFile(join(__dirname, "../schema/087_handoff_pending_receipts.sql"), "utf8"));
  });
  afterAll(async () => { await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); } });
  async function fixture(delayMs = 60000) {
    const taskId = randomUUID(), conversationId = randomUUID();
    await pool.query("INSERT INTO agents_platform.tasks VALUES($1)", [taskId]);
    await pool.query("INSERT INTO agents_platform.customer_conversations VALUES($1,'handoff_pending',2)", [conversationId]);
    const db = await pool.connect();
    try { await reserveReceipt(db, { taskId, conversationId, ownershipGeneration:"2", delayMs }); }
    finally { db.release(); }
    const publish: Publisher = async (db, input) => {
      const id = randomUUID();
      await db.query("INSERT INTO agents_platform.customer_messages VALUES($1,$2,$3)", [id, conversationId, input.text]);
      await db.query("INSERT INTO agents_platform.test_outbound VALUES($1)", [id]);
      return id;
    };
    return { taskId, conversationId, delayMs, publish };
  }
  it("selects one winner with simultaneous model, failure and replay", async () => {
    const f = await fixture();
    const results = await Promise.all([
      settleReceipt(pool, f.taskId, { text:"Model acknowledgement" }, "Fallback", f.publish),
      settleReceipt(pool, f.taskId, null, "Fallback", f.publish, true),
      settleReceipt(pool, f.taskId, { text:"Duplicate" }, "Fallback", f.publish),
    ]);
    expect(new Set(results).size).toBe(1);
    expect(["model","fallback"]).toContain(results[0]);
    expect(Number((await pool.query("SELECT count(*) AS n FROM agents_platform.customer_messages WHERE conversation_id=$1", [f.conversationId])).rows[0].n)).toBe(1);
    expect(Number((await pool.query("SELECT count(*) AS n FROM agents_platform.test_outbound o JOIN agents_platform.customer_messages m ON m.id=o.message_id WHERE m.conversation_id=$1", [f.conversationId])).rows[0].n)).toBe(1);
    expect((await pool.query("SELECT count(*) n FROM agents_platform.customer_cancellations WHERE task_id=$1",[f.taskId])).rows[0].n).toBe("1");
    await expect(pool.query("UPDATE agents_platform.pending_handoff_receipts SET outcome='suppressed',message_id=NULL WHERE task_id=$1", [f.taskId])).rejects.toMatchObject({ code:"23514" });
  });
  it("waits for the database deadline and rejects a late model candidate", async () => {
    const f = await fixture(40);
    expect(await settleReceipt(pool, f.taskId, null, "Fallback", f.publish)).toBe("pending");
    expect(await cancelExpiredReceiptRoot(pool,f.taskId)).toBe(false);
    await pool.query("SELECT pg_sleep(0.08)");
    expect(await cancelExpiredReceiptRoot(pool,f.taskId)).toBe(true);
    expect(await cancelExpiredReceiptRoot(pool,f.taskId)).toBe(false);
    expect(await settleReceipt(pool, f.taskId, {text:"Late"}, "Fallback", f.publish)).toBe("fallback");
    expect((await pool.query("SELECT body FROM agents_platform.customer_messages WHERE conversation_id=$1", [f.conversationId])).rows[0].body).toBe("Fallback");
  });
  it("deduplicates reservation and rejects incompatible replay", async () => {
    const f = await fixture(); const db = await pool.connect();
    try {
      const first = await reserveReceipt(db, {taskId:f.taskId,conversationId:f.conversationId,ownershipGeneration:"2",delayMs:f.delayMs});
      const again = await reserveReceipt(db, {taskId:f.taskId,conversationId:f.conversationId,ownershipGeneration:"2",delayMs:f.delayMs});
      expect(again.deadline).toEqual(first.deadline);
      await expect(reserveReceipt(db, {taskId:f.taskId,conversationId:f.conversationId,ownershipGeneration:"2",delayMs:1})).rejects.toThrow("RECEIPT_CONFLICT");
    } finally { db.release(); }
  });
  it("binds immutable controller feedback and evidence to a receipt", async () => {
    const taskId = randomUUID(), conversationId = randomUUID();
    await pool.query("INSERT INTO agents_platform.tasks VALUES($1)", [taskId]);
    await pool.query("INSERT INTO agents_platform.customer_conversations VALUES($1,'handoff_pending',2)", [conversationId]);
    const feedback = {modelRequest:{model:"fixture",messages:[{role:"user" as const,content:"Please connect me to support"}],maxInputTokens:100,maxOutputTokens:50,maxDurationSeconds:5},evidenceManifest:createDependencyManifest([])};
    const db=await pool.connect();
    try {
      const input={taskId,conversationId,ownershipGeneration:"2",delayMs:60000,feedback};
      const row=await reserveReceipt(db,input);
      expect(row.feedback_request_digest).toBe(requestDigest(feedback));
      expect(row.evidence_manifest).toEqual(feedback.evidenceManifest);
      expect((await reserveReceipt(db,input)).feedback_request_digest).toBe(row.feedback_request_digest);
      await expect(reserveReceipt(db,{...input,feedback:{...feedback,modelRequest:{...feedback.modelRequest,model:"other"}}})).rejects.toThrow("RECEIPT_CONFLICT");
      await expect(reserveReceipt(db,{...input,feedback:undefined})).rejects.toThrow("RECEIPT_CONFLICT");
      await expect(db.query("UPDATE agents_platform.pending_handoff_receipts SET feedback_request_digest=$2 WHERE task_id=$1",[taskId,"0".repeat(64)])).rejects.toMatchObject({code:"23514"});
      await expect(db.query("UPDATE agents_platform.pending_handoff_receipts SET evidence_manifest=$2 WHERE task_id=$1",[taskId,JSON.stringify({...feedback.evidenceManifest,digest:"0".repeat(64)})])).rejects.toMatchObject({code:"23514"});
    } finally { db.release(); }
  });
  it("suppresses publication after ownership changes and on publisher denial", async () => {
    const f = await fixture();
    await pool.query("UPDATE agents_platform.customer_conversations SET ownership_generation=3 WHERE id=$1", [f.conversationId]);
    expect(await settleReceipt(pool, f.taskId, {text:"Stale"}, "Fallback", f.publish)).toBe("suppressed");
    const other = await fixture();
    expect(await settleReceipt(pool, other.taskId, {text:"Denied"}, "Fallback", async () => null)).toBe("suppressed");
    expect(Number((await pool.query("SELECT count(*) AS n FROM agents_platform.customer_messages WHERE conversation_id=ANY($1)", [[f.conversationId,other.conversationId]])).rows[0].n)).toBe(0);
  });
  it("rolls back publication failures and allows a retry", async () => {
    const f = await fixture();
    const failing: Publisher = async (db, input) => {
      await f.publish(db, input);
      throw new Error("delivery intent failed");
    };
    await expect(settleReceipt(pool, f.taskId, null, "Fallback", failing, true)).rejects.toThrow("delivery intent failed");
    expect((await pool.query("SELECT outcome FROM agents_platform.pending_handoff_receipts WHERE task_id=$1", [f.taskId])).rows[0].outcome).toBeNull();
    expect(Number((await pool.query("SELECT count(*) AS n FROM agents_platform.customer_messages WHERE conversation_id=$1", [f.conversationId])).rows[0].n)).toBe(0);
    expect(await settleReceipt(pool, f.taskId, null, "Fallback", f.publish, true)).toBe("fallback");
  });
  it("retries a lost dispatch response with the same workflow key", async () => {
    const f = await fixture();
    await pool.query("UPDATE agents_platform.pending_handoff_receipts SET dispatched_at=now() WHERE task_id<>$1", [f.taskId]);
    const urls: string[] = [];
    const request = (async (input: string | URL | Request) => {
      urls.push(String(input));
      if (urls.length === 1) throw new Error("response lost");
      return new Response(JSON.stringify({invocationId:"inv_fixture"}), {status:200});
    }) as typeof fetch;
    await expect(dispatchReceiptsOnce(pool, "http://restate.test", request)).rejects.toThrow("response lost");
    await dispatchReceiptsOnce(pool, "http://restate.test", request);
    await dispatchReceiptsOnce(pool, "http://restate.test", request);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toBe(urls[1]);
    expect(urls[0]).toContain(f.taskId);
  });
});
