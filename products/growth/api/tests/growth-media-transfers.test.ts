import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import pg from "pg";
import { readConfig } from "../src/config.js";
import { buildApp } from "../src/app.js";
import { getGrowthMediaTransfer, prepareGrowthMediaTransfer, uploadGrowthMediaTransfer, finalizeGrowthMediaTransfer, registerGrowthMediaTransferRoutes, cleanupGrowthMediaTransfers } from "../src/operations/media-transfers.js";
import { validateGrowthOperationInput } from "../src/operations/catalog.js";
import type { RequestContext } from "../src/identity/request-context.js";

test("canonical media ingestion requires exactly one bounded source", () => {
  validateGrowthOperationInput("content.media.upload", { transferId: "owned-transfer" });
  validateGrowthOperationInput("content.media.upload", { mimeType: "image/png", base64: "YWJj" });
  for (const input of [{}, { transferId: "one", base64: "YWJj", mimeType: "image/png" }, { transferId: "one", mimeType: "image/png" }])
    assert.throws(() => validateGrowthOperationInput("content.media.upload", input));
  assert.throws(() => validateGrowthOperationInput("content.media.transfer.prepare", { mimeType: "video/mp4", byteSize: 536870913 }));
  assert.throws(() => validateGrowthOperationInput("content.media.transfer.prepare", { mimeType: "image/png", byteSize: 1, sha256: "not-a-checksum" }));
});

