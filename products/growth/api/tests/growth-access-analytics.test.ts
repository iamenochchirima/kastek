import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import { isolatedDatabase } from "./helpers/database-fixture.js";
import { installPgTimestampParsers, transaction } from "../src/db.js";
import { enqueueGrowthAgentAccess, enqueueMissingOAuthAccessEvents, type AgentAccessAction } from "../src/analytics/agent-access.js";

const database = process.env.CORE_SOCIAL_RECOVERY_TEST_DATABASE_URL;
test("registered agent access lifecycle events are transactional, private and replay-safe", { skip: !database }, async () => {
  assert(database, "CORE_SOCIAL_RECOVERY_TEST_DATABASE_URL must identify the owned disposable test database");
  installPgTimestampParsers();
  const db = await isolatedDatabase(database, "growth_access_analytics", ["GrowthOAuthConnection"]);
  try {
    await db.pool.query(await readFile(new URL("../../database/prisma/migrations/20260829180000_add_core_analytics_outbox/migration.sql", import.meta.url), "utf8"));
    await db.pool.query(`CREATE TABLE producer(producer_id text PRIMARY KEY,service_identity_id text,permitted_contract_namespaces jsonb,updated_at timestamptz);
      INSERT INTO producer VALUES('core-customer-analytics','core','["agent","campaign"]',now()),('unrelated','tenant-platform','["conversation"]',now())`);
    const namespaceMigration = (await readFile(new URL("../../../../services/analytics/migrations/20261101160000_growth_agent_access.sql", import.meta.url), "utf8")).replaceAll("analytics.producer", "producer");
    await db.pool.query(namespaceMigration); await db.pool.query(namespaceMigration);
    assert.deepEqual((await db.pool.query("SELECT permitted_contract_namespaces FROM producer WHERE producer_id='core-customer-analytics'")).rows[0].permitted_contract_namespaces, ["agent", "campaign", "growth"]);
    assert.deepEqual((await db.pool.query("SELECT permitted_contract_namespaces FROM producer WHERE producer_id='unrelated'")).rows[0].permitted_contract_namespaces, ["conversation"]);
    const schema = JSON.parse(await readFile(new URL("../../../../services/analytics/contracts/events/growth/agent_access/v1.schema.json", import.meta.url), "utf8"));
    const validate = new Ajv2020({ strict: false }).compile(schema);
    const time = "2026-11-01T10:00:00.123456Z";
    await assert.rejects(transaction(db.pool, async tx => {
      await enqueueGrowthAgentAccess(tx, { orgId: "org", subjectId: "rollback", kind: "operation", action: "proposed", operation: "content.posts.draft.create", time });
      throw new Error("rollback fixture");
    }), /rollback fixture/);
    assert.equal((await db.pool.query('SELECT count(*)::int AS count FROM analytics_outbox')).rows[0].count, 0);
    for (const action of ["proposed", "approved", "rejected", "succeeded", "uncertain", "failed"] as AgentAccessAction[]) {
      const input = { orgId: "org", subjectId: "review", kind: "operation" as const, action, operation: "content.posts.publish_batch", time };
      assert.equal((await transaction(db.pool, tx => enqueueGrowthAgentAccess(tx, input))).kind, "inserted");
      assert.equal((await transaction(db.pool, tx => enqueueGrowthAgentAccess(tx, input))).kind, "duplicate");
    }
    await db.pool.query(`INSERT INTO "GrowthOAuthConnection"(id,"clientId","userId","orgId",resource,scopes,"accessHash","accessExpiresAt","createdAt","revokedAt") VALUES('connection','PRIVATE-CLIENT','PRIVATE-USER','org','https://growth.test/mcp','{growth:read}','PRIVATE-TOKEN-HASH',now()+interval '1 hour',$1,$2)`, [time, "2026-11-01T11:00:00.654321Z"]);
    assert.equal(await enqueueMissingOAuthAccessEvents(db.pool, 1), 1);
    const concurrent = await Promise.all([enqueueMissingOAuthAccessEvents(db.pool, 100), enqueueMissingOAuthAccessEvents(db.pool, 100)]);
    assert.equal(concurrent.reduce((sum, n) => sum + n, 0), 1);
    assert.equal(await enqueueMissingOAuthAccessEvents(db.pool), 0);
    await transaction(db.pool, tx => enqueueGrowthAgentAccess(tx, { orgId: "org", subjectId: "message-review", kind: "operation", action: "succeeded", operation: "inbox.messages.send", time }));
    const rows = (await db.pool.query('SELECT record_id,envelope FROM analytics_outbox ORDER BY source_sequence')).rows;
    assert.equal(rows.length, 9);
    assert.equal(rows.find(row => row.record_id === "growth-access:operation:message-review:succeeded").envelope.data.outcome, "admitted");
    for (const row of rows) {
      assert.equal(validate(row.envelope.data), true, JSON.stringify(validate.errors));
      assert.equal(validate({ ...row.envelope.data, arguments: { token: "PRIVATE" } }), false);
      assert.equal(validate({ ...row.envelope.data, content: "PRIVATE" }), false);
      assert(!JSON.stringify(row.envelope).includes("PRIVATE-"));
      assert.deepEqual(Object.keys(row.envelope.data).sort(), ["action", "kind", "operation", "outcome"]);
    }
    const admitted = rows.find(row => row.record_id.endsWith(":succeeded"));
    assert.equal(admitted.envelope.data.outcome, "admitted");
    const granted = rows.find(row => row.record_id.endsWith(":granted"));
    assert.equal(granted.envelope.time, time);
    await assert.rejects(transaction(db.pool, tx => enqueueGrowthAgentAccess(tx, { orgId: "org", subjectId: "bad", kind: "connection", action: "succeeded", operation: "content.posts.publish_batch", time })), /Invalid Growth/);
  } finally { await db.close(); }
});
