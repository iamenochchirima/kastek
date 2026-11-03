import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { GrowthAgentContractError, parseGrowthDraftProposal, type GrowthDraftProposal, type GrowthDraftReceipt, type GrowthDraftReview, type GrowthAgentAction, type GrowthAgentFeatureId, type GrowthAgentContext } from "@kasitek-labs/contracts";
import type { CoreContext } from "../context.js";
import { transaction } from "../db.js";
import { ApiError } from "../error.js";
import { createSocialPostIdempotent } from "../services/social/posts.js";
import type { SocialPost } from "../services/social/types.js";
import { authorizeGrowthAgentScope, assertGrowthAgentContext, type GrowthAgentScope } from "./scope.js";
import { growthAgentDigest } from "./security.js";
import { enqueueGrowthAgentDraftSaved, enqueueGrowthAgentReview } from "./analytics.js";
type ReviewRow = {
  id: string; orgId: string; actorId: string; taskId: string; conversationId: string; featureId: GrowthAgentFeatureId;
  operationId: string; requestDigest: string; payloadDigest: string; draft: GrowthDraftProposal; context: GrowthAgentContext | null;
  contextRevision: string | null; destinationRevisions: Record<string, string>; rootReviewId: string; supersededBy: string | null;
  state: GrowthDraftReview["state"]; result: GrowthDraftReceipt | null; decisionRequestId: string | null; createdAt: Date; updatedAt: Date; expiresAt: Date;
};
const missing = () => new ApiError(404, "agent_review_missing", "Review is unavailable");
const conflict = (message: string) => new ApiError(409, "agent_review_conflict", message);
function dto(row: ReviewRow): GrowthDraftReview {
  return { id: row.id, taskId: row.taskId, conversationId: row.conversationId, featureId: row.featureId, kind: "content_draft",
    payloadDigest: row.payloadDigest, state: row.state === "proposed" && new Date(row.expiresAt).getTime() <= Date.now() ? "expired" : row.state,
    draft: row.draft, createdAt: new Date(row.createdAt).toISOString(), expiresAt: new Date(row.expiresAt).toISOString(), result: row.result };
}
export interface GrowthDraftPorts {
  create?: typeof createSocialPostIdempotent;
}
export class GrowthAgentReviewStore {
  constructor(private readonly core: CoreContext, private readonly ports: GrowthDraftPorts = {}) {}
  async destinations(scope: GrowthAgentScope) {
    await authorizeGrowthAgentScope(this.core, scope, "content");
    const rows = (await this.core.pool.query(`SELECT id,platform::text,"displayName",status::text FROM "SocialChannelConnection" WHERE "orgId"=$1 ORDER BY platform,"displayName",id`, [scope.tenantId])).rows;
    return rows.map(row => ({ id: row.id as string, platform: row.platform as string, label: row.displayName as string, ready: row.status === "CONNECTED" }));
  }
  private async destinationsRevision(scope: GrowthAgentScope, draft: GrowthDraftProposal, db: Pool | PoolClient, required: boolean): Promise<Record<string, string>> {
    if (required && (!draft.channels.length || draft.channels.some(platform => !draft.channelSelections[platform]))) throw new ApiError(422, "agent_destination_required", "Choose a connected account for each channel");
    const revisions: Record<string, string> = {};
    for (const platform of draft.channels) {
      const selected = draft.channelSelections[platform];
      if (!selected) continue;
      const row = (await db.query(`SELECT id,platform::text,status::text,"updatedAt","agentReviewRevision"::text AS "agentReviewRevision" FROM "SocialChannelConnection" WHERE "orgId"=$1 AND id=$2 FOR SHARE`, [scope.tenantId, selected])).rows[0];
      if (!row || row.platform !== platform || row.status !== "CONNECTED") throw new ApiError(422, "agent_destination_unavailable", "The selected publishing account is unavailable");
      revisions[selected] = growthAgentDigest({ id: row.id, platform: row.platform, updatedAt: new Date(row.updatedAt).toISOString(), status: row.status, agentReviewRevision: row.agentReviewRevision });
    }
    return revisions;
  }
  private async row(db: Pool | PoolClient, scope: GrowthAgentScope, reviewId: string, taskId?: string, lock = false): Promise<ReviewRow> {
    const row = (await db.query<ReviewRow>(`SELECT * FROM "GrowthAgentReview" WHERE id=$1 AND "orgId"=$2 AND "actorId"=$3${taskId ? ' AND "taskId"=$4' : ""}${lock ? " FOR UPDATE" : ""}`,
      [reviewId, scope.tenantId, scope.actor.subject, ...(taskId ? [taskId] : [])])).rows[0];
    if (!row) throw missing(); return row;
  }
  private async latest(db: Pool | PoolClient, scope: GrowthAgentScope, reviewId: string, taskId?: string, lock = false): Promise<ReviewRow> {
    let row = await this.row(db, scope, reviewId, taskId, lock), count = 0;
    while (row.supersededBy) { if (++count > 100) throw conflict("Review revision history is unavailable"); row = await this.row(db, scope, row.supersededBy, taskId, lock); }
    return row;
  }
  async list(scope: GrowthAgentScope, taskId: string): Promise<GrowthDraftReview[]> {
    await authorizeGrowthAgentScope(this.core, scope, "content");
    const rows = (await this.core.pool.query<ReviewRow>(`SELECT * FROM "GrowthAgentReview" WHERE "orgId"=$1 AND "actorId"=$2 AND "taskId"=$3 AND "supersededBy" IS NULL ORDER BY "createdAt",id LIMIT 100`, [scope.tenantId, scope.actor.subject, taskId])).rows;
    return rows.map(dto);
  }
  async prepare(action: GrowthAgentAction<"draft.prepare">): Promise<{ review: GrowthDraftReview }> {
    const scope = { tenantId: action.tenantId, actor: action.actor };
    let draft: GrowthDraftProposal;
    try { draft = parseGrowthDraftProposal(action.input.draft); }
    catch (error) {
      if (error instanceof GrowthAgentContractError) throw new ApiError(422, "agent_tool_arguments_invalid", "Check the draft fields and supported channels");
      throw error;
    }
    await authorizeGrowthAgentScope(this.core, scope, "content");
    await assertGrowthAgentContext(this.core, scope, action.context, action.contextRevision);
    const requestDigest = growthAgentDigest({ taskId: action.taskId, conversationId: action.conversationId, featureId: action.featureId, draft, context: action.context, contextRevision: action.contextRevision ?? null });
    return transaction(this.core.pool, async db => {
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`growth-agent-review:${scope.tenantId}:${scope.actor.subject}:${action.operationId}`]);
      const existing = (await db.query<ReviewRow>(`SELECT * FROM "GrowthAgentReview" WHERE "orgId"=$1 AND "actorId"=$2 AND "operationId"=$3 FOR UPDATE`, [scope.tenantId, scope.actor.subject, action.operationId])).rows[0];
      if (existing) {
        if (existing.requestDigest !== requestDigest) throw conflict("The operation identity was reused for a different proposal");
        return { review: dto(await this.latest(db, scope, existing.id, action.taskId)) };
      }
      const revisions = await this.destinationsRevision(scope, draft, db, false), id = randomUUID();
      const payloadDigest = growthAgentDigest({ draft, revisions, actor: action.actor, tenantId: action.tenantId, taskId: action.taskId,
        conversationId: action.conversationId, context: action.context, contextRevision: action.contextRevision ?? null });
      const row = (await db.query<ReviewRow>(`INSERT INTO "GrowthAgentReview" (id,"orgId","actorId","taskId","conversationId","featureId","operationId","requestDigest","payloadDigest",draft,context,"contextRevision","destinationRevisions","rootReviewId",state,"expiresAt")
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$1,'proposed',now()+interval '30 minutes') RETURNING *`,
      [id, scope.tenantId, scope.actor.subject, action.taskId, action.conversationId, action.featureId, action.operationId, requestDigest, payloadDigest, JSON.stringify(draft), JSON.stringify(action.context), action.contextRevision ?? null, JSON.stringify(revisions)])).rows[0]!;
      await enqueueGrowthAgentReview(db, row, "proposed");
      return { review: dto(row) };
    });
  }
  async revise(scope: GrowthAgentScope, taskId: string, reviewId: string, input: { requestId: string; payloadDigest: string; draft: GrowthDraftProposal }): Promise<{ review: GrowthDraftReview }> {
    const draft = parseGrowthDraftProposal(input.draft);
    await authorizeGrowthAgentScope(this.core, scope, "content");
    return transaction(this.core.pool, async db => {
      const old = await this.row(db, scope, reviewId, taskId, true);
      if (old.supersededBy) {
        const next = await this.row(db, scope, old.supersededBy, taskId);
        if (next.operationId === `edit:${input.requestId}` && growthAgentDigest(next.draft) === growthAgentDigest(draft)) return { review: dto(next) };
        throw conflict("This proposal was replaced. Review its current details");
      }
      if (old.payloadDigest !== input.payloadDigest || old.state !== "proposed" || new Date(old.expiresAt).getTime() <= Date.now()) throw conflict("This proposal can no longer be edited");
      await assertGrowthAgentContext(this.core, scope, old.context, old.contextRevision);
      const revisions = await this.destinationsRevision(scope, draft, db, false), id = randomUUID();
      const payloadDigest = growthAgentDigest({ draft, revisions, actor: scope.actor, tenantId: scope.tenantId, taskId, conversationId: old.conversationId,
        context: old.context, contextRevision: old.contextRevision });
      const row = (await db.query<ReviewRow>(`INSERT INTO "GrowthAgentReview" (id,"orgId","actorId","taskId","conversationId","featureId","operationId","requestDigest","payloadDigest",draft,context,"contextRevision","destinationRevisions","rootReviewId",state,"expiresAt")
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'proposed',$15) RETURNING *`,
      [id, scope.tenantId, scope.actor.subject, taskId, old.conversationId, old.featureId, `edit:${input.requestId}`, growthAgentDigest({ draft, previous: old.id }), payloadDigest,
        JSON.stringify(draft), JSON.stringify(old.context), old.contextRevision, JSON.stringify(revisions), old.rootReviewId, old.expiresAt])).rows[0]!;
      await db.query(`UPDATE "GrowthAgentReview" SET "supersededBy"=$2,state='rejected',"updatedAt"=now() WHERE id=$1`, [old.id, id]);
      await enqueueGrowthAgentReview(db, row, "revised");
      return { review: dto(row) };
    });
  }
  async decide(scope: GrowthAgentScope, reviewId: string, input: { requestId: string; payloadDigest: string; decision: "approve" | "reject" }, taskId?: string): Promise<{ review: GrowthDraftReview }> {
    await authorizeGrowthAgentScope(this.core, scope, "content");
    return transaction(this.core.pool, async db => {
      const row = await this.row(db, scope, reviewId, taskId, true);
      if (row.supersededBy || row.payloadDigest !== input.payloadDigest) throw conflict("This proposal changed. Review its current details");
      const desired = input.decision === "approve" ? "approved" : "rejected";
      if (row.decisionRequestId === input.requestId) {
        if (row.state !== desired && !(desired === "approved" && ["executing", "saved", "uncertain", "failed"].includes(row.state))) throw conflict("The decision identity was reused");
        return { review: dto(row) };
      }
      if (row.state !== "proposed" || new Date(row.expiresAt).getTime() <= Date.now()) throw conflict("This proposal is no longer awaiting review");
      await assertGrowthAgentContext(this.core, scope, row.context, row.contextRevision);
      if (input.decision === "approve") {
        const revisions = await this.destinationsRevision(scope, row.draft, db, true);
        if (growthAgentDigest(revisions) !== growthAgentDigest(row.destinationRevisions)) throw conflict("The selected publishing account changed. Edit and review the proposal again");
      }
      const updated = (await db.query<ReviewRow>(`UPDATE "GrowthAgentReview" SET state=$2,"decisionRequestId"=$3,"updatedAt"=now() WHERE id=$1 RETURNING *`, [row.id, desired, input.requestId])).rows[0]!;
      await enqueueGrowthAgentReview(db, updated, desired);
      return { review: dto(updated) };
    });
  }
  private async reconcileRow(db: PoolClient, scope: GrowthAgentScope, row: ReviewRow): Promise<ReviewRow> {
    if (!["approved", "executing", "uncertain"].includes(row.state)) return row;
    const postRow = (await db.query(`SELECT id,"userId","updatedAt",metadata FROM "SocialPost" WHERE "orgId"=$1 AND metadata->>'_kasitek_agent_idempotency_key'=$2 LIMIT 1`, [scope.tenantId, `growth-agent-draft:${row.id}`])).rows[0];
    if (!postRow) {
      if (row.state === "approved") return row;
      return (await db.query<ReviewRow>(`UPDATE "GrowthAgentReview" SET state='uncertain',"updatedAt"=now() WHERE id=$1 RETURNING *`, [row.id])).rows[0]!;
    }
    if (postRow.userId !== scope.actor.subject || postRow.metadata?.growthAgentPayloadDigest !== row.payloadDigest) throw conflict("The saved draft receipt does not match this review");
    const result: GrowthDraftReceipt = { operationId: row.operationId, reviewId: row.id, payloadDigest: row.payloadDigest,
      recordId: postRow.id, revision: new Date(postRow.updatedAt).toISOString(), route: `/content/posts/${encodeURIComponent(postRow.id)}`, state: "saved", actorId: scope.actor.subject };
    const updated = (await db.query<ReviewRow>(`UPDATE "GrowthAgentReview" SET state='saved',result=$2,"updatedAt"=now() WHERE id=$1 RETURNING *`, [row.id, JSON.stringify(result)])).rows[0]!;
    await enqueueGrowthAgentDraftSaved(db, updated, result.recordId, result.revision);
    return updated;
  }
  async reconcile(action: GrowthAgentAction<"draft.reconcile">): Promise<{ review: GrowthDraftReview; result: GrowthDraftReceipt | null }> {
    const scope = { tenantId: action.tenantId, actor: action.actor };
    await authorizeGrowthAgentScope(this.core, scope, "content");
    return transaction(this.core.pool, async db => {
      let row = await this.latest(db, scope, action.input.reviewId, action.taskId, true);
      if (row.conversationId !== action.conversationId) throw missing();
      row = await this.reconcileRow(db, scope, row);
      return { review: dto(row), result: row.result };
    });
  }
  async commit(action: GrowthAgentAction<"draft.commit">): Promise<{ review: GrowthDraftReview; result: GrowthDraftReceipt | null }> {
    const scope = { tenantId: action.tenantId, actor: action.actor };
    await authorizeGrowthAgentScope(this.core, scope, "content");
    return transaction(this.core.pool, async db => {
      const row = await this.row(db, scope, action.input.reviewId, action.taskId, true);
      if (row.conversationId !== action.conversationId || row.supersededBy || row.payloadDigest !== action.input.payloadDigest) throw conflict("The draft save does not match the approved proposal");
      if (row.state === "saved") return { review: dto(row), result: row.result };
      if (["approved", "executing", "uncertain"].includes(row.state)) {
        const current = await this.reconcileRow(db, scope, row);
        if (current.state === "saved" || row.state !== "approved") return { review: dto(current), result: current.result };
      }
      if (row.state !== "approved" || new Date(row.expiresAt).getTime() <= Date.now()) throw conflict("An active approved proposal is required to save this draft");
      await authorizeGrowthAgentScope(this.core, scope, "content", db, true);
      await assertGrowthAgentContext(this.core, scope, row.context, row.contextRevision);
      const revisions = await this.destinationsRevision(scope, row.draft, db, true);
      if (growthAgentDigest(revisions) !== growthAgentDigest(row.destinationRevisions)) throw conflict("The publishing account changed after review");
      // The exact Growth row stays locked while its normal domain transaction saves the draft.
      // The domain's stable key makes a crash after its commit reconcilable without another create.
      await db.query(`UPDATE "GrowthAgentReview" SET state='executing',"updatedAt"=now() WHERE id=$1`, [row.id]);
      let post: SocialPost;
      try {
        post = await (this.ports.create ?? createSocialPostIdempotent)(this.core.pool, scope.actor.subject, scope.tenantId,
          { ...row.draft, status: "DRAFT", primaryChannelId: row.draft.channelSelections[row.draft.channels[0]!],
            variants: row.draft.variants?.map(variant => ({ ...variant, status: "DRAFT", aiGenerated: true })),
            metadata: { growthAgentReviewId: row.id, growthAgentPayloadDigest: row.payloadDigest, growthAgentTaskId: row.taskId } }, `growth-agent-draft:${row.id}`);
      } catch (error) {
        const known = error instanceof ApiError && error.status < 500;
        const updated = (await db.query<ReviewRow>(`UPDATE "GrowthAgentReview" SET state=$2,"updatedAt"=now() WHERE id=$1 RETURNING *`, [row.id, known ? "failed" : "uncertain"])).rows[0]!;
        return { review: dto(updated), result: null };
      }
      const result: GrowthDraftReceipt = { operationId: row.operationId, reviewId: row.id, payloadDigest: row.payloadDigest,
        recordId: post.id, revision: new Date(post.updated_at).toISOString(), route: `/content/posts/${encodeURIComponent(post.id)}`, state: "saved", actorId: scope.actor.subject };
      const updated = (await db.query<ReviewRow>(`UPDATE "GrowthAgentReview" SET state='saved',result=$2,"updatedAt"=now() WHERE id=$1 RETURNING *`, [row.id, JSON.stringify(result)])).rows[0]!;
      await enqueueGrowthAgentDraftSaved(db, updated, result.recordId, result.revision);
      return { review: dto(updated), result };
    });
  }
}
