import "../telemetry";
import { shutdownTelemetry } from "../telemetry";
import { existsSync } from "node:fs";
import { z } from "zod";
import { buildGateway } from "./app";

// Keep local gateway startup consistent with the Agent API and worker.
// Deployment environments inject values directly; local development uses the
// repository-root .env.
if (typeof process.loadEnvFile === "function" && existsSync(".env")) process.loadEnvFile(".env");

const config = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  GATEWAY_HOST: z.string().default(process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1"),
  GATEWAY_PORT: z.coerce.number().int().min(1).max(65535).default(4200),
  AGENT_PLATFORM_URL: z.string().url().default("http://127.0.0.1:4100"),
  AGENT_GATEWAY_SHARED_SECRET: z.string().optional(),
  MCP_GATEWAY_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  MCP_GATEWAY_STATELESS_ENABLED: z.enum(["true", "false"]).default(process.env.NODE_ENV === "production" ? "false" : "true").transform((value) => value === "true"),
  MCP_GATEWAY_RATE_LIMIT_PER_WINDOW: z.coerce.number().int().min(1).default(120),
  MCP_GATEWAY_PREAUTH_RATE_LIMIT_PER_WINDOW: z.coerce.number().int().min(1).default(60),
  MCP_GATEWAY_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).default(60_000),
  MCP_GATEWAY_RATE_LIMIT_MAX_KEYS: z.coerce.number().int().min(1).default(10_000),
  MCP_GATEWAY_UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(15_000),
  MCP_GATEWAY_ALLOWED_ORIGINS: z.string().default("").transform((value) => value.split(",").map((origin) => origin.trim()).filter(Boolean)),
}).parse(process.env);

const app = buildGateway({
  agentPlatformUrl: config.AGENT_PLATFORM_URL,
  sharedSecret: config.AGENT_GATEWAY_SHARED_SECRET,
  environment: config.NODE_ENV,
  enabled: config.MCP_GATEWAY_ENABLED,
  statelessEnabled: config.MCP_GATEWAY_STATELESS_ENABLED,
  rateLimitPerWindow: config.MCP_GATEWAY_RATE_LIMIT_PER_WINDOW,
  preAuthRateLimitPerWindow: config.MCP_GATEWAY_PREAUTH_RATE_LIMIT_PER_WINDOW,
  rateLimitWindowMs: config.MCP_GATEWAY_RATE_LIMIT_WINDOW_MS,
  rateLimitMaxKeys: config.MCP_GATEWAY_RATE_LIMIT_MAX_KEYS,
  upstreamTimeoutMs: config.MCP_GATEWAY_UPSTREAM_TIMEOUT_MS,
  allowedOrigins: config.MCP_GATEWAY_ALLOWED_ORIGINS,
  logLevel: process.env.LOG_LEVEL,
});

const close = async (): Promise<void> => {
  await app.close();
  await shutdownTelemetry();
};
process.once("SIGINT", () => void close().finally(() => process.exit(0)));
process.once("SIGTERM", () => void close().finally(() => process.exit(0)));

app.listen({ host: config.GATEWAY_HOST, port: config.GATEWAY_PORT }).catch((error) => {
  app.log.error(error);
  process.exitCode = 1;
});
