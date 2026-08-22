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
  TELEGRAM_WEBHOOK_BASE_URL: z.string().url().optional(),
  TELEGRAM_API_BASE_URL: z.string().url().default("https://api.telegram.org"),
  TELEGRAM_API_TIMEOUT_MS: z.coerce.number().int().min(500).max(120_000).default(10_000),
  MODEL_PRICING_JSON: z.string().optional(),
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
