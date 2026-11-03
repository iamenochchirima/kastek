import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import {
  getLibraryMedia,
  listLibraryMedia,
  updateLibraryMedia,
  setLibraryMediaArchived,
  getLibraryMediaUsage,
} from "../src/services/social/media-library.js";
test(
  "retained library: stable pages, workspace isolation, optimistic concurrency and durable replay",
  { skip: !process.env.CORE_SOCIAL_TEST_DATABASE_URL },
  async () => {
    const schema = `media_library_${randomUUID().replaceAll("-", "")}`;
    const admin = new pg.Pool({
      connectionString: process.env.CORE_SOCIAL_TEST_DATABASE_URL,
    });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({
      connectionString: process.env.CORE_SOCIAL_TEST_DATABASE_URL,
      options: `-c search_path=${schema} -c timezone=UTC`,
    });
    try {
      await pool.query(`CREATE TABLE "ContentMediaAsset"(id text PRIMARY KEY,"orgId" text,kind text,"mimeType" text,"fileName" text,"byteSize" bigint,checksum text,width int,height int,"durationMs" int,"processingStatus" text,"scanStatus" text,"storageKey" text,"createdAt" timestamp,"updatedAt" timestamp);
   CREATE TABLE "SocialPost"(id text PRIMARY KEY,"orgId" text,title text,status text,channels text[]);
   CREATE TABLE "SocialPostMedia"(id text PRIMARY KEY,"postId" text,"assetId" text);
   CREATE TABLE "ContentTemplate"(id text PRIMARY KEY,"orgId" text,name text,"archivedAt" timestamp);
   CREATE TABLE "ContentTemplateMedia"("templateId" text,"assetId" text);
   INSERT INTO "ContentMediaAsset" VALUES('old','a','IMAGE','image/png','old.png',123,'checksum',100,100,NULL,'READY','CLEAN','private/old','2026-11-03T10:00:00.123456','2026-11-03T10:00:00.123456');`);
      const migration = await readFile(
        new URL(
          "../sql/20261103110000_content_media_library.sql",
          import.meta.url,
        ),
        "utf8",
      );
      await pool.query(migration);
      await pool.query(migration);
      const original = await getLibraryMedia(pool, "a", "old");
      assert.equal(original.revision, 1);
      assert.deepEqual(original.tags, []);
      assert.equal(original.byteSize, 123);
      assert.equal("storageKey" in original, false);
      // Legacy upload columns remain valid; no existing object identity changes.
      await pool.query(`INSERT INTO "ContentMediaAsset"(id,"orgId",kind,"mimeType","fileName","byteSize","processingStatus","scanStatus","createdAt","updatedAt") VALUES
   ('new','a','VIDEO','video/mp4','new.mp4',1,'READY','CLEAN','2026-11-03T10:01:00.123456',now()),
   ('foreign','b','IMAGE','image/png','foreign.png',1,'READY','CLEAN',now(),now()),
   ('audio','a','AUDIO','audio/ogg','audio.ogg',1,'READY','CLEAN',now(),now());`);
      await assert.rejects(getLibraryMedia(pool, "b", "old"), /not found/);
      await assert.rejects(getLibraryMedia(pool, "a", "audio"), /not found/);
      const first = await listLibraryMedia(pool, "a", { limit: 1 });
      assert.equal(first.assets[0]?.id, "new");
      assert.ok(first.pagination.nextCursor);
      await pool.query(
        `INSERT INTO "ContentMediaAsset"(id,"orgId",kind,"createdAt","updatedAt") VALUES('newest','a','IMAGE',now(),now())`,
      );
      assert.deepEqual(
        (
          await listLibraryMedia(pool, "a", {
            limit: 1,
            cursor: first.pagination.nextCursor!,
          })
        ).assets.map((a) => a.id),
        ["old"],
      );
      await assert.rejects(
        listLibraryMedia(pool, "b", { cursor: first.pagination.nextCursor! }),
        /Cursor/,
      );
      await assert.rejects(
        listLibraryMedia(pool, "a", {
          cursor: first.pagination.nextCursor!,
          search: "changed",
        }),
        /Cursor/,
      );
      const edit = {
        expectedRevision: 1,
        displayName: " Launch image ",
        tags: ["Launch", "launch"],
        defaultAltText: "Building at sunrise",
      };
      const edited = await updateLibraryMedia(pool, "a", "old", edit, {
        operationKey: "update-1",
      });
      assert.equal(edited.displayName, "Launch image");
      assert.deepEqual(edited.tags, ["launch"]);
      assert.equal(
        (
          await listLibraryMedia(pool, "a", {
            search: "launch",
            tags: ["LAUNCH"],
          })
        ).assets.length,
        1,
      );
      const attempts = await Promise.allSettled([
        updateLibraryMedia(pool, "a", "old", {
          expectedRevision: 2,
          displayName: "A",
        }),
        updateLibraryMedia(pool, "a", "old", {
          expectedRevision: 2,
          displayName: "B",
        }),
      ]);
      assert.equal(attempts.filter((a) => a.status === "fulfilled").length, 1);
      assert.equal(attempts.filter((a) => a.status === "rejected").length, 1);
      assert.equal(attempts.find((a) => a.status === "rejected")?.reason.code, "media_revision_conflict");
      assert.deepEqual(
        await updateLibraryMedia(pool, "a", "old", edit, {
          operationKey: "update-1",
        }),
        edited,
      );
      await assert.rejects(
        updateLibraryMedia(
          pool,
          "a",
          "old",
          { expectedRevision: 3, displayName: "other" },
          { operationKey: "update-1" },
        ),
        /different input/,
      );
      await pool.query(
        `INSERT INTO "SocialPost" VALUES('queued','a','Scheduled','SCHEDULED',ARRAY['FACEBOOK']),('foreign-post','b','Private','DRAFT',ARRAY['FACEBOOK']); INSERT INTO "SocialPostMedia" VALUES('one','queued','old'),('foreign-ref','foreign-post','old'); INSERT INTO "ContentTemplate" VALUES('template','a','Launch',NULL),('foreign-template','b','Private',NULL); INSERT INTO "ContentTemplateMedia" VALUES('template','old'),('foreign-template','old');`,
      );
      const archived = await setLibraryMediaArchived(
        pool,
        "a",
        "old",
        { expectedRevision: 3, archived: true },
        { operationKey: "archive-1" },
      );
      assert.ok(archived.archivedAt);
      assert.equal(
        (await listLibraryMedia(pool, "a", { search: "old" })).assets.length,
        0,
      );
      assert.equal(
        (await listLibraryMedia(pool, "a", { archived: true })).assets[0]?.id,
        "old",
      );
      const usage = await getLibraryMediaUsage(pool, "a", "old", { limit: 1 });
      assert.deepEqual(
        usage.usage.map((u) => u.id),
        ["queued"],
      );
      assert.ok(usage.pagination.nextCursor);
      assert.deepEqual(
        (
          await getLibraryMediaUsage(pool, "a", "old", {
            cursor: usage.pagination.nextCursor!,
          })
        ).usage.map((u) => u.id),
        ["template"],
      );
      assert.equal(
        (
          await setLibraryMediaArchived(pool, "a", "old", {
            expectedRevision: 4,
            archived: false,
          })
        ).archivedAt,
        null,
      );
      assert.deepEqual(
        await setLibraryMediaArchived(
          pool,
          "a",
          "old",
          { expectedRevision: 3, archived: true },
          { operationKey: "archive-1" },
        ),
        archived,
      );
      assert.equal((await getLibraryMedia(pool, "a", "old")).archivedAt, null);
      assert.deepEqual(
        (
          await pool.query(
            `SELECT "storageKey",checksum FROM "ContentMediaAsset" WHERE id='old'`,
          )
        ).rows,
        [{ storageKey: "private/old", checksum: "checksum" }],
      );
      assert.equal(
        (
          await pool.query(
            `SELECT count(*)::int AS count FROM "SocialPostMedia" WHERE "assetId"='old'`,
          )
        ).rows[0].count,
        2,
      );
      await assert.rejects(
        updateLibraryMedia(pool, "a", "old", {
          expectedRevision: 5,
          tags: ["x".repeat(51)],
        }),
        /invalid/,
      );
      await assert.rejects(
        updateLibraryMedia(pool, "a", "old", {
          expectedRevision: 5,
          displayName: "x".repeat(241),
        }),
        /invalid/,
      );
      await assert.rejects(
        listLibraryMedia(pool, "a", { limit: 101 }),
        /Limit/,
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);
