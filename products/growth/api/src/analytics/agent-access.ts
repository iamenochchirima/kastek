import type { Pool, PoolClient } from "pg";
import { growthOperations } from "@kasitek-labs/contracts";
import { transaction } from "../db.js";
import { enqueueFact, type Timestamp } from "./facts.js";

export type AgentAccessAction = "proposed" | "approved" | "rejected" | "succeeded" | "uncertain" | "failed" | "granted" | "revoked";
export interface AgentAccessEvent {
  orgId: string;
  subjectId: string;
  kind: "operation" | "connection";
  action: AgentAccessAction;
  operation?: string | null;
  time: Timestamp;
}
const knownOperations = new Set(growthOperations.map(operation => operation.name));
const admissions = new Set(["content.posts.publish", "content.posts.publish_batch", "content.posts.publish_batch.retry", "content.posts.schedule", "content.posts.reschedule", "content.jobs.retry", "inbox.messages.send"]);

/** Count access decisions and admissions, never infer a successful external publication. */
export async function enqueueGrowthAgentAccess(tx: PoolClient, input: AgentAccessEvent) {
  const operation = input.operation ?? null;
  if (input.kind === "connection" ? operation !== null || !["granted", "revoked"].includes(input.action) : !operation || !knownOperations.has(operation) || ["granted", "revoked"].includes(input.action))
    throw new Error("Invalid Growth agent access event");
  const outcome = input.action === "succeeded" ? admissions.has(operation!) ? "admitted" : "completed" : input.action === "uncertain" ? "unknown" : input.action === "proposed" ? "awaiting_review" : input.action;
  const result = await enqueueFact(tx, "agent_access", input.orgId, `growth-access:${input.kind}:${input.subjectId}:${input.action}`, "growth.agent.access@1", `growth_${input.kind}`, input.subjectId, input.time,
    { kind: input.kind, action: input.action, operation, outcome });
  if (result.kind === "conflict") throw new Error("Growth agent access event identity conflict");
  return result;
}

/** Immutable grant/revocation timestamps allow bounded recovery after any OAuth process crash. */
export async function enqueueMissingOAuthAccessEvents(pool: Pool, limit = 100): Promise<number> {
  return transaction(pool, async tx => {
    const rows = (await tx.query<{ id: string; orgId: string; action: "granted" | "revoked"; occurredAt: Date }>(`SELECT g.id,g."orgId",e.action,e.time AS "occurredAt"
      FROM "GrowthOAuthConnection" g CROSS JOIN LATERAL (VALUES('granted',g."createdAt"),('revoked',g."revokedAt")) e(action,time)
      WHERE e.time IS NOT NULL AND NOT EXISTS(SELECT 1 FROM analytics_outbox o WHERE o.source_service='core' AND o.record_category='event' AND o.record_id='growth-access:connection:'||g.id||':'||e.action)
      ORDER BY e.time,g.id,e.action LIMIT $1`, [Math.max(1, Math.min(500, Math.trunc(limit) || 100))])).rows;
    let inserted = 0;
    for (const row of rows) {
      const result = await enqueueGrowthAgentAccess(tx, { orgId: row.orgId, subjectId: row.id, kind: "connection", action: row.action, time: row.occurredAt });
      if (result.kind === "inserted") inserted++;
    }
    return inserted;
  });
}
