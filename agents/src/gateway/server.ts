import { z } from "zod";
import { buildGateway } from "./app";

// Keep local gateway startup consistent with the Agent API and worker. Deployment
// environments inject these values directly, while local development uses agents/.env.
if (typeof process.loadEnvFile === "function") process.loadEnvFile(".env");

const config = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  GATEWAY_HOST: z.string().default("0.0.0.0"),
  GATEWAY_PORT: z.coerce.number().int().min(1).max(65535).default(4200),
  AGENT_PLATFORM_URL: z.string().url().default("http://127.0.0.1:4100"),
  AGENT_GATEWAY_SHARED_SECRET: z.string().optional(),
  MCP_GATEWAY_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  MCP_GATEWAY_RATE_LIMIT_PER_WINDOW: z.coerce.number().int().min(1).default(120),
  MCP_GATEWAY_PREAUTH_RATE_LIMIT_PER_WINDOW: z.coerce.number().int().min(1).default(60),
  MCP_GATEWAY_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1_000).default(60_000),
  MCP_GATEWAY_RATE_LIMIT_MAX_KEYS: z.coerce.number().int().min(1).default(10_000),
  MCP_GATEWAY_UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(15_000),
}).parse(process.env);

const app = buildGateway({
  agentPlatformUrl: config.AGENT_PLATFORM_URL,
  sharedSecret: config.AGENT_GATEWAY_SHARED_SECRET,
  environment: config.NODE_ENV,
  enabled: config.MCP_GATEWAY_ENABLED,
  rateLimitPerWindow: config.MCP_GATEWAY_RATE_LIMIT_PER_WINDOW,
  preAuthRateLimitPerWindow: config.MCP_GATEWAY_PREAUTH_RATE_LIMIT_PER_WINDOW,
  rateLimitWindowMs: config.MCP_GATEWAY_RATE_LIMIT_WINDOW_MS,
  rateLimitMaxKeys: config.MCP_GATEWAY_RATE_LIMIT_MAX_KEYS,
  upstreamTimeoutMs: config.MCP_GATEWAY_UPSTREAM_TIMEOUT_MS,
});

app.listen({ host: config.GATEWAY_HOST, port: config.GATEWAY_PORT }).catch((error) => {
  app.log.error(error);
  process.exitCode = 1;
});
