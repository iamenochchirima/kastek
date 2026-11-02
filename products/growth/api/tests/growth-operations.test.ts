import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { growthOperations, getGrowthOperation, validateGrowthOperationInput } from "../src/operations/catalog.js";
import { authorizeGrowthOperation, growthOperationHasScope, listGrowthOperations } from "../src/operations/policy.js";
import { invokeGrowthOperation, sanitizeGrowthOperationResult } from "../src/operations/dispatch.js";
import { readConfig } from "../src/config.js";
import type { RequestContext } from "../src/identity/request-context.js";

function context(scopes: string[] | null = ["growth:read"]): RequestContext {
  return { principal: { kind: "workspace_api_key", id: "key", subjectUserId: "user", clientId: "key" }, organizationId: "org", userId: "user", clientId: "key", apiScopes: scopes === null ? null : new Set(scopes), effectiveGrants: new Set(), correlationId: "fixture", causationId: null, idempotencyKey: null };
}

test("canonical Growth catalogue binds every write to review and an explicit authority without publish escalation", () => {
  assert.equal(new Set(growthOperations.map(operation => operation.name)).size, growthOperations.length);
  assert.ok(growthOperations.length >= 40);
  for (const operation of growthOperations) {
    assert.equal(operation.version, "1");
    assert.equal(operation.review, operation.effect === "read" || operation.stagingControl ? "none" : "required");
    assert.equal(operation.idempotency, operation.effect === "read" ? "not_applicable" : "required");
    assert.equal(operation.inputSchema.additionalProperties, false);
    assert.equal(growthOperationHasScope(context([operation.scope]), operation), true);
    if (operation.effect === "external_effect" || operation.effect === "destructive")
      assert.equal(growthOperationHasScope(context(["api:read", "api:write", "growth:draft"]), operation), false);
  }
  assert.equal(growthOperationHasScope(context(["api:read"]), getGrowthOperation("content.posts.get")), true);
  assert.equal(growthOperationHasScope(context(["api:write"]), getGrowthOperation("content.posts.draft.create")), true);
  assert.equal(growthOperationHasScope(context(null), getGrowthOperation("content.posts.get")), false);
});

test("canonical schemas reject invented authority and invalid resource selection", () => {
  assert.throws(() => getGrowthOperation("content.raw_sql"), /not found/);
  assert.throws(() => validateGrowthOperationInput("content.posts.publish", { postId: "post", platform: "FACEBOOK", approved: true }), /Check the operation arguments/);
  assert.throws(() => validateGrowthOperationInput("content.posts.schedule", { postId: "post", scheduledFor: "2030-01-01T09:00" }), /Check the operation arguments/);
  assert.throws(() => validateGrowthOperationInput("content.posts.publish_batch.status", {}), /Choose a post or batch/);
  assert.throws(() => validateGrowthOperationInput("content.media.upload", { mimeType: "image/png", base64: "not base64!" }), /canonical base64/);
  assert.throws(() => validateGrowthOperationInput("content.posts.draft.create", { draft: { metadata: { unrelated: "x".repeat(150000) } } }), /exceed the supported limit/);
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  assert.throws(() => validateGrowthOperationInput("workspace.read", cycle), /must be JSON data/);
  validateGrowthOperationInput("content.posts.schedule", { postId: "post", scheduledFor: "2030-01-01T09:00:00+02:00" });
});

test("published Facebook updates require publishing authority and exact content revision", () => {
  const definition = getGrowthOperation("content.posts.update_published");
  assert.equal(definition.effect, "external_effect");
  assert.equal(definition.scope, "growth:publish");
  assert.equal(definition.review, "required");
  assert.equal(definition.idempotency, "required");
  assert.equal(growthOperationHasScope(context(["growth:draft", "api:write"]), definition), false);
  assert.equal(growthOperationHasScope(context(["growth:publish"]), definition), true);
  validateGrowthOperationInput(definition.name, { postId: "post", content: "Corrected caption", expectedUpdatedAt: "2030-01-01T00:00:00.000Z" });
  validateGrowthOperationInput(definition.name, { postId: "post", content: "Corrected caption", expectedUpdatedAt: "2030-01-01T00:00:00.000Z", removePhoto: true });
  for (const input of [
    { postId: "post", content: "Corrected caption" },
    { postId: "post", content: "", expectedUpdatedAt: "2030-01-01T00:00:00.000Z" },
    { postId: "post", content: "Caption", expectedUpdatedAt: "invalid" },
    { postId: "post", content: "Caption", expectedUpdatedAt: "2030-01-01T00:00:00.000Z", removePhoto: "yes" },
    { postId: "post", content: "Caption", expectedUpdatedAt: "2030-01-01T00:00:00.000Z", media: [] },
  ]) assert.throws(() => validateGrowthOperationInput(definition.name, input), /Check the operation arguments/);
});

