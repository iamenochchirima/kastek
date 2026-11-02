import test from "node:test";
import assert from "node:assert/strict";
import { isolatedDatabase } from "./helpers/database-fixture.js";
import { readConfig } from "../src/config.js";
import { assertDelegatedSocialAuthority } from "../src/operations/delegation.js";

const database = process.env.CORE_SOCIAL_RECOVERY_TEST_DATABASE_URL;
test("queued delegated authority observes rollout flags and restored flags retain live OAuth revocation checks", { skip: !database }, async () => {
  assert(database, "Use the owned disposable database via CORE_SOCIAL_RECOVERY_TEST_DATABASE_URL");
  const db = await isolatedDatabase(database, "delegated_worker_flags", ["User", "OrganizationMember", "GrowthOperationReview", "GrowthOAuthConnection", "GrowthOAuthRefresh"]);
  try {
    await db.pool.query(`INSERT INTO "User"(id,name,email,"emailVerified","updatedAt") VALUES('user','Fixture','fixture@example.test',now(),now());
      INSERT INTO "OrganizationMember"(id,"orgId","userId",role,"updatedAt") VALUES('member','org','user','OWNER',now());
      INSERT INTO "GrowthOperationReview"(id,"orgId","userId","principalId","principalKind",operation,version,"requestKey","payloadDigest",input,snapshot,state,"expiresAt") VALUES('review','org','user','connection','oauth_user','content.posts.schedule','1','request','digest','{}','{}','succeeded',now()+interval '1 hour');
      INSERT INTO "GrowthOAuthConnection"(id,"clientId","userId","orgId",resource,scopes,"accessHash","accessExpiresAt") VALUES('connection','client','user','org','https://growth.test/mcp','{growth:publish}','hash',now()-interval '1 hour');
      INSERT INTO "GrowthOAuthRefresh"(hash,"connectionId","expiresAt") VALUES('refresh','connection',now()+interval '1 day')`);
    const authority = { _kasitek_delegation: { version: 1, orgId: "org", userId: "user", principalId: "connection", principalKind: "oauth_user", reviewId: "review", operation: "content.posts.schedule", scope: "growth:publish" } };
    const enabled = { ...readConfig({ DATABASE_URL: database, GROWTH_AGENT_ACCESS_ENABLED: "true", GROWTH_AGENT_EFFECTS_ENABLED: "true" }), environment: "production" };
    await assertDelegatedSocialAuthority({ pool: db.pool, config: enabled }, "org", "user", authority);
    for (const env of [{ GROWTH_AGENT_ACCESS_ENABLED: "false", GROWTH_AGENT_EFFECTS_ENABLED: "true" }, { GROWTH_AGENT_ACCESS_ENABLED: "true", GROWTH_AGENT_EFFECTS_ENABLED: "false" }, {}]) {
      const disabled = { ...readConfig({ DATABASE_URL: database, ...env }), environment: "production" };
      await assert.rejects(assertDelegatedSocialAuthority({ pool: db.pool, config: disabled }, "org", "user", authority), /permission was revoked/);
      // Normal explicit human queues have no delegated stamp and remain available.
      await assertDelegatedSocialAuthority({ pool: db.pool, config: disabled }, "org", "user", null);
    }
    await assertDelegatedSocialAuthority({ pool: db.pool, config: enabled }, "org", "user", authority);
    await db.pool.query(`UPDATE "GrowthOAuthConnection" SET "revokedAt"=now() WHERE id='connection'`);
    await assert.rejects(assertDelegatedSocialAuthority({ pool: db.pool, config: enabled }, "org", "user", authority), /permission was revoked/);
  } finally { await db.close(); }
});
