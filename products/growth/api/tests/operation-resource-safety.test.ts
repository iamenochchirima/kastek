import test from "node:test";
import assert from "node:assert/strict";
import { isolatedDatabase } from "./helpers/database-fixture.js";
import { installPgTimestampParsers } from "../src/db.js";
import { readConfig } from "../src/config.js";
import { invokeGrowthOperation } from "../src/operations/dispatch.js";
import type { RequestContext } from "../src/identity/request-context.js";
import { boundedGrowthOperationResult, operationReviewState, type OperationReviewRow } from "../src/operations/reviews.js";

test("approved and proposed review expiry agree across projections without expiring completed receipts", () => {
  const expired = { expiresAt: new Date(Date.now() - 1000) };
  for (const state of ["proposed", "approved"]) assert.equal(operationReviewState({ ...expired, state } as OperationReviewRow), "expired");
  for (const state of ["succeeded", "failed", "uncertain", "rejected"]) assert.equal(operationReviewState({ ...expired, state } as OperationReviewRow), state);
  assert.equal(operationReviewState({ state: "approved", expiresAt: new Date(Date.now() + 60000) } as OperationReviewRow), "approved");
});

test("bounded observations reconstruct exact Unicode results and reject changed continuations", () => {
  const value = { state: "succeeded", result: { text: "🌍 customer copy ".repeat(2000) } };
  let cursor: string | undefined, joined = "";
  do {
    const page = boundedGrowthOperationResult(value, cursor) as { result: { chunk: string; continuation: string | null } };
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 8192);
    joined += page.result.chunk;
    cursor = page.result.continuation ?? undefined;
  } while (cursor);
  assert.deepEqual(JSON.parse(joined), value);
  const first = boundedGrowthOperationResult(value) as { result: { continuation: string } };
  assert.throws(() => boundedGrowthOperationResult({ ...value, state: "changed" }, first.result.continuation), /result changed/);
});

const database = process.env.CORE_OPERATIONS_TEST_DATABASE_URL;
test("reviewed Inbox and connection changes reject a concurrently changed resource before effects", { skip: !database }, async () => {
  installPgTimestampParsers();
  const fixture = await isolatedDatabase(database!, "operation_resources", ["User", "Organization", "OrganizationMember", "Conversation", "ExternalConnection"]);
  const { pool } = fixture;
  try {
    await pool.query(`INSERT INTO "User"(id,email,"createdAt","updatedAt") VALUES('owner','owner@example.test',now(),now());
      INSERT INTO "Organization"(id,name,slug,"ownerId","createdAt","updatedAt") VALUES('org','Business','resource-fixture','owner',now(),now());
      INSERT INTO "OrganizationMember"(id,"orgId","userId",role,"updatedAt") VALUES('member','org','owner','OWNER',now());
      INSERT INTO "Conversation"(id,"orgId",channel,"customerIdentifier","updatedAt") VALUES('conversation','org','email','immutable-recipient','2030-01-01T00:00:00.001');
      INSERT INTO "ExternalConnection"(id,"orgId",provider,"displayName","sourceType","sourceId",status,"updatedAt") VALUES('connection','org','EMAIL','Mailbox','EMAIL','email-source','CONNECTED','2030-01-01T00:00:00.002');`);
    const context: RequestContext = { principal: { kind: "direct_user", id: "owner", subjectUserId: "owner" }, userId: "owner", organizationId: "org", clientId: null, apiScopes: null, effectiveGrants: new Set(), correlationId: null, causationId: null, idempotencyKey: "resource-review-fixture" };
    const core = { pool, config: readConfig({ DATABASE_URL: database! }) };
    const stale = { expectedResourceRevisions: { conversationId: "2030-01-01T00:00:00Z", connectionId: "2030-01-01T00:00:00Z" } };
    for (const [operation,input] of [
      ["inbox.conversations.update", { conversationId: "conversation", starred: true }],
      ["inbox.conversations.mark_read", { conversationId: "conversation" }],
      ["inbox.messages.send", { conversationId: "conversation", text: "Exact reviewed message" }],
      ["connections.status.update", { connectionId: "connection", status: "REVOKED" }],
    ] as const) await assert.rejects(invokeGrowthOperation(core, context, operation, input, stale), /changed/);
    assert.equal((await pool.query('SELECT starred FROM "Conversation" WHERE id=\'conversation\'')).rows[0].starred, false);
    await invokeGrowthOperation(core, context, "inbox.conversations.update", { conversationId: "conversation", starred: true }, { expectedResourceRevisions: { conversationId: "2030-01-01T00:00:00.001Z" } });
    assert.equal((await pool.query('SELECT starred FROM "Conversation" WHERE id=\'conversation\'')).rows[0].starred, true);
  } finally { await fixture.close(); }
});
