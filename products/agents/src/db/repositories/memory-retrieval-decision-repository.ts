import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { query } from "../pool";
import type { MemoryRetrievalPlan } from "../../memory/contracts";
import type { RetrievalGateMetadata } from "../../memory/retrieval-gate";

export interface MemoryRetrievalDecisionInput {
  organizationId: string;
  workspaceId: string;
  agentDefinitionId: string;
  agentVersionId?: string;
  installationId: string;
  conversationId?: string;
  endUserId?: string;
  runId?: string;
  turnId: string;
  attemptId: string;
  sourceBoundaryDigest: string;
  query: string;
  plan: MemoryRetrievalPlan;
  gate?: RetrievalGateMetadata;
  selectedRevisionIds: readonly string[];
  rejectedReasons: readonly string[];
  status: "completed" | "blocked" | "failed";
  measuredTokens: number;
  candidateCount: number;
  evidenceCount: number;
  latencyMs: number;
  errorCode?: string;
}

export type MemoryRetrievalDecisionWriteStatus = "created" | "replayed";

function bounded(value: string, max: number): string {
  return value.trim().slice(0, max);
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedList(values: readonly string[], maxItems: number, maxLength: number): string[] {
  return [...new Set(values.map((value) => bounded(value, maxLength)).filter(Boolean))].slice(0, maxItems);
}

function errorCode(value: string | undefined): string | null {
  const normalized = bounded(value ?? "", 120).toUpperCase().replace(/[^A-Z0-9_.-]/g, "_");
  return normalized || null;
}

/**
 * Persists only bounded, content-free retrieval evidence.  A failed write is
 * surfaced to the caller so production can choose whether to block a required
 * observability policy, while replay uses the same idempotency key and never
 * duplicates a decision.
 */
export class MemoryRetrievalDecisionRepository {
  public constructor(private readonly pool: Pool) {}

  public async record(input: MemoryRetrievalDecisionInput): Promise<MemoryRetrievalDecisionWriteStatus> {
    const queryText = bounded(input.query, 4_000);
    const plannerVersion = bounded(input.plan.plannerVersion, 120);
    const turnId = bounded(input.turnId, 240);
    const attemptId = bounded(input.attemptId, 240);
    const idempotencyKey = `memory-retrieval:${input.organizationId}:${input.runId ?? "no-run"}:${turnId}:${attemptId}:${input.sourceBoundaryDigest}:${plannerVersion}`.slice(0, 512);
    const result = await query<{ id: string }>(
      this.pool,
      `INSERT INTO agent_memory_retrieval_decisions (
         organization_id, workspace_id, agent_definition_id, agent_version_id,
         installation_id, conversation_id, end_user_id, run_id, turn_id,
         attempt_id, source_boundary_digest, query_digest, query_length,
         planner_version, decision, reason, freshness, memory_kinds,
         selected_revision_ids, rejected_reasons, status, measured_tokens,
         max_tokens, candidate_count, evidence_count, latency_ms, error_code,
         idempotency_key, gate_source, gate_model, gate_confidence,
         gate_latency_ms, gate_error_code
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,
                 $19,$20::jsonb,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33)
       ON CONFLICT (organization_id, idempotency_key) DO NOTHING
       RETURNING id`,
      [
        input.organizationId,
        input.workspaceId,
        input.agentDefinitionId,
        input.agentVersionId ?? null,
        input.installationId,
        input.conversationId ?? null,
        input.endUserId ?? null,
        input.runId ?? null,
        turnId,
        attemptId,
        input.sourceBoundaryDigest,
        digest(queryText),
        queryText.length,
        plannerVersion,
        input.plan.decision,
        bounded(input.plan.reason, 160) || "memory",
        input.plan.freshness,
        boundedList(input.plan.memoryKinds, 8, 40),
        boundedList(input.selectedRevisionIds, 100, 120),
        JSON.stringify(boundedList(input.rejectedReasons, 32, 160)),
        input.status,
        Math.max(0, Math.trunc(input.measuredTokens)),
        Math.max(1, Math.trunc(input.plan.maxTokens)),
        Math.max(0, Math.trunc(input.candidateCount)),
        Math.max(0, Math.trunc(input.evidenceCount)),
        Math.max(0, Math.trunc(input.latencyMs)),
        errorCode(input.errorCode),
        idempotencyKey,
        input.gate?.source ?? null,
        input.gate?.model ? bounded(input.gate.model, 160) : null,
        input.gate?.confidence ?? null,
        input.gate?.latencyMs === undefined ? null : Math.max(0, Math.trunc(input.gate.latencyMs)),
        errorCode(input.gate?.errorCode),
      ],
    );
    return result.rows[0] ? "created" : "replayed";
  }
}
