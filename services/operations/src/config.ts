export type Source = "growth" | "agents" | "agency" | "analytics";
export interface SourceConfig {
  id: string;
  source: Source;
  origin: string;
  secret: string;
  enabled: boolean;
  intervalSeconds: number;
}
export interface OperationsConfig {
  environment: string;
  databaseUrl: string;
  host: string;
  port: number;
  sources: SourceConfig[];
  collectionEnabled: boolean;
  evaluationEnabled: boolean;
  notificationsEnabled: boolean;
  notificationOrigin: string | null;
  notificationSecret: string | null;
  adminSecret: string | null;
  allowedOrigins: string[];
}
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): OperationsConfig {
  const environment =
    env.OPS_ENVIRONMENT ?? env.ENVIRONMENT ?? env.NODE_ENV ?? "development";
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(environment))
    throw new Error("Invalid ENVIRONMENT");
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL required");
  const raw: unknown = JSON.parse(env.OPS_SOURCES_JSON ?? "[]");
  if (!Array.isArray(raw) || raw.length > 4)
    throw new Error("Invalid OPS_SOURCES_JSON");
  const ids = new Set<string>();
  const products = new Set<string>();
  const sources = raw.map((s: Record<string, unknown>): SourceConfig => {
    if (
      !s ||
      typeof s !== "object" ||
      typeof s.id !== "string" ||
      !/^[a-z0-9_-]{1,64}$/.test(s.id) ||
      ids.has(s.id)
    )
      throw new Error("Invalid monitor id");
    ids.add(s.id);
    if (!["growth", "agents", "agency", "analytics"].includes(String(s.source)))
      throw new Error("Invalid source");
    if (products.has(String(s.source)))
      throw new Error("One fleet monitor per source is required");
    products.add(String(s.source));
    const origin = validateOrigin(String(s.origin), environment);
    if (typeof s.secret !== "string" || s.secret.length < 32)
      throw new Error("Observer key must be at least 32 characters");
    const intervalSeconds = Number(s.intervalSeconds ?? 60);
    if (
      !Number.isInteger(intervalSeconds) ||
      intervalSeconds < 10 ||
      intervalSeconds > 3600
    )
      throw new Error("Invalid polling interval");
    if (s.enabled !== undefined && typeof s.enabled !== "boolean")
      throw new Error("Invalid monitor enabled flag");
    return {
      id: s.id,
      source: s.source as Source,
      origin,
      secret: s.secret,
      enabled: s.enabled !== false,
      intervalSeconds,
    };
  });
  const notificationOrigin = env.OPS_NOTIFICATION_ORIGIN
    ? validateOrigin(env.OPS_NOTIFICATION_ORIGIN, environment)
    : null;
  const notificationSecret = env.OPS_NOTIFICATION_SECRET ?? null;
  if (notificationSecret && notificationSecret.length < 32)
    throw new Error("Invalid publisher key");
  const notificationsEnabled = env.OPS_NOTIFICATIONS_ENABLED === "true";
  if (notificationsEnabled && (!notificationOrigin || !notificationSecret))
    throw new Error("Notification destination/key required");
  if (
    env.OPS_ADMIN_AUTHORITY_SECRET &&
    env.OPS_ADMIN_AUTHORITY_SECRET.length < 32
  )
    throw new Error("Invalid human assertion key");
  const port = Number(env.PORT ?? 4400);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid PORT");
  return {
    environment,
    databaseUrl: env.DATABASE_URL,
    host: env.HOST ?? "127.0.0.1",
    port,
    sources,
    collectionEnabled: env.OPS_COLLECTION_ENABLED === "true",
    evaluationEnabled: env.OPS_EVALUATION_ENABLED === "true",
    notificationsEnabled,
    notificationOrigin,
    notificationSecret,
    adminSecret: env.OPS_ADMIN_AUTHORITY_SECRET ?? null,
    allowedOrigins: (env.OPS_ALLOWED_ORIGINS ?? "http://localhost:3001")
      .split(",")
      .map((s) => validateOrigin(s.trim(), environment)),
  };
}
export function validateOrigin(value: string, environment: string): string {
  const u = new URL(value);
  if (
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== "/" ||
    !["http:", "https:"].includes(u.protocol)
  )
    throw new Error("Invalid configured origin");
  if (
    u.protocol !== "https:" &&
    !(
      ["development", "test", "local"].includes(environment) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)
    )
  )
    throw new Error("HTTPS required outside local development");
  return u.origin;
}
