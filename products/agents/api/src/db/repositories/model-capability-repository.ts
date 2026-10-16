import type { Pool } from "pg";
import { query, withTransaction } from "../pool";
import type { ContextCapabilityRecord, ContextCapabilityStore } from "../../runtime/context-capability";
import { isModelProvider, type ModelProvider } from "../../model/types";

const SOURCES = new Set(["provider_metadata", "catalog", "configured_override", "provider_error_correction", "unknown"]);

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function timestamp(value: unknown): string | undefined {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : undefined;
  if (typeof value !== "string" || !value.trim()) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function normalizeRecord(input: ContextCapabilityRecord): ContextCapabilityRecord {
  if (typeof input.organizationId !== "string" || !input.organizationId.trim()) throw new Error("MODEL_CAPABILITY_ORGANIZATION_ID_REQUIRED");
  const provider = typeof input.provider === "string" ? input.provider.trim() : "";
  const model = typeof input.model === "string" ? input.model.trim() : "";
  const endpointId = typeof input.endpointId === "string" ? input.endpointId.trim() : "";
  const credentialRouteId = (input.credentialRouteId ?? "default").trim();
  const runtimeEnvironment = (input.runtimeEnvironment ?? "development").trim();
  if (!provider || !isModelProvider(provider) || !model || !endpointId || !credentialRouteId || !runtimeEnvironment) throw new Error("MODEL_CAPABILITY_ROUTE_INVALID");
  if (!SOURCES.has(input.source)) throw new Error("MODEL_CAPABILITY_SOURCE_INVALID");

  const contextWindowTokens = input.contextWindowTokens === undefined ? undefined : positiveInteger(input.contextWindowTokens);
  const maxOutputTokens = input.maxOutputTokens === undefined ? undefined : positiveInteger(input.maxOutputTokens);
  if (input.contextWindowTokens !== undefined && contextWindowTokens === undefined) throw new Error("MODEL_CAPABILITY_CONTEXT_INVALID");
  if (input.maxOutputTokens !== undefined && maxOutputTokens === undefined) throw new Error("MODEL_CAPABILITY_OUTPUT_INVALID");
  if (input.source !== "unknown" && contextWindowTokens === undefined && maxOutputTokens === undefined) throw new Error("MODEL_CAPABILITY_VALUE_REQUIRED");

  const resolvedAt = timestamp(input.resolvedAt);
  if (!resolvedAt) throw new Error("MODEL_CAPABILITY_RESOLVED_AT_INVALID");
  const expiresAt = input.expiresAt === undefined ? undefined : timestamp(input.expiresAt);
  if (input.expiresAt !== undefined && !expiresAt) throw new Error("MODEL_CAPABILITY_EXPIRES_AT_INVALID");
  if (expiresAt && Date.parse(expiresAt) <= Date.parse(resolvedAt)) throw new Error("MODEL_CAPABILITY_EXPIRY_ORDER_INVALID");

  return {
    organizationId: input.organizationId,
    provider,
    model,
    endpointId,
    credentialRouteId,
    runtimeEnvironment,
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    source: input.source,
    resolvedAt,
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

export class ModelCapabilityRepository implements ContextCapabilityStore {
  public constructor(private readonly pool: Pool) {}

  public async get(input: { organizationId: string; provider: ModelProvider; model: string; endpointId: string; credentialRouteId: string; runtimeEnvironment: string }): Promise<ContextCapabilityRecord | undefined> {
    const result = await query<{
      organization_id: string;
      provider: ModelProvider;
      model: string;
      endpoint_id: string;
      credential_route_id: string;
      runtime_environment: string;
      context_window_tokens: number | null;
      max_output_tokens: number | null;
      source: string;
      resolved_at: Date | string;
      expires_at: Date | string | null;
      }>(this.pool, `SELECT organization_id, provider, model, endpoint_id, context_window_tokens, max_output_tokens,
                         credential_route_id, runtime_environment, source, resolved_at, expires_at
                  FROM agent_model_capabilities
                  WHERE organization_id = $1 AND provider = $2 AND model = $3 AND endpoint_id = $4
                    AND credential_route_id = $5 AND runtime_environment = $6`, [input.organizationId, input.provider, input.model, input.endpointId, input.credentialRouteId, input.runtimeEnvironment]);
    const row = result.rows[0];
    if (!row || !SOURCES.has(row.source)) return undefined;
    try {
      return normalizeRecord({
        organizationId: row.organization_id,
        provider: row.provider,
        model: row.model,
        endpointId: row.endpoint_id,
        credentialRouteId: row.credential_route_id,
        runtimeEnvironment: row.runtime_environment,
        ...(row.context_window_tokens === null ? {} : { contextWindowTokens: row.context_window_tokens }),
        ...(row.max_output_tokens === null ? {} : { maxOutputTokens: row.max_output_tokens }),
        source: row.source as ContextCapabilityRecord["source"],
        resolvedAt: row.resolved_at instanceof Date ? row.resolved_at.toISOString() : row.resolved_at,
        ...(row.expires_at === null ? {} : { expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at }),
      });
    } catch {
      // A corrupted advisory cache must fail closed. The runtime can then use
      // a stronger source or report unknown after a worker restart.
      return undefined;
    }
  }

  public async upsert(input: ContextCapabilityRecord): Promise<void> {
    const record = normalizeRecord(input);
    await withTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO agent_model_capabilities
          (organization_id, provider, model, endpoint_id, credential_route_id, runtime_environment, context_window_tokens, max_output_tokens, source, resolved_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz, $11::timestamptz)
         ON CONFLICT (organization_id, provider, model, endpoint_id, credential_route_id, runtime_environment) DO UPDATE
           SET context_window_tokens = EXCLUDED.context_window_tokens,
               max_output_tokens = EXCLUDED.max_output_tokens,
               source = EXCLUDED.source,
               resolved_at = EXCLUDED.resolved_at,
               expires_at = EXCLUDED.expires_at,
               updated_at = now()` ,
        [record.organizationId, record.provider, record.model, record.endpointId, record.credentialRouteId, record.runtimeEnvironment, record.contextWindowTokens ?? null, record.maxOutputTokens ?? null, record.source, record.resolvedAt, record.expiresAt ?? null],
      );
    });
  }
}
