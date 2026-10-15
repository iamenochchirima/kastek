import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomUUID } from "node:crypto";
import {
  getBatch,
  refreshActiveBatches,
} from "../src/capabilities/content-batch.js";
import type { RequestContext } from "../src/identity/request-context.js";
import { installPgTimestampParsers } from "../src/db.js";
const context = (orgId: string): RequestContext => ({
  principal: {
    kind: "direct_user",
    id: "user",
    subjectUserId: "user",
    clientId: null,
  },
  organizationId: orgId,
  userId: "user",
  clientId: null,
  installationId: null,
  effectiveGrants: new Set(),
  apiScopes: null,
  correlationId: null,
  causationId: null,
  idempotencyKey: "key",
});
test(
  "isolated batch refresh preserves partial outcomes, freezes unknown/blocked items and prevents cross-organization reads",
  { skip: !process.env.CORE_ACTIONS_TEST_DATABASE_URL },
  async () => {
    installPgTimestampParsers();
    const schema = `actions_test_${randomUUID().replaceAll("-", "")}`,
      url = process.env.CORE_ACTIONS_TEST_DATABASE_URL!,
      admin = new pg.Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({
      connectionString: url,
      options: `-c search_path=${schema} -c timezone=UTC`,
    });
    try {
      await pool.query(
        `CREATE TYPE "SocialPublishJobStatus" AS ENUM('PENDING','QUEUED','PROCESSING','PUBLISHED','FAILED','CANCELED');CREATE TYPE "SocialPostStatus" AS ENUM('DRAFT','PUBLISHED','PROCESSING','FAILED');CREATE TABLE "SocialPost"(id text PRIMARY KEY,"orgId" text,status "SocialPostStatus","updatedAt" timestamp DEFAULT NOW());CREATE TABLE "SocialPublishJob"(id text PRIMARY KEY,status "SocialPublishJobStatus",metadata jsonb,"errorMessage" text);CREATE TABLE "SocialChannelConnection"(id text PRIMARY KEY,"displayName" text,handle text);CREATE TABLE "SocialPublishBatch"(id text PRIMARY KEY,"postId" text,"orgId" text,status text,"snapshotHash" text,"targetCount" bigint DEFAULT 0,"publishedCount" bigint DEFAULT 0,"processingCount" bigint DEFAULT 0,"unknownCount" bigint DEFAULT 0,"failedCount" bigint DEFAULT 0,"blockedCount" bigint DEFAULT 0,"errorCode" text,"errorMessage" text,"completedAt" timestamp,"createdAt" timestamp DEFAULT NOW(),"updatedAt" timestamp DEFAULT NOW());CREATE TABLE "SocialPublishBatchItem"(id text PRIMARY KEY,"batchId" text,"jobId" text,platform text,"channelConnectionId" text,status text,retryable boolean,"errorCode" text,"errorMessage" text,metadata jsonb,"createdAt" timestamp DEFAULT NOW(),"updatedAt" timestamp DEFAULT NOW());INSERT INTO "SocialPost"(id,"orgId",status)VALUES('post','org','DRAFT');INSERT INTO "SocialPublishBatch"(id,"postId","orgId",status,"snapshotHash")VALUES('batch','post','org','PROCESSING','hash');INSERT INTO "SocialPublishJob"VALUES('one','PUBLISHED','{}',NULL),('two','FAILED','{}','Unauthorized'),('three','FAILED','{"_kasitek_outcome":"UNKNOWN"}','timeout'),('four','PUBLISHED','{}',NULL);INSERT INTO "SocialPublishBatchItem"(id,"batchId","jobId",platform,status,retryable,metadata)VALUES('one','batch','one','X','QUEUED',false,'{}'),('two','batch','two','FACEBOOK','QUEUED',false,'{}'),('three','batch','three','THREADS','QUEUED',false,'{}'),('four','batch','four','LINKEDIN','BLOCKED',false,'{}');`,
      );
      await assert.rejects(
        getBatch(pool, context("other-org"), "batch"),
        /Publish batch not found/,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT status FROM "SocialPublishBatchItem" WHERE id=$1',
            ["one"],
          )
        ).rows[0].status,
        "QUEUED",
      );
      const batch = await getBatch(pool, context("org"), "batch");
      assert.equal(batch.status, "UNKNOWN");
      assert.equal(batch.publishedCount, 1);
      assert.equal(batch.failedCount, 1);
      assert.equal(batch.blockedCount, 1);
      assert.equal(batch.unknownCount, 1);
      const targets = batch.targets;
      assert.equal(
        targets.find((t: any) => t.platform === "FACEBOOK").remediationMode,
        "RECONNECT",
      );
      assert.equal(
        targets.find((t: any) => t.platform === "THREADS").remediationMode,
        "RECONCILE",
      );
      await pool.query(
        `UPDATE "SocialPublishJob" SET status='PUBLISHED',metadata='{}' WHERE id='three'`,
      );
      const second = await getBatch(pool, context("org"), "batch");
      assert.equal(second.status, "UNKNOWN");
      assert.equal(second.unknownCount, 1);
      assert.equal(await refreshActiveBatches(pool, 0), 1);
      await pool.query(
        `UPDATE "SocialPublishBatchItem" SET status='FAILED' WHERE id='three'`,
      );
      const terminal = await getBatch(pool, context("org"), "batch");
      assert.equal(terminal.status, "PARTIAL");
      assert.equal(terminal.publishedCount, 2);
      assert.ok(terminal.completedAt instanceof Date);
      assert.equal(
        (
          await pool.query('SELECT status FROM "SocialPost" WHERE id=$1', [
            "post",
          ])
        ).rows[0].status,
        "PROCESSING",
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