test("canonical results preserve content while excluding credentials and retaining integer precision", () => {
  assert.deepEqual(sanitizeGrowthOperationResult({ content: "Customer's draft", account: { access_token: "private", refreshToken: "private", accessTokenEncrypted: "private", refresh_token_encrypted: "private", token: "private", secretKey: "private", apiSecret: "private", displayName: "Business" }, count: 9007199254740993n, updatedAt: new Date("2030-01-01T00:00:00Z") }),
    { content: "Customer's draft", account: { displayName: "Business" }, count: "9007199254740993", updatedAt: "2030-01-01T00:00:00.000Z" });
});

const database = process.env.CORE_OPERATIONS_TEST_DATABASE_URL ?? process.env.CORE_SOCIAL_TEST_DATABASE_URL;
test("real Growth operation authorization rechecks membership, scopes and actor while dispatching the owning service", { skip: !database }, async () => {
  const schema = `growth_operations_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: database });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${schema} -c timezone=UTC` });
  const core = { pool, config: readConfig({ DATABASE_URL: database! }) };
  try {
    await pool.query(`CREATE TABLE "Organization"(id text PRIMARY KEY,name text,slug text,logo text,"ownerId" text,"reportingTimezone" text,"createdAt" timestamptz,"updatedAt" timestamptz);
      CREATE TABLE "OrganizationMember"("orgId" text,"userId" text,role text);
      CREATE TABLE "OrganizationOnboardingProfile"("orgId" text,website text,industry text,"primaryGoal" text,"primaryGoals" text[]);
      CREATE TABLE "DeveloperApiKey"(id text,"orgId" text,"createdById" text,scopes text[],status text,"expiresAt" timestamptz);
      INSERT INTO "DeveloperApiKey" VALUES('key','org','user',ARRAY['growth:read','growth:draft'],'ACTIVE',NULL);
      INSERT INTO "Organization" VALUES('org','A business','a-business',NULL,'user','Africa/Johannesburg',NOW(),NOW()),('foreign','Other business','other-business',NULL,'other','UTC',NOW(),NOW());
      INSERT INTO "OrganizationMember" VALUES('org','user','OWNER');`);
    const result = await invokeGrowthOperation(core, context(), "workspace.read", {}) as { workspace: { id: string; name: string } };
    assert.equal(result.workspace.id, "org");
    assert.equal(result.workspace.name, "A business");
    await assert.rejects(invokeGrowthOperation(core, { ...context(), organizationId: "foreign" }, "workspace.read", {}), /expired or was revoked/);
    await assert.rejects(invokeGrowthOperation(core, context(["growth:draft"]), "workspace.read", {}), /does not permit/);
    await assert.rejects(authorizeGrowthOperation(core, context(["growth:draft"]), "content.posts.draft.create"), /idempotency key/);
    const listed = await listGrowthOperations(core, context());
    assert.ok(listed.some(operation => operation.name === "workspace.read"));
    assert.ok(listed.every(operation => operation.effect === "read"));
    const internal = { ...context(), principal: { kind: "trusted_internal_service" as const, id: "worker", subjectUserId: "user", clientId: "worker" } };
    assert.deepEqual(await invokeGrowthOperation(core, internal, "workspace.read", {}), result);
    const internalListed = await listGrowthOperations(core, internal);
    assert.deepEqual(internalListed, listed);
    await assert.rejects(invokeGrowthOperation(core, internal, "content.posts.publish", { postId: "post", platform: "FACEBOOK" }), /does not permit/);
    await pool.query('UPDATE "DeveloperApiKey" SET status=\'REVOKED\' WHERE id=$1', ["key"]);
    await assert.rejects(invokeGrowthOperation(core, context(), "workspace.read", {}), /expired or was revoked/);
    await pool.query('UPDATE "DeveloperApiKey" SET status=\'ACTIVE\' WHERE id=$1', ["key"]);
    await pool.query('DELETE FROM "OrganizationMember" WHERE "orgId"=$1 AND "userId"=$2', ["org", "user"]);
    await assert.rejects(invokeGrowthOperation(core, context(), "workspace.read", {}), /Not a member/);
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
  }
});
