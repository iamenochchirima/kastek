import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import type { CoreContext } from "../context.js";
import type { RequestContext } from "../identity/request-context.js";
import { requireOrigin } from "../identity/session.js";
import { ApiError } from "../error.js";
import { transaction } from "../db.js";
import { getContentMediaAsset, uploadContentMediaBytes } from "../services/social/media.js";
import { authorizeGrowthOperation } from "./policy.js";
import { validateGrowthOperationInput } from "./catalog.js";
import { resolveGrowthOperationContext } from "./transport.js";

export const MAX_GROWTH_MEDIA_TRANSFER_BYTES = 512 * 1024 * 1024;
export interface GrowthMediaTransfer {
  id: string; orgId: string; userId: string; principalId: string; principalKind: string; requestKey: string;
  fileName: string | null; mimeType: string; byteSize: string; expectedChecksum: string | null;
  checksum: string | null; storageKey: string | null; state: string; assetId: string | null; expiresAt: Date;
}
export interface PrepareGrowthMediaTransferInput { fileName?: string; mimeType: string; byteSize: number; sha256?: string }
const denied = () => new ApiError(404, "media_transfer_missing", "Media transfer not found");
const conflict = (message: string) => new ApiError(409, "media_transfer_conflict", message);
const actor = (context: RequestContext) => context.userId ?? context.principal.subjectUserId;
const root = (core: CoreContext) => resolve(core.config.mediaStoragePath, ".transfers");
function storagePath(core: CoreContext, key: string) {
  if (!/^[a-f0-9]{48}$/.test(key)) throw new ApiError(500, "media_transfer_storage_invalid", "Media transfer storage is unavailable");
  return join(root(core), key);
}
function ownerParameters(context: RequestContext, id: string) { return [id, context.organizationId, actor(context), context.principal.id, context.principal.kind]; }
const owned = 'id=$1 AND "orgId"=$2 AND "userId"=$3 AND "principalId"=$4 AND "principalKind"=$5';

export async function getGrowthMediaTransfer(core: CoreContext, context: RequestContext, id: string): Promise<GrowthMediaTransfer> {
  const row = (await core.pool.query<GrowthMediaTransfer>(`SELECT * FROM "GrowthMediaTransfer" WHERE ${owned}`, ownerParameters(context, id))).rows[0];
  if (!row) throw denied();
  if (+new Date(row.expiresAt) <= Date.now()) throw new ApiError(410, "media_transfer_expired", "Media transfer expired. Prepare a new transfer");
  return row;
}

/** Reclaims private staging files, without touching finalized ContentMediaAsset storage. */
export async function cleanupGrowthMediaTransfers(core: CoreContext): Promise<number> {
  const rows = (await core.pool.query<{ id: string; storageKey: string | null }>(`UPDATE "GrowthMediaTransfer" SET state=CASE WHEN state='FINALIZED' THEN state ELSE 'FAILED' END,"updatedAt"=now()
    WHERE id IN (SELECT id FROM "GrowthMediaTransfer" WHERE ("expiresAt"<=now() AND state IN ('PENDING','UPLOADING','READY')) OR (state='FINALIZED' AND "storageKey" IS NOT NULL) ORDER BY "expiresAt" LIMIT 100)
    RETURNING id,"storageKey"`)).rows;
  for (const row of rows) if (row.storageKey) {
    await rm(storagePath(core, row.storageKey), { force: true });
    await core.pool.query('UPDATE "GrowthMediaTransfer" SET "storageKey"=NULL WHERE id=$1 AND "storageKey"=$2', [row.id, row.storageKey]);
  }
  return rows.length;
}

export async function prepareGrowthMediaTransfer(core: CoreContext, context: RequestContext, input: PrepareGrowthMediaTransferInput) {
  await authorizeGrowthOperation(core, context, "content.media.transfer.prepare");
  validateGrowthOperationInput("content.media.transfer.prepare", input);
  await cleanupGrowthMediaTransfers(core);
  const row = await transaction(core.pool, async db => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`growth-media-transfer:${context.organizationId}:${context.principal.kind}:${context.principal.id}:${context.idempotencyKey}`]);
    const existing = (await db.query<GrowthMediaTransfer>('SELECT * FROM "GrowthMediaTransfer" WHERE "orgId"=$1 AND "principalKind"=$2 AND "principalId"=$3 AND "requestKey"=$4', [context.organizationId, context.principal.kind, context.principal.id, context.idempotencyKey])).rows[0];
    if (existing) {
      if (existing.userId !== actor(context) || existing.mimeType !== input.mimeType || Number(existing.byteSize) !== input.byteSize || existing.fileName !== (input.fileName ?? null) || existing.expectedChecksum !== (input.sha256 ?? null))
        throw conflict("This request identity belongs to a different media transfer");
      if (+new Date(existing.expiresAt) <= Date.now()) throw new ApiError(410, "media_transfer_expired", "Media transfer expired. Use a new request identity");
      return existing;
    }
    return (await db.query<GrowthMediaTransfer>(`INSERT INTO "GrowthMediaTransfer"(id,"orgId","userId","principalId","principalKind","requestKey","fileName","mimeType","byteSize","expectedChecksum","expiresAt")
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now()+interval '15 minutes') RETURNING *`,
    [randomUUID(), context.organizationId, actor(context), context.principal.id, context.principal.kind, context.idempotencyKey, input.fileName ?? null, input.mimeType, input.byteSize, input.sha256 ?? null])).rows[0]!;
  });
  return { transferId: row.id, uploadUrl: `${core.config.publicApiUrl}/v1/media-transfers/${row.id}`, uploadMethod: "PUT", contentType: "application/octet-stream", byteSize: Number(row.byteSize), expiresAt: new Date(row.expiresAt).toISOString(), state: row.state, requiresAuthentication: true };
}

