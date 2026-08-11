import type { Pool } from "pg";
import { query } from "../pool";
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
  }): Promise<void> {
    await query(
      this.pool,
      `INSERT INTO model_calls
        (organization_id, run_id, provider, model, funding_source, credential_reference,
         input_tokens, output_tokens, total_tokens, estimated_cost_usd, latency_ms, finish_reason,
         status, completed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'completed', now())`,
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
  }

  public async recordFailed(input: {
    organizationId: string;
    runId?: string;
    provider: ModelProvider;
    model: string;
    fundingSource: "kasitek" | "user";
    error: { code: string; message: string };
  }): Promise<void> {
    await query(
      this.pool,
      `INSERT INTO model_calls
        (organization_id, run_id, provider, model, funding_source, status, error, completed_at)
       VALUES ($1, $2, $3, $4, $5, 'failed', $6::jsonb, now())`,
      [input.organizationId, input.runId ?? null, input.provider, input.model, input.fundingSource, JSON.stringify(input.error)],
    );
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
}
