import { createHash } from "node:crypto";
import { canonicalJson } from "@kasitek-labs/server-support/json";
import type { CoreContext } from "../context.js";
import type { OperationReviewRow } from "./reviews.js";
import type { RequestContext } from "../identity/request-context.js";
import { reconcilePublishedFacebookEdit } from "../capabilities/content-published-edit.js";

/** Domain keys are derived from the persisted review, never supplied by a transport. */
export const operationDomainKey = (reviewId: string): string => `growth-operation:${reviewId}`;
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

/** Inspect receipts and provider readback only. Missing evidence never causes another external write. */
export async function reconcileGrowthOperationReceipt(core: CoreContext, review: OperationReviewRow, context?: RequestContext): Promise<Record<string, unknown> | null> {
  if (!["executing", "uncertain"].includes(review.state)) return null;
  const key = operationDomainKey(review.id), input = review.input;
  switch (review.operation) {
    case "content.posts.draft.create":
    case "content.templates.instantiate":
    case "content.posts.duplicate": {
      const rows = (await core.pool.query(`SELECT id,metadata->>'_kasitek_agent_request_digest' AS digest FROM "SocialPost"
        WHERE "orgId"=$1 AND "userId"=$2 AND metadata->>'_kasitek_agent_idempotency_key'=$3 LIMIT 2`, [review.orgId, review.userId, key])).rows;
      if (rows.length !== 1 || !/^[a-f0-9]{64}$/.test(rows[0].digest ?? "")) return null;
      return { reconciled: true, postId: rows[0].id, receipt: "draft_created" };
    }
    case "content.media.update":
    case "content.media.archive":
    case "content.media.restore": {
      const receipt = (await core.pool.query('SELECT action,result FROM "ContentMediaLibraryMutation" WHERE "orgId"=$1 AND "operationKey"=$2 AND "assetId"=$3', [review.orgId,key,input.assetId])).rows[0];
      return receipt?.action === review.operation ? {asset: receipt.result} : null;
    }
    case "content.templates.create":
    case "content.templates.update":
    case "content.templates.archive":
    case "content.templates.restore": {
      const receipt = (await core.pool.query('SELECT action,result FROM "ContentTemplateMutation" WHERE "orgId"=$1 AND "operationKey"=$2', [review.orgId,key])).rows[0];
      return receipt?.action === review.operation.split(".").at(-1) ? {template: receipt.result} : null;
    }
    case "content.media.transfer.prepare": {
      const rows=(await core.pool.query(`SELECT id,"fileName","mimeType","byteSize","expectedChecksum","expiresAt",state FROM "GrowthMediaTransfer" WHERE "orgId"=$1 AND "userId"=$2 AND "principalId"=$3 AND "principalKind"=$4 AND "requestKey"=$5 LIMIT 2`,[review.orgId,review.userId,review.principalId,review.principalKind,key])).rows;
      if(rows.length!==1) return null;
      const row=rows[0];
      if(row.fileName!==(input.fileName??null)||row.mimeType!==input.mimeType||Number(row.byteSize)!==input.byteSize||row.expectedChecksum!==(input.sha256??null)) return null;
      return {reconciled:true,transferId:row.id,uploadUrl:`${core.config.publicApiUrl}/v1/media-transfers/${row.id}`,uploadMethod:"PUT",contentType:"application/octet-stream",byteSize:Number(row.byteSize),expiresAt:new Date(row.expiresAt).toISOString(),state:+new Date(row.expiresAt)<=Date.now()?"EXPIRED":row.state,requiresAuthentication:true,receipt:"media_transfer_prepared"};
    }
    case "content.media.upload": {
      if (typeof input.transferId === "string") {
        const transfer = (await core.pool.query(`SELECT state,"assetId",checksum,"byteSize" FROM "GrowthMediaTransfer" WHERE id=$1 AND "orgId"=$2 AND "userId"=$3 AND "principalId"=$4 AND "principalKind"=$5`, [input.transferId, review.orgId, review.userId, review.principalId, review.principalKind])).rows[0];
        if (!transfer || !["READY", "FINALIZED"].includes(transfer.state) || hash({ checksum: transfer.checksum, byteSize: transfer.byteSize, state: "READY" }) !== review.snapshot.transfer) return null;
        const assets = (await core.pool.query(`SELECT id FROM "ContentMediaAsset" WHERE ($1::text IS NULL OR id=$1) AND "orgId"=$2 AND "uploadedById"=$3 AND checksum=$4 AND "byteSize"=$5 AND metadata->>'sourceKey'=$6 LIMIT 2`, [transfer.assetId, review.orgId, review.userId, transfer.checksum, transfer.byteSize, `growth-transfer:${input.transferId}`])).rows;
        return assets.length === 1 ? { reconciled: true, assetId: assets[0]!.id, transferId: input.transferId, receipt: transfer.state === "FINALIZED" ? "media_finalized" : "media_asset_persisted", transferState: transfer.state } : null;
      }
      if (typeof input.base64 !== "string" || typeof input.mimeType !== "string") return null;
      const bytes = Buffer.from(input.base64, "base64"), checksum = createHash("sha256").update(bytes).digest("hex");
      const rows = (await core.pool.query(`SELECT id FROM "ContentMediaAsset" WHERE "orgId"=$1 AND "uploadedById"=$2 AND metadata->>'sourceKey'=$3 AND checksum=$4 AND "byteSize"=$5 AND "mimeType"=$6 LIMIT 2`, [review.orgId, review.userId, key, checksum, bytes.length, input.mimeType.trim().toLowerCase()])).rows;
      return rows.length === 1 ? { reconciled: true, assetId: rows[0].id, receipt: "media_created" } : null;
    }
    case "content.posts.publish":
    case "content.posts.publish_batch": {
      const rows = (await core.pool.query(`SELECT id,status,"postId","snapshotHash",metadata FROM "SocialPublishBatch" WHERE "orgId"=$1 AND "postId"=$2 AND "idempotencyKey"=$3 LIMIT 2`, [review.orgId, input.postId, key])).rows;
      const batch = rows[0];
      if (rows.length !== 1 || batch.snapshotHash !== review.snapshot.snapshotHash || (batch.metadata?.requestedPlatform ?? null) !== (input.platform ?? null)) return null;
      return { reconciled: true, postId: batch.postId, batchId: batch.id, status: batch.status, receipt: "publication_admitted" };
    }
    case "content.posts.delete_published": {
      const rows = (await core.pool.query(`SELECT id,platform::text,"externalPostId",metadata->'_kasitek_delete_intent' AS intent FROM "SocialPublishJob" WHERE "orgId"=$1 AND "postId"=$2 AND platform::text=$3 AND metadata->'_kasitek_delete_intent'->>'idempotencyKey'=$4`, [review.orgId, input.postId, input.platform, key])).rows;
      if (!rows.length || rows.some(row => row.intent?.actorId !== review.principalId || row.intent.externalPostId !== row.externalPostId || !["confirmed", "failed"].includes(row.intent.state))) return null;
      return { reconciled: true, postId: input.postId, success: rows.every(row => row.intent.state === "confirmed"), localDeleted: false,
        providerResults: rows.map(row => ({ platform: row.platform, externalPostId: row.intent.externalPostId, status: row.intent.state === "confirmed" ? "DELETED" : "FAILED", message: row.intent.message ?? null })), receipt: "provider_deletion_completed" };
    }
    case "content.posts.update_published": {
      const receiptRows = async () => (await core.pool.query(`SELECT id,"externalPostId",metadata->'_kasitek_edit_intent' AS intent FROM "SocialPublishJob"
        WHERE "orgId"=$1 AND "postId"=$2 AND platform::text='FACEBOOK' AND metadata->'_kasitek_edit_intent'->>'idempotencyKey'=$3`, [review.orgId, input.postId, key])).rows;
      let rows = await receiptRows();
      if (rows.length !== 1) return null;
      let row = rows[0], intent = row.intent;
      if (!intent || intent.actorId !== review.principalId || intent.externalPostId !== row.externalPostId
        || intent.contentDigest !== createHash("sha256").update(String(input.content).trim()).digest("hex")
        || Boolean(intent.removePhoto) !== Boolean(input.removePhoto)
        || intent.expectedUpdatedAt !== input.expectedUpdatedAt) return null;
      if (context && ["executing", "uncertain"].includes(intent.state) && typeof review.snapshot.postAgentRevision === "string") {
        try {
          await reconcilePublishedFacebookEdit(core.pool, core.config, { ...context, idempotencyKey: key }, String(input.postId), {
            content: String(input.content), expectedUpdatedAt: String(input.expectedUpdatedAt), removePhoto: input.removePhoto === true,
          }, { expectedPostAgentRevision: review.snapshot.postAgentRevision });
          rows = await receiptRows();
          if (rows.length !== 1) return null;
          row = rows[0]; intent = row.intent;
        } catch { return null; }
      }
      if (intent?.state !== "confirmed") return null;
      return { reconciled: true, postId: input.postId, externalPostId: row.externalPostId, receipt: "provider_post_updated" };
    }
    default: return null;
  }
}