/** The internal adapter can pass the same owned context and stream without a public HTTP round trip. */
export async function uploadGrowthMediaTransfer(core: CoreContext, context: RequestContext, id: string, stream: Readable) {
  await authorizeGrowthOperation(core, context, "content.media.transfer.prepare");
  const initial = await getGrowthMediaTransfer(core, context, id);
  if (initial.state !== "PENDING") throw conflict("This transfer is not awaiting an upload");
  const key = randomBytes(24).toString("hex"), filename = storagePath(core, key);
  const claimed = await core.pool.query(`UPDATE "GrowthMediaTransfer" SET state='UPLOADING',"storageKey"=$6,"updatedAt"=now() WHERE ${owned} AND state='PENDING' AND "expiresAt">now()`, [...ownerParameters(context, id), key]);
  if (!claimed.rowCount) throw conflict("This transfer is already being uploaded or expired");
  let length = 0;
  const hash = createHash("sha256");
  try {
    await mkdir(root(core), { recursive: true, mode: 0o700 });
    const bounded = new Transform({ transform(chunk: Buffer, _encoding, callback) {
      length += chunk.length;
      if (length > Number(initial.byteSize) || length > MAX_GROWTH_MEDIA_TRANSFER_BYTES) return callback(new ApiError(413, "media_transfer_too_large", "Media exceeds the declared transfer size"));
      hash.update(chunk); callback(null, chunk);
    } });
    await pipeline(stream, bounded, createWriteStream(filename, { flags: "wx", mode: 0o600 }));
    const checksum = hash.digest("hex");
    if (length !== Number(initial.byteSize)) throw new ApiError(422, "media_transfer_size_mismatch", "Media size does not match the transfer");
    if (initial.expectedChecksum && initial.expectedChecksum !== checksum) throw new ApiError(422, "media_transfer_hash_mismatch", "Media checksum does not match the transfer");
    const ready = await core.pool.query(`UPDATE "GrowthMediaTransfer" SET state='READY',checksum=$6,"updatedAt"=now() WHERE ${owned} AND state='UPLOADING' AND "expiresAt">now()`, [...ownerParameters(context, id), checksum]);
    if (!ready.rowCount) throw new ApiError(410, "media_transfer_expired", "Media transfer expired during upload");
    return { transferId: id, state: "READY", byteSize: length, sha256: checksum };
  } catch (error) {
    await rm(filename, { force: true });
    await core.pool.query(`UPDATE "GrowthMediaTransfer" SET state='FAILED',"updatedAt"=now() WHERE ${owned} AND state='UPLOADING'`, ownerParameters(context, id));
    throw error;
  }
}

export async function finalizeGrowthMediaTransfer(core: CoreContext, context: RequestContext, id: string) {
  await authorizeGrowthOperation(core, context, "content.media.upload");
  const result = await transaction(core.pool, async db => {
    const row = (await db.query<GrowthMediaTransfer>(`SELECT * FROM "GrowthMediaTransfer" WHERE ${owned} FOR UPDATE`, ownerParameters(context, id))).rows[0];
    if (!row) throw denied();
    if (+new Date(row.expiresAt) <= Date.now()) throw new ApiError(410, "media_transfer_expired", "Media transfer expired. Prepare a new transfer");
    if (row.state === "FINALIZED" && row.assetId) return { asset: await getContentMediaAsset(core.pool, context.organizationId, row.assetId), transferId: id };
    if (row.state !== "READY" || !row.storageKey || !row.checksum) throw conflict("Upload must finish before the media can be reviewed and saved");
    const bytes = await readFile(storagePath(core, row.storageKey));
    if (bytes.length !== Number(row.byteSize) || bytes.length > MAX_GROWTH_MEDIA_TRANSFER_BYTES || createHash("sha256").update(bytes).digest("hex") !== row.checksum)
      throw conflict("Uploaded media changed. Prepare a new transfer");
    const asset = await uploadContentMediaBytes(core.pool, core.config, row.userId, row.orgId, { fileName: row.fileName, mimeType: row.mimeType, bytes, source: "growth-media-transfer", sourceKey: `growth-transfer:${row.id}` });
    await db.query('UPDATE "GrowthMediaTransfer" SET state=\'FINALIZED\',"assetId"=$2,"updatedAt"=now() WHERE id=$1', [id, asset.id]);
    return { asset, transferId: id };
  });
  await cleanupGrowthMediaTransfers(core);
  return result;
}

export function registerGrowthMediaTransferRoutes(app: FastifyInstance, core: CoreContext) {
  app.post("/v1/media-transfers", { bodyLimit: 8192 }, async request => {
    const context = await resolveGrowthOperationContext(core, request);
    if (context.principal.kind === "direct_user") requireOrigin(request, core);
    return prepareGrowthMediaTransfer(core, context, request.body as PrepareGrowthMediaTransferInput);
  });
  void app.register(async routes => {
    routes.addContentTypeParser("application/octet-stream", (_request, payload, done) => done(null, payload));
    routes.put("/v1/media-transfers/:id", { bodyLimit: MAX_GROWTH_MEDIA_TRANSFER_BYTES }, async request => {
      const context = await resolveGrowthOperationContext(core, request);
      if (context.principal.kind === "direct_user") requireOrigin(request, core);
      // Upload is transport continuation of an existing grant, not a second business mutation identity.
      context.idempotencyKey ??= `upload:${(request.params as { id: string }).id}`;
      return uploadGrowthMediaTransfer(core, context, (request.params as { id: string }).id, request.body as Readable);
    });
  });
}
