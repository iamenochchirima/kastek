import { modelProviderDefinition } from "../model/providers";
import type { ModelProvider } from "../model/types";
import { operationalLogger } from "../telemetry/logger";
import { recordMemoryEmbedding } from "../telemetry/spans";

export const DEFAULT_EMBEDDING_PROVIDER: ModelProvider = "openrouter";
export const DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small";
export const DEFAULT_EMBEDDING_DIMENSIONS = 1_536;
export const DEFAULT_EMBEDDING_BATCH_SIZE = 32;
export const DEFAULT_EMBEDDING_TIMEOUT_MS = 10_000;

export interface EmbeddingProvider {
  readonly provider: ModelProvider;
  readonly model: string;
  readonly dimensions: number;
  embed(input: readonly string[]): Promise<number[][]>;
}

interface EmbeddingResponse {
  data?: Array<{ index?: number; embedding?: unknown }>;
  error?: { code?: string; message?: string };
}

export interface OpenAICompatibleEmbeddingProviderOptions {
  provider: ModelProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
  dimensions: number;
  batchSize?: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

function validVector(value: unknown, dimensions: number): value is number[] {
  return Array.isArray(value)
    && value.length === dimensions
    && value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

export function formatPgVector(value: readonly number[] | undefined, dimensions = DEFAULT_EMBEDDING_DIMENSIONS): string | null {
  if (!value || value.length !== dimensions || !value.every((entry) => Number.isFinite(entry))) return null;
  return `[${value.join(",")}]`;
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  public readonly provider: ModelProvider;
  public readonly model: string;
  public readonly dimensions: number;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  public constructor(private readonly options: OpenAICompatibleEmbeddingProviderOptions) {
    this.provider = options.provider;
    this.model = options.model;
    this.dimensions = options.dimensions;
    this.batchSize = Math.max(1, Math.min(options.batchSize ?? DEFAULT_EMBEDDING_BATCH_SIZE, 100));
    this.timeoutMs = Math.max(500, Math.min(options.timeoutMs ?? DEFAULT_EMBEDDING_TIMEOUT_MS, 120_000));
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  public async embed(input: readonly string[]): Promise<number[][]> {
    if (!input.length) return [];
    if (input.some((value) => !value.trim())) throw new Error("Embedding input must not be empty");
    const result: number[][] = [];
    for (let offset = 0; offset < input.length; offset += this.batchSize) {
      const batch = input.slice(offset, offset + this.batchSize);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(`${this.options.baseUrl.replace(/\/$/, "")}/embeddings`, {
          method: "POST",
          signal: controller.signal,
          headers: { "content-type": "application/json", authorization: `Bearer ${this.options.apiKey}` },
          body: JSON.stringify({ model: this.model, input: batch }),
        });
        const body = await response.json() as EmbeddingResponse;
        if (!response.ok) throw new Error(body.error?.code ?? body.error?.message ?? `Embedding provider returned HTTP ${response.status}`);
        const data = body.data ?? [];
        if (data.length !== batch.length) throw new Error("Embedding provider returned an incomplete batch");
        const ordered = [...data].sort((left, right) => (left.index ?? 0) - (right.index ?? 0));
        if (!ordered.every((entry) => validVector(entry.embedding, this.dimensions))) {
          throw new Error(`Embedding provider returned a vector with the wrong dimension; expected ${this.dimensions}`);
        }
        result.push(...ordered.map((entry) => entry.embedding as number[]));
        recordMemoryEmbedding({ provider: this.provider, outcome: "success", count: batch.length });
      } finally {
        clearTimeout(timeout);
      }
    }
    return result;
  }
}

function environmentBoolean(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes((value ?? "").trim().toLowerCase());
}

/** Returns undefined when embeddings are deliberately disabled or unconfigured. */
export function createEnvironmentEmbeddingProvider(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider | undefined {
  if (!environmentBoolean(env.EMBEDDINGS_ENABLED)) return undefined;
  const provider = (env.EMBEDDING_PROVIDER?.trim() || DEFAULT_EMBEDDING_PROVIDER) as ModelProvider;
  if (provider !== "openrouter" && provider !== "openai") return undefined;
  const apiKey = env.EMBEDDING_API_KEY?.trim() || env[modelProviderDefinition(provider).apiKeyEnv]?.trim();
  if (!apiKey) return undefined;
  const dimensions = Number(env.EMBEDDING_DIMENSIONS ?? DEFAULT_EMBEDDING_DIMENSIONS);
  if (!Number.isSafeInteger(dimensions) || dimensions !== DEFAULT_EMBEDDING_DIMENSIONS) return undefined;
  return new OpenAICompatibleEmbeddingProvider({
    provider,
    baseUrl: modelProviderDefinition(provider).baseUrl!,
    apiKey,
    model: env.EMBEDDING_MODEL?.trim() || DEFAULT_EMBEDDING_MODEL,
    dimensions,
    batchSize: Number(env.EMBEDDING_BATCH_SIZE ?? DEFAULT_EMBEDDING_BATCH_SIZE),
    timeoutMs: Number(env.EMBEDDING_TIMEOUT_MS ?? DEFAULT_EMBEDDING_TIMEOUT_MS),
  });
}

export async function embedSafely(provider: EmbeddingProvider | undefined, input: readonly string[]): Promise<number[][] | undefined> {
  if (!provider || !input.length) return undefined;
  try {
    return await provider.embed(input);
  } catch (error) {
    recordMemoryEmbedding({ provider: provider.provider, outcome: "fallback", count: input.length });
    operationalLogger.warn({
      event: "memory.embedding.failed",
      provider: provider.provider,
      model: provider.model,
      error_code: error instanceof Error ? error.name.slice(0, 80) : "unknown",
      fallback: "lexical",
    }, "Memory embedding failed; retaining lexical retrieval fallback");
    return undefined;
  }
}
