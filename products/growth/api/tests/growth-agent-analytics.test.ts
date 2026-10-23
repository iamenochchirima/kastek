import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { growthAgentCommandFact, growthAgentDraftSavedFact, growthAgentReviewFact } from "../src/agents/analytics.js";
const scope = { tenantId: "business", actor: { issuer: "https://growth.example.test/identity", subject: "PRIVATE-USER" } };
const review = { id: "review-one", orgId: scope.tenantId, taskId: "task-one", conversationId: "conversation-one", featureId: "content" as const, state: "approved", createdAt: new Date("2026-10-23T10:00:00Z"), updatedAt: new Date("2026-10-23T10:01:00Z") };
test("Growth outcomes use registered owned schemas without retired runtime identities or private content", async () => {
  const command = growthAgentCommandFact(scope, { operation: "turns.submit", requestId: "command-one", featureId: "content", conversationId: "conversation-one", taskId: "task-one", outcome: "accepted", failureCode: null });
  const records = [command, growthAgentReviewFact(review, "approved"), growthAgentDraftSavedFact(review, "post-one", "2026-10-23T10:02:00.123Z")];
  const root = new URL("../../../../services/analytics/contracts/", import.meta.url), registry = JSON.parse(await readFile(new URL("registry.json", root), "utf8"));
  const ajv = new Ajv2020({ strict: false }); addFormats(ajv);
  for (const record of records) {
    const entry = registry.contracts.find((item: { identity: string }) => item.identity === record.contract_name); assert(entry); assert.equal(entry.owner, "growth");
    const validate = ajv.compile(JSON.parse(await readFile(new URL(entry.schema, root), "utf8")));
    assert.equal(validate(record.envelope.data), true, JSON.stringify(validate.errors));
    assert.equal(validate({ ...record.envelope.data, installation_id: "invented" }), false);
    assert.equal(validate({ ...record.envelope.data, content: "PRIVATE-DRAFT" }), false);
    assert.equal(record.scope_external_id, scope.tenantId); assert.equal(record.source_domain, "growth_agents");
    assert(!JSON.stringify(record.envelope).includes("PRIVATE-USER"));
  }
});
test("Growth command retries share one logical outcome while actors and failure outcomes stay distinct", () => {
  const input = { operation: "turns.submit" as const, requestId: "command-one", featureId: "content" as const, conversationId: "conversation-one", taskId: "task-one", outcome: "accepted" as const, failureCode: null };
  const first = growthAgentCommandFact(scope, input), retry = growthAgentCommandFact(scope, input);
  assert.equal(first.record_id, retry.record_id); assert.equal(first.payload_hash, retry.payload_hash);
  assert.notEqual(first.record_id, growthAgentCommandFact({ ...scope, actor: { ...scope.actor, subject: "other" } }, input).record_id);
  assert.notEqual(first.record_id, growthAgentCommandFact(scope, { ...input, outcome: "unavailable", failureCode: "agent_service_unavailable" }).record_id);
  const saved = growthAgentDraftSavedFact(review, "post-one", "2026-10-23T10:02:00.123Z");
  assert.equal(saved.payload_hash, growthAgentDraftSavedFact(review, "post-one", "2026-10-23T10:02:00.123Z").payload_hash);
});
