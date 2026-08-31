import type { Pool } from "pg";
import { buildCompletedModelCallEvent, buildFailedModelCallEvent, enqueueOutbox } from "../../analytics";
import { query, withTransaction } from "../pool";
import type { ModelProvider, ModelResponse } from "../../model/types";

export class ModelCallRepository {
  public constructor(private readonly pool: Pool) {}

  public async recordCompleted(input: {
    organizationId: string;
    runId?: string;
    provider: ModelProvider;
    model: string;
    fundingSource: "kasitek" | "user";
    credentialReference?: string;
    response: ModelResponse;
    correlationId?: string | null;
  }): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const result = await client.query<{ id: string; completed_at: Date | string }>(
        `INSERT INTO model_calls
          (organization_id, run_id, provider, model, funding_source, credential_reference,
           input_tokens, output_tokens, total_tokens, estimated_cost_usd, latency_ms, finish_reason,
           status, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'completed', now())
         RETURNING id, completed_at`,
        [
          input.organizationId,
          input.runId ?? null,
          input.provider,
          input.model,
          input.fundingSource,
          input.credentialReference ?? null,
          input.response.usage.inputTokens,
          input.response.usage.outputTokens,
          input.response.usage.totalTokens,
          input.response.usage.estimatedCostUsd ?? null,
          input.response.latencyMs,
          input.response.finishReason,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error("MODEL_CALL_INSERT_FAILED");
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
    provider: ModelProvider;
    model: string;
    fundingSource: "kasitek" | "user";
    error: { code: string; message: string };
    correlationId?: string | null;
  }): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const result = await client.query<{ id: string; completed_at: Date | string }>(
        `INSERT INTO model_calls
          (organization_id, run_id, provider, model, funding_source, status, error, completed_at)
         VALUES ($1, $2, $3, $4, $5, 'failed', $6::jsonb, now())
         RETURNING id, completed_at`,
        [input.organizationId, input.runId ?? null, input.provider, input.model, input.fundingSource, JSON.stringify(input.error)],
      );
      const row = result.rows[0];
      if (!row) throw new Error("MODEL_CALL_INSERT_FAILED");
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

  public async usageForRun(organizationId: string, runId: string): Promise<{
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
       WHERE organization_id = $1 AND run_id = $2`,
      [organizationId, runId],
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