const database = process.env.CORE_OPERATIONS_TEST_DATABASE_URL;
test("scoped streaming transfers retain no content asset until reviewed finalization and enforce ownership, size, hash and expiry", { skip: !database, timeout: 30000 }, async () => {
  const schema = `growth_media_transfer_${randomBytes(12).toString("hex")}`, directory = await mkdtemp(join(tmpdir(), "growth-transfer-"));
  const admin = new pg.Pool({ connectionString: database });
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const pool = new pg.Pool({ connectionString: database, options: `-c search_path=${schema} -c timezone=UTC` });
  const secret = `kst_${"a".repeat(48)}`;
  const ctx = (key: string): RequestContext => ({ principal: { kind: "workspace_api_key", id: "key", subjectUserId: "user", clientId: "key" }, organizationId: "org", userId: "user", clientId: "key", effectiveGrants: new Set(), apiScopes: new Set(["growth:read", "growth:draft"]), correlationId: null, causationId: null, idempotencyKey: key });
  const config = readConfig({ DATABASE_URL: database, ENVIRONMENT: "test", KASITEK_MEDIA_STORAGE_PATH: directory, KASITEK_CORE_PUBLIC_URL: "http://localhost:4000", FRONTEND_URL: "http://localhost:3002" }), core = { pool, config };
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    await pool.query(`CREATE TABLE "OrganizationMember"("orgId" text,"userId" text,role text);
      INSERT INTO "OrganizationMember" VALUES('org','user','OWNER'),('other','user','OWNER');
      CREATE TABLE "DeveloperApiKey"(id text,"orgId" text,"createdById" text,scopes text[],status text,"expiresAt" timestamptz,"keyHash" text,"lastUsedAt" timestamptz,"updatedAt" timestamptz DEFAULT now());
      CREATE TYPE "ContentMediaKind" AS ENUM('IMAGE','VIDEO','AUDIO'); CREATE TYPE "ContentMediaProcessingStatus" AS ENUM('READY','PENDING','FAILED'); CREATE TYPE "ContentMediaScanStatus" AS ENUM('CLEAN','PENDING','FAILED');
      CREATE TABLE "ContentMediaAsset"(id text PRIMARY KEY,"orgId" text,"uploadedById" text,kind "ContentMediaKind","fileName" text,"mimeType" text,"byteSize" bigint,checksum text,width int,height int,"durationMs" int,"storageKey" text,"processingStatus" "ContentMediaProcessingStatus","scanStatus" "ContentMediaScanStatus",metadata jsonb,"createdAt" timestamptz,"updatedAt" timestamptz);`);
    await pool.query(`INSERT INTO "DeveloperApiKey"(id,"orgId","createdById",scopes,status,"keyHash") VALUES('key','org','user',ARRAY['growth:read','growth:draft'],'ACTIVE',$1)`, [createHash("sha256").update(secret).digest("hex")]);
    await pool.query(await readFile(new URL("../sql/20261101150000_growth_media_transfers.sql", import.meta.url), "utf8"));
    app = await buildApp(core, [registerGrowthMediaTransferRoutes]); await app.ready();
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZ1EAAAAASUVORK5CYII=", "base64");
    const hash = createHash("sha256").update(png).digest("hex");
    const transfer = await prepareGrowthMediaTransfer(core, ctx("prepare-transfer-1"), { fileName: "photo.png", mimeType: "image/png", byteSize: png.length, sha256: hash });
    assert.equal((await prepareGrowthMediaTransfer(core, ctx("prepare-transfer-1"), { fileName: "photo.png", mimeType: "image/png", byteSize: png.length, sha256: hash })).transferId, transfer.transferId);
    await assert.rejects(prepareGrowthMediaTransfer(core, ctx("prepare-transfer-1"), { fileName: "different.png", mimeType: "image/png", byteSize: png.length, sha256: hash }), /different media transfer/);
    await assert.rejects(finalizeGrowthMediaTransfer(core, ctx("finalize-transfer-1"), transfer.transferId), /Upload must finish/);
    const upload = await app.inject({ method: "PUT", url: `/v1/media-transfers/${transfer.transferId}`, headers: { authorization: `Bearer ${secret}`, "content-type": "application/octet-stream" }, payload: png });
    assert.equal(upload.statusCode, 200, upload.body);
    assert.equal(upload.json().sha256, hash);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM "ContentMediaAsset"')).rows[0].count, 0);
    const row = await getGrowthMediaTransfer(core, ctx("read-transfer-1"), transfer.transferId);
    assert.equal(row.state, "READY");
    await assert.rejects(getGrowthMediaTransfer(core, { ...ctx("foreign-read-1"), organizationId: "other" }, transfer.transferId), /not found/);
    await assert.rejects(getGrowthMediaTransfer(core, { ...ctx("foreign-read-2"), principal: { ...ctx("x").principal, id: "other-key" } }, transfer.transferId), /not found/);
    const saved = await finalizeGrowthMediaTransfer(core, ctx("finalize-transfer-1"), transfer.transferId);
    assert.equal(saved.asset.mimeType, "image/png");
    assert.equal((await finalizeGrowthMediaTransfer(core, ctx("finalize-transfer-1"), transfer.transferId)).asset.id, saved.asset.id);
    assert.equal((await pool.query('SELECT count(*)::int AS count FROM "ContentMediaAsset"')).rows[0].count, 1);
    // Exercise the staged path above the canonical inline base64 limit.
    const larger = Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]);
    const largeTransfer = await prepareGrowthMediaTransfer(core, ctx("large-streamed-transfer"), { mimeType: "image/png", byteSize: larger.length });
    const chunks = [larger.subarray(0, 1024 * 1024), larger.subarray(1024 * 1024)];
    await uploadGrowthMediaTransfer(core, ctx("large-streamed-upload"), largeTransfer.transferId, Readable.from(chunks));
    assert.equal(Number((await finalizeGrowthMediaTransfer(core, ctx("large-streamed-save"), largeTransfer.transferId)).asset.byteSize), larger.length);

    const bad = await prepareGrowthMediaTransfer(core, ctx("wrong-hash-transfer"), { mimeType: "image/png", byteSize: png.length, sha256: "0".repeat(64) });
    await assert.rejects(uploadGrowthMediaTransfer(core, ctx("upload-bad-hash"), bad.transferId, Readable.from([png])), /checksum does not match/);
    assert.equal((await getGrowthMediaTransfer(core, ctx("read-bad-hash"), bad.transferId)).state, "FAILED");
    const short = await prepareGrowthMediaTransfer(core, ctx("short-transfer"), { mimeType: "image/png", byteSize: png.length });
    await assert.rejects(uploadGrowthMediaTransfer(core, ctx("upload-short"), short.transferId, Readable.from([png.subarray(0, 8)])), /size does not match/);
    const large = await prepareGrowthMediaTransfer(core, ctx("over-limit-transfer"), { mimeType: "image/png", byteSize: 8 });
    await assert.rejects(uploadGrowthMediaTransfer(core, ctx("upload-over-limit"), large.transferId, Readable.from([png])), /exceeds the declared/);
    const expired = await prepareGrowthMediaTransfer(core, ctx("expired-transfer"), { mimeType: "image/png", byteSize: png.length });
    await pool.query('UPDATE "GrowthMediaTransfer" SET "expiresAt"=now()-interval \'1 second\' WHERE id=$1', [expired.transferId]);
    await assert.rejects(getGrowthMediaTransfer(core, ctx("read-expired"), expired.transferId), /expired/);
    assert.ok(await cleanupGrowthMediaTransfers(core) >= 1);
    assert.equal((await pool.query('SELECT state FROM "GrowthMediaTransfer" WHERE id=$1', [expired.transferId])).rows[0].state, "FAILED");
  } finally {
    await app?.close(); await pool.end(); await admin.query(`DROP SCHEMA "${schema}" CASCADE`); await admin.end(); await rm(directory, { recursive: true, force: true });
  }
});
