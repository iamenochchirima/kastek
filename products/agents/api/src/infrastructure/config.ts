import {createCursorCodec,cursorKeysFromEnvironment} from "./read-pages";
import { z } from "zod";

const configurationSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  AGENTS_DATABASE_URL: z.string().min(1),
  AGENTS_PUBLIC_URL: z.url().default("http://localhost:3100"),
  AGENTS_OIDC_ISSUER_URL: z.url().default("http://localhost:8080/realms/kasitek"),
  AGENTS_OIDC_CLIENT_ID: z.string().min(1).default("agents"),
  AGENTS_OIDC_CLIENT_SECRET: z.string().min(24),
  AGENTS_LOGIN_RETURN_SECRET: z.string().min(32).optional(),
  AGENTS_CURSOR_KEYS_JSON: z.string().optional(),
  AGENTS_CURSOR_ACTIVE_KEY_ID: z.string().optional(),
  AGENTS_CURSOR_MAX_AGE_SECONDS: z.coerce.number().int().min(60).max(86400).default(900),
  PORT: z.coerce.number().int().min(1).max(65_535).default(4100),
  HOST: z.string().default("127.0.0.1"),
  RESTATE_INGRESS_URL: z.url().default("http://localhost:18080"),
  RESTATE_ADMIN_URL: z.url().default("http://localhost:19070"),
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  BILLING_SERVICE_URL: z.url().optional(),
  BILLING_SERVICE_SECRET: z.string().min(32).optional(),
  BILLING_SNAPSHOT_SECRET: z.string().min(32).optional(),
  AGENTS_BILLING_ENFORCEMENT: z.string().optional(),
});
export type PlatformConfig = z.infer<typeof configurationSchema>;

export function loadPlatformConfig(environment: NodeJS.ProcessEnv = process.env): PlatformConfig {
  const config = configurationSchema.parse({ ...environment, OPENROUTER_API_KEY: environment.OPENROUTER_API_KEY?.trim() || undefined });
  createCursorCodec(cursorKeysFromEnvironment({...environment,NODE_ENV:config.NODE_ENV}));
  for (const [name, value] of [["public URL", config.AGENTS_PUBLIC_URL], ["issuer", config.AGENTS_OIDC_ISSUER_URL]] as const) {
    const url = new URL(value);
    if (url.username || url.password || url.hash || url.search ||
        (url.protocol !== "https:" && !(config.NODE_ENV !== "production" && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
      throw new Error(`Invalid ${name}: use HTTPS or a loopback development URL`);
    }
  }
  if (config.AGENTS_LOGIN_RETURN_SECRET === config.AGENTS_OIDC_CLIENT_SECRET) throw new Error("Use an independent AGENTS_LOGIN_RETURN_SECRET");
  if (new URL(config.AGENTS_PUBLIC_URL).pathname !== "/") throw new Error("AGENTS_PUBLIC_URL must be an origin");
  return config;
}
