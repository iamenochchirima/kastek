import { z } from "zod";
import { existsSync } from "node:fs";

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
  TEMPORAL_API_KEY: z.string().optional(),
  KASIAI_MODEL_PROVIDER: z.enum(["openrouter", "openai", "anthropic", "gemini"]).default("openrouter"),
  KASIAI_MODEL: z.string().trim().min(1).default("openai/gpt-4o-mini"),
  INTERNAL_AUTH_AUDIENCE: z.string().default("kasitek-agents"),
  AUTH_MODE: z.enum(["headers", "hmac"]).default("headers"),
  INTERNAL_AUTH_SECRET: z.string().optional(),
  KASITEK_CORE_URL: z.string().url().optional(),
  KASITEK_CORE_INTERNAL_TOKEN: z.string().optional(),
  KASITEK_CORE_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),
  MODEL_PRICING_JSON: z.string().optional(),
  AGENTS_CREDENTIAL_ENCRYPTION_KEY: z.string().optional(),
  INSTALLATION_TOKEN_PRIVATE_KEY: z.string().optional(),
  INSTALLATION_TOKEN_ISSUER: z.string().default("kasitek-agents"),
  KASITEK_CORE_DELEGATION_PRIVATE_KEY: z.string().optional(),
  KASITEK_CORE_DELEGATION_ISSUER: z.string().default("kasitek-agents"),
  KASITEK_CORE_DELEGATION_AUDIENCE: z.string().default("kasitek-core-internal"),
  LOG_LEVEL: z.string().default("info"),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const config = envSchema.parse(env);
  if (config.NODE_ENV === "production" && !config.TEMPORAL_ENABLED) {
    throw new Error("TEMPORAL_ENABLED must be true in production");
  }
  if (config.NODE_ENV === "production" && config.AUTH_MODE !== "hmac") {
    throw new Error("AUTH_MODE=hmac is required in production");
  }
  if (config.AUTH_MODE === "hmac" && !config.INTERNAL_AUTH_SECRET) {
    throw new Error("INTERNAL_AUTH_SECRET is required when AUTH_MODE=hmac");
  }
  if (config.KASITEK_CORE_URL && !config.KASITEK_CORE_INTERNAL_TOKEN) {
    throw new Error("KASITEK_CORE_INTERNAL_TOKEN is required when KASITEK_CORE_URL is configured");
  }
  if (config.NODE_ENV === "production") {
    const credentialKey = {
      openrouter: "OPENROUTER_API_KEY",
      openai: "OPENAI_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
      gemini: "GEMINI_API_KEY",
    }[config.KASIAI_MODEL_PROVIDER];
    if (!env[credentialKey]?.trim()) {
      throw new Error(`${credentialKey} is required for the configured KasiAi model provider`);
    }
    if (!config.INSTALLATION_TOKEN_PRIVATE_KEY) {
      throw new Error("INSTALLATION_TOKEN_PRIVATE_KEY is required in production");
    }
  }
  return config;
}
