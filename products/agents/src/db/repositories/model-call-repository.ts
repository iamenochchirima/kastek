import type { Pool } from "pg";
import { buildCompletedModelCallEvent, buildFailedModelCallEvent, enqueueOutbox } from "../../analytics";
import { query, withTransaction } from "../pool";
import type { ModelProvider, ModelResponse } from "../../model/types";

export type ModelCallPreparation =
  | { status: "new" }
  | { status: "completed"; response: ModelResponse }
  | { status: "unknown" };

export class ModelCallRepository {
  public constructor(private readonly pool: Pool) {}

  /**
   * Claims a durable model operation before calling a provider. A completed
   * operation can be replayed; an operation left started by a dead worker is
   * deliberately treated as unknown so a retry cannot spend twice.
   */
  public async prepare(input: {
    organizationId: string;
    runId: string;
    operationKey: string;
    provider: ModelProvider;
    model: string;
    fundingSource: "kasitek" | "user";
    credentialReference?: string;
  }): Promise<ModelCallPreparation> {
    const operationKey = input.operationKey.trim();
    if (!operationKey || operationKey.length > 240) throw new Error("MODEL_OPERATION_KEY_INVALID");
    return withTransaction(this.pool, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO model_calls
          (organization_id, run_id, provider, model, funding_source, credential_reference,
           operation_key, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'started')
         ON CONFLICT (operation_key) WHERE operation_key IS NOT NULL DO NOTHING
         RETURNING id`,
        [input.organizationId, input.runId, input.provider, input.model, input.fundingSource, input.credentialReference ?? null, operationKey],
      );
      if (inserted.rows[0]) return { status: "new" };
      const result = await client.query<{
        organization_id: string;
        run_id: string | null;
        status: "started" | "completed" | "failed";
        response: ModelResponse | null;
      }>(
        `SELECT organization_id, run_id, status, response
         FROM model_calls WHERE operation_key = $1`,
        [operationKey],
      );
      const row = result.rows[0];
      if (!row || row.organization_id !== input.organizationId || row.run_id !== input.runId) {
        throw new Error("MODEL_OPERATION_SCOPE_CONFLICT");
      }
      if (row.status === "completed") {
        if (!row.response) throw new Error("MODEL_CALL_RESPONSE_MISSING");
        return { status: "completed", response: row.response };
      }
      if (row.status === "started") return { status: "unknown" };
      await client.query(
        `UPDATE model_calls
         SET status = 'started', error = NULL, response = NULL, completed_at = NULL
         WHERE operation_key = $1 AND status = 'failed'`,
        [operationKey],
      );
      return { status: "new" };
    });
  }

  public async recordCompleted(input: {
    organizationId: string;
    runId?: string;
    operationKey?: string;
    provider: ModelProvider;
    model: string;
    fundingSource: "kasitek" | "user";
    credentialReference?: string;
    response: ModelResponse;
    correlationId?: string | null;
  }): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      let row: { id: string; completed_at: Date | string } | undefined;
      let shouldPublish = true;
      if (input.operationKey) {
        const existing = await client.query<{ id: string; status: "started" | "completed" | "failed"; completed_at: Date | string | null }>(
          `SELECT id, status, completed_at FROM model_calls
           WHERE operation_key = $1 AND organization_id = $2 AND run_id = $3 FOR UPDATE`,
          [input.operationKey, input.organizationId, input.runId ?? null],
        );
        if (existing.rows[0]?.status === "completed") {
          row = { id: existing.rows[0].id, completed_at: existing.rows[0].completed_at ?? new Date() };
          shouldPublish = false;
        } else if (existing.rows[0]) {
          const updated = await client.query<{ id: string; completed_at: Date | string }>(
            `UPDATE model_calls
             SET provider = $4, model = $5, funding_source = $6, credential_reference = $7,
                 input_tokens = $8, output_tokens = $9, total_tokens = $10,
                 estimated_cost_usd = $11, latency_ms = $12, finish_reason = $13,
                 response = $14::jsonb, status = 'completed', error = NULL, completed_at = now()
             WHERE id = $1 AND organization_id = $2 AND run_id = $3
             RETURNING id, completed_at`,
            [existing.rows[0].id, input.organizationId, input.runId ?? null, input.provider, input.model, input.fundingSource, input.credentialReference ?? null, input.response.usage.inputTokens, input.response.usage.outputTokens, input.response.usage.totalTokens, input.response.usage.estimatedCostUsd ?? null, input.response.latencyMs, input.response.finishReason, JSON.stringify(input.response)],
          );
          row = updated.rows[0];
        } else {
          throw new Error("MODEL_OPERATION_NOT_PREPARED");
        }
      } else {
        const inserted = await client.query<{ id: string; completed_at: Date | string }>(
          `INSERT INTO model_calls
            (organization_id, run_id, provider, model, funding_source, credential_reference,
             input_tokens, output_tokens, total_tokens, estimated_cost_usd, latency_ms, finish_reason,
             response, status, completed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, 'completed', now())
           RETURNING id, completed_at`,
          [input.organizationId, input.runId ?? null, input.provider, input.model, input.fundingSource, input.credentialReference ?? null, input.response.usage.inputTokens, input.response.usage.outputTokens, input.response.usage.totalTokens, input.response.usage.estimatedCostUsd ?? null, input.response.latencyMs, input.response.finishReason, JSON.stringify(input.response)],
        );
        row = inserted.rows[0];
      }
      if (!row) throw new Error("MODEL_CALL_INSERT_FAILED");
      if (!shouldPublish) return;
      await enqueueOutbox(client, buildCompletedModelCallEvent({
        modelCallId: row.id,
        organizationId: input.organizationId,
        runId: input.runId ?? null,
        provider: input.provider,
        model: input.model,
        fundingSource: input.fundingSource,
        inputTokens: input.response.usage.inputTokens,
        outputTokens: input.response.usage.outputTokens,
        totalTokens: input.response.usage.totalTokens,
        estimatedCostUsd: input.response.usage.estimatedCostUsd ?? null,
        latencyMs: input.response.latencyMs,
        finishReason: input.response.finishReason,
        occurredAt: row.completed_at,
        correlationId: input.correlationId,
      }));
    });
  }

  public async recordFailed(input: {
    organizationId: string;
    runId?: string;
    operationKey?: string;
    provider: ModelProvider;
    model: string;
    fundingSource: "kasitek" | "user";
    error: { code: string; message: string };
    correlationId?: string | null;
  }): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      let row: { id: string; completed_at: Date | string } | undefined;
      let shouldPublish = true;
      if (input.operationKey) {
        const existing = await client.query<{ id: string; status: "started" | "completed" | "failed"; completed_at: Date | string | null }>(
          `SELECT id, status, completed_at FROM model_calls
           WHERE operation_key = $1 AND organization_id = $2 AND run_id = $3 FOR UPDATE`,
          [input.operationKey, input.organizationId, input.runId ?? null],
        );
        if (existing.rows[0]?.status === "completed") return;
        if (existing.rows[0]) {
          const updated = await client.query<{ id: string; completed_at: Date | string }>(
            `UPDATE model_calls SET provider = $4, model = $5, funding_source = $6,
                 error = $7::jsonb, status = 'failed', response = NULL, completed_at = now()
             WHERE id = $1 AND organization_id = $2 AND run_id = $3
             RETURNING id, completed_at`,
            [existing.rows[0].id, input.organizationId, input.runId ?? null, input.provider, input.model, input.fundingSource, JSON.stringify(input.error)],
          );
          row = updated.rows[0];
          shouldPublish = existing.rows[0].status !== "failed";
        } else {
          throw new Error("MODEL_OPERATION_NOT_PREPARED");
        }
      } else {
        const inserted = await client.query<{ id: string; completed_at: Date | string }>(
          `INSERT INTO model_calls
            (organization_id, run_id, provider, model, funding_source, status, error, completed_at)
           VALUES ($1, $2, $3, $4, $5, 'failed', $6::jsonb, now())
           RETURNING id, completed_at`,
          [input.organizationId, input.runId ?? null, input.provider, input.model, input.fundingSource, JSON.stringify(input.error)],
        );
        row = inserted.rows[0];
      }
      if (!row) throw new Error("MODEL_CALL_INSERT_FAILED");
      if (!shouldPublish) return;
      await enqueueOutbox(client, buildFailedModelCallEvent({
        modelCallId: row.id,
        organizationId: input.organizationId,
        runId: input.runId ?? null,
        provider: input.provider,
        model: input.model,
        fundingSource: input.fundingSource,
        occurredAt: row.completed_at,
        correlationId: input.correlationId,
        error: input.error,
      }));
    });
  }

  public async usageSummary(organizationId: string): Promise<{
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
    failedCalls: number;
  }> {
    const result = await query<{
      input_tokens: string;
      output_tokens: string;
      total_tokens: string;
      estimated_cost_usd: string | null;
      failed_calls: string;
    }>(
      this.pool,
      `SELECT COALESCE(SUM(input_tokens), 0)::text AS input_tokens,
              COALESCE(SUM(output_tokens), 0)::text AS output_tokens,
              COALESCE(SUM(total_tokens), 0)::text AS total_tokens,
              COALESCE(SUM(estimated_cost_usd), 0)::text AS estimated_cost_usd,
              COUNT(*) FILTER (WHERE status = 'failed')::text AS failed_calls
       FROM model_calls WHERE organization_id = $1`,
      [organizationId],
    );
    const row = result.rows[0]!;
    return {
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      totalTokens: Number(row.total_tokens),
      estimatedCostUsd: Number(row.estimated_cost_usd ?? 0),
      failedCalls: Number(row.failed_calls),
    };
  }

  public async usageForRun(organizationId: string, runId: string, fundingSource?: "kasitek" | "user"): Promise<{
    modelCalls: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
  }> {
    const result = await query<{
      model_calls: string;
      input_tokens: string;
      output_tokens: string;
      total_tokens: string;
      estimated_cost_usd: string;
    }>(
      this.pool,
      `SELECT COUNT(*) FILTER (WHERE status = 'completed')::text AS model_calls,
              COALESCE(SUM(input_tokens) FILTER (WHERE status = 'completed'), 0)::text AS input_tokens,
              COALESCE(SUM(output_tokens) FILTER (WHERE status = 'completed'), 0)::text AS output_tokens,
              COALESCE(SUM(total_tokens) FILTER (WHERE status = 'completed'), 0)::text AS total_tokens,
              COALESCE(SUM(estimated_cost_usd) FILTER (WHERE status = 'completed'), 0)::text AS estimated_cost_usd
       FROM model_calls
       WHERE organization_id = $1 AND run_id = $2
         AND ($3::text IS NULL OR funding_source = $3)`,
      [organizationId, runId, fundingSource ?? null],
    );
    const row = result.rows[0]!;
    return {
      modelCalls: Number(row.model_calls),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      totalTokens: Number(row.total_tokens),
      estimatedCostUsd: Number(row.estimated_cost_usd),
    };
  }

  public async assertRunBudget(input: { organizationId: string; runId: string; maxTotalTokens?: number; maxEstimatedCostUsd?: number; maxRequests?: number }): Promise<void> {
    const result = await query<{ requests: string; total_tokens: string; estimated_cost_usd: string }>(
      this.pool,
      `SELECT COUNT(*) FILTER (WHERE status = 'completed')::text AS requests,
              COALESCE(SUM(total_tokens), 0)::text AS total_tokens,
              COALESCE(SUM(estimated_cost_usd), 0)::text AS estimated_cost_usd
       FROM model_calls WHERE organization_id = $1 AND run_id = $2`,
      [input.organizationId, input.runId],
    );
    const usage = result.rows[0]!;
    const requests = Number(usage.requests);
    const totalTokens = Number(usage.total_tokens);
    const estimatedCostUsd = Number(usage.estimated_cost_usd);
    if (input.maxRequests !== undefined && requests >= input.maxRequests) throw new Error("MODEL_REQUEST_BUDGET_EXCEEDED");
    if (input.maxTotalTokens !== undefined && totalTokens >= input.maxTotalTokens) throw new Error("MODEL_TOKEN_BUDGET_EXCEEDED");
    if (input.maxEstimatedCostUsd !== undefined && estimatedCostUsd >= input.maxEstimatedCostUsd) throw new Error("MODEL_SPEND_BUDGET_EXCEEDED");
  }
}
