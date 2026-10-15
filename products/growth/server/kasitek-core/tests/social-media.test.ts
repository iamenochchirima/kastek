import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, unlink, readdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readConfig } from "../src/config.js";
import {
  uploadContentMediaBytes,
  getContentMediaPreview,
  readContentMediaBytes,
  deleteAudioContentMedia,
  downloadPublicContentMedia,
  publicMediaSignature,
} from "../src/services/social/media.js";
test(
  "isolated media storage validates source identity, signed read, readiness and audio deletion lifecycle",
  { skip: !process.env.CORE_SOCIAL_TEST_DATABASE_URL },
  async () => {
    const schema = `social_media_test_${randomUUID().replaceAll("-", "")}`;
    const admin = new pg.Pool({
      connectionString: process.env.CORE_SOCIAL_TEST_DATABASE_URL,
    });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({
      connectionString: process.env.CORE_SOCIAL_TEST_DATABASE_URL,
      options: `-c search_path=${schema} -c timezone=UTC`,
    });
    const directory = await mkdtemp(
      path.join(os.tmpdir(), "synthetic-social-media-"),
    );
    const config = readConfig({
      DATABASE_URL: process.env.CORE_SOCIAL_TEST_DATABASE_URL!,
      KASITEK_MEDIA_STORAGE_PATH: directory,
      SESSION_SECRET: "synthetic-secret",
    });
    try {
      await pool.query(
        `CREATE TYPE "ContentMediaKind" AS ENUM('IMAGE','VIDEO','AUDIO');CREATE TYPE "ContentMediaProcessingStatus" AS ENUM('READY','FAILED');CREATE TYPE "ContentMediaScanStatus" AS ENUM('CLEAN','PENDING');CREATE TABLE "ContentMediaAsset"(id text PRIMARY KEY,"orgId" text,"uploadedById" text,kind "ContentMediaKind","fileName" text,"mimeType" text,"byteSize" bigint,checksum text,width integer,height integer,"durationMs" integer,"storageKey" text,"previewStorageKey" text,"processingStatus" "ContentMediaProcessingStatus","scanStatus" "ContentMediaScanStatus",metadata jsonb,"createdAt" timestamp,"updatedAt" timestamp);CREATE TABLE "SocialPostMedia"(id text,"assetId" text);`,
      );
      const bytes = Buffer.from("OggS-synthetic-audio");
      const upload = {
        fileName: "../../my audio.ogg",
        mimeType: "audio/ogg",
        bytes,
        source: "synthetic-agent",
        sourceKey: "synthetic-source",
      };
      const asset = await uploadContentMediaBytes(
        pool,
        config,
        "user",
        "org",
        upload,
      );
      assert.equal(asset.kind, "AUDIO");
      assert.equal(asset.fileName, "my_audio.ogg");
      assert.equal(
        (await uploadContentMediaBytes(pool, config, "user", "org", upload)).id,
        asset.id,
      );
      assert.deepEqual(
        (await readContentMediaBytes(pool, config, "org", asset.id)).bytes,
        bytes,
      );
      await assert.rejects(
        readContentMediaBytes(pool, config, "foreign", asset.id),
        /Media asset not found/,
      );
      await assert.rejects(
        uploadContentMediaBytes(pool, config, "user", "org", {
          ...upload,
          bytes: Buffer.from("OggS-other"),
        }),
        /different media/,
      );
      await assert.rejects(
        uploadContentMediaBytes(pool, config, "user", "org", {
          ...upload,
          sourceKey: "invalid",
          bytes: Buffer.from("not-ogg"),
        }),
        /do not match/,
      );
      const [preview, url] = await getContentMediaPreview(
        pool,
        config,
        "org",
        asset.id,
      );
      assert.equal(preview.id, asset.id);
      assert.ok(url.includes(`/api/social/media/${asset.id}/public?expires=`));
      const expires = BigInt(Math.floor(Date.now() / 1000) + 900);
      assert.deepEqual(
        (
          await downloadPublicContentMedia(
            pool,
            config,
            asset.id,
            expires,
            publicMediaSignature(config, asset.id, expires),
          )
        ).bytes,
        bytes,
      );
      await assert.rejects(
        downloadPublicContentMedia(pool, config, asset.id, expires, "wrong"),
        /Unauthorized/,
      );
      await pool.query('INSERT INTO "SocialPostMedia" VALUES($1,$2)', [
        "synthetic-link",
        asset.id,
      ]);
      await assert.rejects(
        deleteAudioContentMedia(pool, config, "org", asset.id),
        /still attached/,
      );
      await pool.query('DELETE FROM "SocialPostMedia"');
      assert.equal(
        await deleteAudioContentMedia(pool, config, "org", asset.id),
        true,
      );
      assert.equal(
        await deleteAudioContentMedia(pool, config, "org", asset.id),
        false,
      );
      const image = await uploadContentMediaBytes(pool, config, "user", "org", {
        fileName: "image.png",
        mimeType: "image/png",
        bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]),
        source: "fixture",
      });
      await assert.rejects(
        deleteAudioContentMedia(pool, config, "org", image.id),
        /Only audio/,
      );
      const stored = (
        await pool.query(
          'SELECT "storageKey" FROM "ContentMediaAsset" WHERE id=$1',
          [image.id],
        )
      ).rows[0].storageKey;
      await unlink(path.join(directory, stored));
      await assert.rejects(
        getContentMediaPreview(pool, config, "org", image.id),
        /no longer available/,
      );
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
