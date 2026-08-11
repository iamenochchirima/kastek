import { z } from "zod";

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
  INTERNAL_AUTH_AUDIENCE: z.string().default("kasitek-agents"),
  AUTH_MODE: z.enum(["headers", "hmac"]).default("headers"),
  INTERNAL_AUTH_SECRET: z.string().optional(),
  KASITEK_CORE_URL: z.string().url().optional(),
  KASITEK_CORE_INTERNAL_TOKEN: z.string().optional(),
  KASITEK_CORE_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),
  MODEL_PRICING_JSON: z.string().optional(),
  AGENTS_CREDENTIAL_ENCRYPTION_KEY: z.string().optional(),
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
  return config;
}
