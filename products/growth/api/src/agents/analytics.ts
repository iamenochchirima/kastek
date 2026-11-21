import type { Pool, PoolClient } from "pg";
import type { GrowthAgentCommandOperation, GrowthAgentFeatureId } from "@kasitek-labs/contracts";
import { enqueueOutbox } from "@kasitek-labs/server-support/analytics-producer";
import { fact } from "../analytics/facts.js";
import { transaction } from "../db.js";
import { ApiError } from "../error.js";
import { growthAgentDigest } from "./security.js";
import type { GrowthAgentScope } from "./scope.js";

const resourceMutations = new Set<string>(["sources.import", "sources.review", "sources.state", "skills.import", "skills.review", "skills.state", "resources.select"]);
const commandOperations = new Set<string>(["conversations.create", "conversations.context", "turns.submit", "tasks.cancel", "tasks.instructions", "tasks.continue","memory.configure","memory.mutate", ...resourceMutations]);
export interface GrowthAgentCommandOutcome {
  operation: string; requestId: string; featureId: GrowthAgentFeatureId | null;
  conversationId: string | null; taskId: string | null;
  outcome: "accepted" | "rejected" | "unavailable"; failureCode: string | null;
}
export function growthAgentCommandFact(scope: GrowthAgentScope, input: GrowthAgentCommandOutcome) {
  const identity = growthAgentDigest({ tenantId: scope.tenantId, actor: scope.actor, operation: input.operation,
    requestId: input.requestId, outcome: input.outcome, failureCode: input.failureCode });
  return fact("growth_agents", scope.tenantId, `growth-agent-command:${identity}`, input.operation.startsWith("memory.")||resourceMutations.has(input.operation)?"growth.agent.command@2":"growth.agent.command@1", "agent_command", identity, new Date(), {
    feature_id: input.featureId, conversation_id: input.conversationId, task_id: input.taskId,
    operation: input.operation, outcome: input.outcome, failure_code: input.failureCode,
  });
}
export async function enqueueGrowthAgentCommand(pool: Pool, scope: GrowthAgentScope, input: GrowthAgentCommandOutcome): Promise<void> {
  if (!commandOperations.has(input.operation)) return;
  const record = growthAgentCommandFact(scope, input);
  await transaction(pool, async db => {
    const outcome = await enqueueOutbox(db, record);
    if (outcome.kind === "conflict") throw new ApiError(409, "agent_analytics_conflict", "The command outcome identity was reused");
  });
}
export interface GrowthAgentReviewOutcome {
  id: string; orgId: string; taskId: string; conversationId: string; featureId: GrowthAgentFeatureId;
  state: string; createdAt: Date; updatedAt?: Date;
}
export function growthAgentReviewFact(row: GrowthAgentReviewOutcome, action: "proposed" | "revised" | "approved" | "rejected") {
  const occurredAt = action === "proposed" || action === "revised" ? row.createdAt : row.updatedAt!;
  return fact("growth_agents", row.orgId, `growth-agent-review:${row.id}:${action}`, "growth.agent.review@1", "agent_review", row.id, occurredAt, {
    review_id: row.id, task_id: row.taskId, conversation_id: row.conversationId, feature_id: row.featureId,
    action, state: row.state, occurred_at: occurredAt.toISOString(),
  });
}
export async function enqueueGrowthAgentReview(db: PoolClient, row: GrowthAgentReviewOutcome, action: "proposed" | "revised" | "approved" | "rejected"): Promise<void> {
  const record = growthAgentReviewFact(row, action);
  const result = await enqueueOutbox(db, record);
  if (result.kind === "conflict") throw new ApiError(409, "agent_analytics_conflict", "The review outcome identity was reused");
}
export function growthAgentDraftSavedFact(row: GrowthAgentReviewOutcome, recordId: string, revision: string) {
  return fact("growth_agents", row.orgId, `growth-agent-draft:${row.id}`, "growth.agent.draft_saved@1", "agent_review", row.id, revision, {
    review_id: row.id, task_id: row.taskId, conversation_id: row.conversationId, feature_id: row.featureId,
    record_id: recordId, record_revision: revision, outcome: "saved", occurred_at: revision,
  });
}
export async function enqueueGrowthAgentDraftSaved(db: PoolClient, row: GrowthAgentReviewOutcome, recordId: string, revision: string): Promise<void> {
  const result = await enqueueOutbox(db, growthAgentDraftSavedFact(row, recordId, revision));
  if (result.kind === "conflict") throw new ApiError(409, "agent_analytics_conflict", "The saved draft outcome identity was reused");
}
