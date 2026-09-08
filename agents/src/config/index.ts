import { z } from "zod";
import { existsSync } from "node:fs";
import { MODEL_PROVIDERS } from "../model/types";
import { modelProviderEnvironmentKey } from "../model/providers";

// Local development uses agents/.env. Production environments inject variables directly.
// Node 22.12+ provides this built-in loader, so no dotenv dependency is required.
if (existsSync(".env")) process.loadEnvFile(".env");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4100),
  HOST: z.string().default("0.0.0.0"),
  AGENTS_DATABASE_URL: z.string().min(1),
  AGENTS_DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  TEMPORAL_ENABLED: z
    .string()
    .default("false")
    .transform((value) => value.toLowerCase() === "true"),
  TEMPORAL_MODE: z.enum(["cloud", "local"]).default("cloud"),
  TEMPORAL_ADDRESS: z.string().default("localhost:7233"),
  TEMPORAL_NAMESPACE: z.string().default("default"),
  TEMPORAL_TASK_QUEUE: z.string().default("kasitek-agents-interactive"),
  // Splits hosted loop progress at a durable activity boundary. Keep opt-in until production
  // evidence covers continuation, approval, cancellation, and provider reconciliation.
  TEMPORAL_STEP_ACTIVITIES_ENABLED: z.string().default("false").transform((value) => value.toLowerCase() === "true"),
  // The 2026 stateless path is enabled by default in development/test so it is
  // exercised locally, but remains opt-in in production until staging/client
  // evidence has been recorded. The pre-2026 compatibility path is always
  // retained during the migration window.
  MCP_STATELESS_ENABLED: z.enum(["true", "false"]).optional().transform((value) => value === undefined ? undefined : value === "true"),
  TEMPORAL_API_KEY: z.string().optional(),
  KASIAI_MODEL_PROVIDER: z.enum([...MODEL_PROVIDERS]).default("openrouter"),
  KASIAI_MODEL: z.string().trim().min(1).default("openai/gpt-4o-mini"),
  INTERNAL_AUTH_AUDIENCE: z.string().default("kasitek-agents"),
  AUTH_MODE: z.enum(["headers", "hmac"]).default("headers"),
  INTERNAL_AUTH_SECRET: z.string().optional(),
  KASITEK_CORE_URL: z.string().url().optional(),
  KASITEK_CORE_INTERNAL_TOKEN: z.string().optional(),
  KASITEK_CORE_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),
  KASITEK_CORE_PUBLISH_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).optional(),
  KASITEK_APP_URL: z.string().url().optional(),
  TELEGRAM_WEBHOOK_BASE_URL: z.string().url().optional(),
  TELEGRAM_API_BASE_URL: z.string().url().default("https://api.telegram.org"),
  TELEGRAM_API_TIMEOUT_MS: z.coerce.number().int().min(500).max(120_000).default(10_000),
  DISCORD_API_BASE_URL: z.string().url().default("https://discord.com/api/v10"),
  DISCORD_API_TIMEOUT_MS: z.coerce.number().int().min(500).max(120_000).default(10_000),
  ELEVENLABS_API_KEY: z.string().trim().optional(),
  ELEVENLABS_API_BASE_URL: z.string().url().default("https://api.elevenlabs.io"),
  ELEVENLABS_TRANSCRIPTION_MODEL: z.string().trim().min(1).max(80).default("scribe_v2"),
  ELEVENLABS_TRANSCRIPTION_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(300_000).default(120_000),
  AUDIO_TRANSCRIPTION_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  AUDIO_TRANSCRIPTION_WORKER_LEASE_MS: z.coerce.number().int().min(30_000).max(900_000).default(120_000),
  AUDIO_TRANSCRIPTION_WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(300_000).default(1_000),
  AUDIO_TRANSCRIPTION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  AUDIO_TRANSCRIPTION_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(0).max(300_000).default(2_000),
  AUDIO_TRANSCRIPTION_RETRY_MAX_DELAY_MS: z.coerce.number().int().min(0).max(3_600_000).default(300_000),
  DISCORD_GATEWAY_ENABLED: z.string().default("false").transform((value) => value.toLowerCase() === "true"),
  DISCORD_GATEWAY_POLL_INTERVAL_MS: z.coerce.number().int().min(5_000).max(3_600_000).default(60_000),
  DISCORD_GATEWAY_PLATFORM_URL: z.string().url().optional(),
  FIRECRAWL_API_KEY: z.string().trim().optional(),
  FIRECRAWL_API_BASE_URL: z.string().url().default("https://api.firecrawl.dev"),
  FIRECRAWL_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(60_000),
  TAVILY_API_KEY: z.string().trim().optional(),
  GOOGLE_CALENDAR_CLIENT_ID: z.string().trim().optional(),
  GOOGLE_CALENDAR_CLIENT_SECRET: z.string().trim().optional(),
  GOOGLE_CALENDAR_REDIRECT_URI: z.string().url().optional(),
  MCP_OAUTH_REDIRECT_URI: z.string().url().optional(),
  MCP_OAUTH_CLIENT_NAME: z.string().trim().min(1).max(120).default("KasiTek Agent Platform"),
  AGENT_INTEGRATIONS_RETURN_URL: z.string().url().optional(),
  MODEL_PRICING_JSON: z.string().optional(),
  CREDIT_BILLING_MODE: z.enum(["disabled", "shadow", "enforced"]).default("disabled"),
  CREDIT_USD_TO_CREDITS: z.coerce.number().positive().default(1000),
  CREDIT_PRICING_VERSION: z.string().trim().min(1).max(80).default("model-cost-v1"),
  AGENTS_CREDENTIAL_ENCRYPTION_KEY: z.string().optional(),
  INSTALLATION_TOKEN_PRIVATE_KEY: z.string().optional(),
  INSTALLATION_TOKEN_ISSUER: z.string().default("kasitek-agents"),
  KASITEK_CORE_DELEGATION_PRIVATE_KEY: z.string().optional(),
  /** Stable identifier for the currently active core-delegation signing key. */
  KASITEK_CORE_DELEGATION_KEY_ID: z.string().trim().min(1).max(128).optional(),
  KASITEK_CORE_DELEGATION_ISSUER: z.string().default("kasitek-agents"),
  KASITEK_CORE_DELEGATION_AUDIENCE: z.string().default("kasitek-core-internal"),
  AGENT_GATEWAY_SHARED_SECRET: z.string().optional(),
  APPROVAL_DECISION_RATE_LIMIT_PER_WINDOW: z.coerce.number().int().min(1).max(1000).default(5),
  APPROVAL_DECISION_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).max(3_600_000).default(60_000),
  APPROVAL_DECISION_RATE_LIMIT_MAX_KEYS: z.coerce.number().int().min(1).max(100_000).default(10_000),
  EFFECT_RECONCILIATION_INTERVAL_MS: z.coerce.number().int().min(10_000).max(3_600_000).default(60_000),
  RUN_BUDGET_RECONCILIATION_AGE_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(300_000),
  RUN_BUDGET_RECONCILIATION_LIMIT: z.coerce.number().int().min(1).max(500).default(100),
  AGENT_READINESS_EVALUATION_INTERVAL_MS: z.coerce.number().int().min(30_000).max(86_400_000).default(300_000),
  AGENT_READINESS_EVALUATION_BATCH_SIZE: z.coerce.number().int().min(1).max(1_000).default(50),
  AGENT_READINESS_EVALUATION_LEASE_MS: z.coerce.number().int().min(30_000).max(3_600_000).default(900_000),
  MEMORY_CONSOLIDATION_ENABLED: z.string().default("true").transform((value) => value.toLowerCase() === "true"),
  MEMORY_CONSOLIDATION_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  MEMORY_CONSOLIDATION_WORKER_LEASE_MS: z.coerce.number().int().min(30_000).max(900_000).default(120_000),
  MEMORY_CONSOLIDATION_WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(300_000).default(5_000),
  MEMORY_CONSOLIDATION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  MEMORY_CONSOLIDATION_MIN_INBOUND_MESSAGES: z.coerce.number().int().min(2).max(50).default(4),
  MEMORY_CONSOLIDATION_EXTRACTOR_TIMEOUT_MS: z.coerce.number().int().min(100).max(300_000).default(30_000),
  MEMORY_CONSOLIDATION_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(100).max(300_000).default(30_000),
  // Global application rollback switch for the additive memory-v2 runtime path. When disabled,
  // runtime tools and checkpoint/retrieval/source-capture ports stay on the legacy compatibility
  // path while the additive schema and workers remain available for recovery.
  MEMORY_V2_ENABLED: z.string().default("true").transform((value) => value.toLowerCase() === "true"),
  MEMORY_RETRIEVAL_GATE_ENABLED: z.string().default("true").transform((value) => value.toLowerCase() === "true"),
  MEMORY_RETRIEVAL_GATE_TIMEOUT_MS: z.coerce.number().int().min(100).max(5_000).default(900),
  MEMORY_RETRIEVAL_GATE_MIN_CONFIDENCE: z.coerce.number().min(0.5).max(0.99).default(0.7),
  MEMORY_PROJECTION_ENABLED: z.string().default("true").transform((value) => value.toLowerCase() === "true"),
  MEMORY_PROJECTION_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  MEMORY_PROJECTION_WORKER_LEASE_MS: z.coerce.number().int().min(30_000).max(900_000).default(120_000),
  MEMORY_PROJECTION_WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(300_000).default(5_000),
  MEMORY_PROJECTION_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(2_000),
  MEMORY_PROJECTION_RETRY_MAX_DELAY_MS: z.coerce.number().int().min(1_000).max(86_400_000).default(300_000),
  MEMORY_PROVIDER_DELETION_ENABLED: z.string().default("true").transform((value) => value.toLowerCase() === "true"),
  MEMORY_PROVIDER_DELETION_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  MEMORY_PROVIDER_DELETION_WORKER_LEASE_MS: z.coerce.number().int().min(30_000).max(900_000).default(120_000),
  MEMORY_PROVIDER_DELETION_WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(300_000).default(5_000),
  MEMORY_PROVIDER_DELETION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(8),
  MEMORY_PROVIDER_DELETION_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(2_000),
  MEMORY_PROVIDER_DELETION_RETRY_MAX_DELAY_MS: z.coerce.number().int().min(1_000).max(86_400_000).default(300_000),
  MEMORY_DELETION_ENABLED: z.string().default("true").transform((value) => value.toLowerCase() === "true"),
  MEMORY_DELETION_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  MEMORY_DELETION_WORKER_LEASE_MS: z.coerce.number().int().min(30_000).max(900_000).default(120_000),
  MEMORY_DELETION_WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(300_000).default(5_000),
  MEMORY_DELETION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  MEMORY_DELETION_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(0).max(300_000).default(2_000),
  MEMORY_DELETION_RETRY_MAX_DELAY_MS: z.coerce.number().int().min(0).max(3_600_000).default(300_000),
  MEMORY_DELETION_HOLD_RETRY_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
  MEMORY_RETENTION_ENABLED: z.string().default("true").transform((value) => value.toLowerCase() === "true"),
  MEMORY_RETENTION_WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(10),
  MEMORY_RETENTION_WORKER_LEASE_MS: z.coerce.number().int().min(30_000).max(900_000).default(120_000),
  MEMORY_RETENTION_WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(250).max(300_000).default(30_000),
  MEMORY_RETENTION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  MEMORY_RETENTION_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(0).max(300_000).default(2_000),
  MEMORY_RETENTION_RETRY_MAX_DELAY_MS: z.coerce.number().int().min(0).max(3_600_000).default(300_000),
  MEMORY_RETENTION_INTERVAL_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(3_600_000),
  MEMORY_REVALIDATION_INTERVAL_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(900_000),
  MEMORY_CONFLICT_INTERVAL_MS: z.coerce.number().int().min(60_000).max(86_400_000).default(300_000),
  MEMORY_RETENTION_CANDIDATE_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(250),
  EMBEDDINGS_ENABLED: z.string().default("false").transform((value) => value.toLowerCase() === "true"),
  EMBEDDING_PROVIDER: z.enum(["openrouter", "openai"]).default("openrouter"),
  EMBEDDING_MODEL: z.string().trim().min(1).max(160).default("openai/text-embedding-3-small"),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().refine((value) => value === 1536, "EMBEDDING_DIMENSIONS must be 1536 for the released vector index").default(1536),
  EMBEDDING_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(32),
  EMBEDDING_TIMEOUT_MS: z.coerce.number().int().min(500).max(120_000).default(10_000),
  ANALYTICS_INGESTION_URL: z.string().url().default("http://127.0.0.1:4300"),
  ANALYTICS_AGENT_INGESTION_TOKEN: z.string().trim().min(1).optional(),
  ANALYTICS_AGENT_PRODUCER_ID: z.string().trim().min(1).default("agent-platform-customer-analytics"),
  ANALYTICS_AGENT_PUBLISHER_ID: z.string().trim().min(1).default("agent-platform-analytics-publisher"),
  ANALYTICS_PUBLISHER_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(100),
  ANALYTICS_PUBLISHER_LEASE_DURATION_MS: z.coerce.number().int().min(1).max(300_000).default(30_000),
  ANALYTICS_PUBLISHER_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),
  ANALYTICS_PUBLISHER_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(300_000).default(1_000),
  ANALYTICS_PUBLISHER_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(0).max(300_000).default(2_000),
  ANALYTICS_PUBLISHER_RETRY_MAX_DELAY_MS: z.coerce.number().int().min(0).max(3_600_000).default(300_000),
  ANALYTICS_PUBLISHER_RETRY_JITTER_MS: z.coerce.number().int().min(0).max(60_000).default(2_000),
  LOG_LEVEL: z.string().default("info"),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(env);
  const config = {
    ...parsed,
    KASITEK_CORE_PUBLISH_TIMEOUT_MS: parsed.KASITEK_CORE_PUBLISH_TIMEOUT_MS ?? 30_000,
    MCP_STATELESS_ENABLED: parsed.MCP_STATELESS_ENABLED ?? parsed.NODE_ENV !== "production",
  };
  if (config.NODE_ENV === "production" && !config.TEMPORAL_ENABLED) {
    throw new Error("TEMPORAL_ENABLED must be true in production");
  }
  if (config.NODE_ENV === "production" && config.AUTH_MODE !== "hmac") {
    throw new Error("AUTH_MODE=hmac is required in production");
  }
  if (config.AUTH_MODE === "hmac" && !config.INTERNAL_AUTH_SECRET) {
    throw new Error("INTERNAL_AUTH_SECRET is required when AUTH_MODE=hmac");
  }
  if (config.KASITEK_CORE_URL && !config.KASITEK_CORE_INTERNAL_TOKEN && !config.KASITEK_CORE_DELEGATION_PRIVATE_KEY) {
    throw new Error("KASITEK_CORE_INTERNAL_TOKEN or KASITEK_CORE_DELEGATION_PRIVATE_KEY is required when KASITEK_CORE_URL is configured");
  }
  if (config.NODE_ENV === "production") {
    const credentialKey = modelProviderEnvironmentKey(config.KASIAI_MODEL_PROVIDER)!;
    if (!env[credentialKey]?.trim()) {
      throw new Error(`${credentialKey} is required for the configured KasiAi model provider`);
    }
    if (!config.INSTALLATION_TOKEN_PRIVATE_KEY) {
      throw new Error("INSTALLATION_TOKEN_PRIVATE_KEY is required in production");
    }
  }
  return config;
}
