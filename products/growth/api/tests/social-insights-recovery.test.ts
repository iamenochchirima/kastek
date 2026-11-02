import test from "node:test";
import assert from "node:assert/strict";
import { isolatedDatabase } from "./helpers/database-fixture.js";
import { readConfig } from "../src/config.js";
import { installPgTimestampParsers } from "../src/db.js";
import { syncSocialPostInsights } from "../src/services/social/insights.js";
import { encryptSocialSecret } from "../src/integrations/crypto.js";
const database = process.env.CORE_SOCIAL_RECOVERY_TEST_DATABASE_URL;
test("Facebook insights retain the Page story after its photo is detached", { skip: !database }, async () => {
  installPgTimestampParsers();
  const db = await isolatedDatabase(database!, "facebook_detached_insights", [
    "SocialPost", "SocialPostVariant", "SocialPublishJob", "SocialPostMedia", "ContentMediaAsset",
    "SocialChannelConnection", "SocialPostInsightObservation", "SocialPostInsightSyncState",
  ]);
  const config = readConfig({ DATABASE_URL: database!, SOCIAL_TOKEN_ENCRYPTION_KEY: "fixture" });
  const requests: string[] = [];
  try {
    await db.pool.query(`INSERT INTO "SocialChannelConnection"(id,"userId","orgId",platform,status,"displayName","externalAccountId","accessToken",metadata,"updatedAt") VALUES('channel','user','org','FACEBOOK','CONNECTED','Page','123',$1,'{}',NOW())`, [encryptSocialSecret(config, "fixture-token")]);
    await db.pool.query(`INSERT INTO "SocialPost"(id,"userId","orgId",content,channels,status,"publishedAt","updatedAt") VALUES('post','user','org','Caption','{FACEBOOK}','PUBLISHED',NOW(),NOW());
      INSERT INTO "SocialPublishJob"(id,"userId","orgId","postId","channelConnectionId",platform,status,"externalPostId",metadata,"publishedAt","updatedAt") VALUES('job','user','org','post','channel','FACEBOOK','PUBLISHED','456','{"_kasitek_facebook_story":{"id":"123_789","originalExternalPostId":"456","photoDetached":true}}',NOW(),NOW())`);
    await syncSocialPostInsights(db.pool, "org", null, 10, { config, fetch: async url => {
      requests.push(String(url));
      return Response.json({ data: [] });
    } });
    assert.equal(requests.length, 1);
    assert.equal(new URL(requests[0]!).pathname, "/v23.0/123_789/insights");
    assert.equal((await db.pool.query('SELECT "externalPostId" FROM "SocialPublishJob"')).rows[0].externalPostId, "456");
  } finally { await db.close(); }
});
test(
  "Social insight provider failure persists fifteen-minute cooldown and recovers after its due time",
  { skip: !database, timeout: 30000 },
  async () => {
    installPgTimestampParsers();
    const db = await isolatedDatabase(database!, "social_insights_recovery", [
      "SocialPost",
      "SocialPostVariant",
      "SocialPublishJob",
      "SocialPostMedia",
      "ContentMediaAsset",
      "SocialChannelConnection",
      "SocialPostInsightObservation",
      "SocialPostInsightSyncState",
    ]);
    let calls = 0,
      failed = true;
    const options = {
      config: readConfig({ DATABASE_URL: database! }),
      fetch: (async () => {
        calls++;
        return failed
          ? new Response("Fixture unavailable", { status: 503 })
          : new Response(
              JSON.stringify({
                posts: [{ likeCount: 4, replyCount: 2, repostCount: 1 }],
              }),
            );
      }) as typeof fetch,
    };
    try {
      await db.pool
        .query(`INSERT INTO "SocialChannelConnection"(id,"userId","orgId",platform,status,"displayName","externalAccountId",metadata,"updatedAt") VALUES('channel','user','org','BLUESKY','CONNECTED','Fixture','fixture','{}',NOW());
 INSERT INTO "SocialPost"(id,"userId","orgId",content,channels,status,"publishedAt","updatedAt") VALUES('post','user','org','Fixture','{BLUESKY}','PUBLISHED',NOW(),NOW());
 INSERT INTO "SocialPublishJob"(id,"userId","orgId","postId","channelConnectionId",platform,status,"externalPostId","publishedAt","updatedAt") VALUES('job','user','org','post','channel','BLUESKY','PUBLISHED','at://fixture',NOW(),NOW())`);
      assert.equal(
        await syncSocialPostInsights(db.pool, "org", null, 10, options),
        1,
      );
      assert.equal(calls, 1);
      const failure = (
        await db.pool.query(
          'SELECT status,retryable,"consecutiveFailures","lastErrorCode",EXTRACT(EPOCH FROM ("nextRetryAt"-"lastAttemptAt"))::integer AS delay FROM "SocialPostInsightSyncState"',
        )
      ).rows[0];
      assert.deepEqual(failure, {
        status: "RETRYABLE_FAILURE",
        retryable: true,
        consecutiveFailures: 1,
        lastErrorCode: "provider_fetch_failed",
        delay: 900,
      });
      assert.equal(
        await syncSocialPostInsights(db.pool, "org", null, 10, options),
        0,
      );
      assert.equal(calls, 1);
      assert.equal(
        await syncSocialPostInsights(db.pool, "foreign-org", null, 10, options),
        0,
      );
      assert.equal(calls, 1);
      await db.pool.query(
        'UPDATE "SocialPostInsightSyncState" SET "nextRetryAt"=NOW()-INTERVAL \'1 second\'',
      );
      failed = false;
      assert.equal(
        await syncSocialPostInsights(db.pool, "org", null, 10, options),
        1,
      );
      assert.equal(calls, 2);
      const success = (
        await db.pool.query(
          'SELECT status,retryable,"consecutiveFailures","lastErrorCode","nextRetryAt","lastSuccessAt" IS NOT NULL AS succeeded FROM "SocialPostInsightSyncState"',
        )
      ).rows[0];
      assert.deepEqual(success, {
        status: "SUCCESS",
        retryable: false,
        consecutiveFailures: 0,
        lastErrorCode: null,
        nextRetryAt: null,
        succeeded: true,
      });
      const likes = (
        await db.pool.query(
          'SELECT value::text,availability FROM "SocialPostInsightObservation" WHERE "metricKey"=\'likes\' ORDER BY "fetchedAt" DESC LIMIT 1',
        )
      ).rows[0];
      assert.equal(likes.value, "4");
    } finally {
      await db.close();
    }
  },
);
