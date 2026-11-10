import type { BillingProduct } from "@kasitek-labs/contracts";

export interface BillingConfig {
  environment: string;
  databaseUrl: string;
  host: string;
  port: number;
  publicUrl: string;
  internalSecret: string;
  snapshotSecret: string;
  sandboxSecret: string | null;
  adminSecret: string | null;
  adminAudience: string;
  paystack: {
    mode: "test" | "live";
    secret: string;
    baseUrl: string;
  } | null;
  defaultCurrency: string;
  taxRateBps: number;
  invoicePrefix: string;
  reconciliationIntervalSeconds: number;
  reconciliationBatchSize: number;
  returnOrigins: string[];
  freePlans: Partial<Record<BillingProduct, string>>;
  trialPlans: Partial<Record<BillingProduct, string>>;
  trialDays: number;
  snapshotTtlSeconds: number;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function secret(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  if (Buffer.byteLength(value) < 32)
    throw new Error(`${name} requires at least 32 bytes`);
  return value;
}

function integer(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (value == null || value.trim() === "") return fallback;
  if (!/^\+?\d+$/.test(value.trim()))
    throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw new Error(`${name} is out of range`);
  return parsed;
}

function origin(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Configured URL must be an absolute HTTP(S) origin");
  return url.origin;
}

function planMap(
  value: string | undefined,
  name: string,
): Partial<Record<BillingProduct, string>> {
  if (!value) return {};
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error(`${name} must be an object`);
  const result: Partial<Record<BillingProduct, string>> = {};
  for (const product of ["growth", "agents", "agency"] as const) {
    const key = (parsed as Record<string, unknown>)[product];
    if (key === undefined) continue;
    if (typeof key !== "string" || !/^[a-z0-9._-]{1,80}$/.test(key))
      throw new Error(`Invalid plan key for ${product}`);
    result[product] = key;
  }
  return result;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BillingConfig {
  const environment = env.BILLING_ENVIRONMENT ?? env.ENVIRONMENT ?? env.NODE_ENV ?? "development";
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(environment))
    throw new Error("Invalid environment");
  const databaseUrl = env.BILLING_DATABASE_URL ?? env.DATABASE_URL;
  if (!databaseUrl) throw new Error("BILLING_DATABASE_URL is required");

  const mode = (env.PAYSTACK_MODE?.trim().toLowerCase() || "test") as "test" | "live";
  if (!["test", "live"].includes(mode))
    throw new Error("PAYSTACK_MODE must be test or live");
  const paystackKey =
    mode === "live" ? env.PAYSTACK_LIVE_SECRET_KEY?.trim() : env.PAYSTACK_TEST_SECRET_KEY?.trim();
  if (mode === "live" && !paystackKey)
    throw new Error("PAYSTACK_LIVE_SECRET_KEY is required in live mode");

  const port = integer(env.BILLING_PORT ?? env.PORT, 4500, 1, 65_535, "BILLING_PORT");
  const publicUrl = origin(env.BILLING_PUBLIC_URL ?? `http://localhost:${port}`);
  const returnOrigins = (env.BILLING_RETURN_ORIGINS ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map(origin);
  if (!returnOrigins.length)
    throw new Error("BILLING_RETURN_ORIGINS must contain at least one origin");

  const sandboxSecret = env.BILLING_SANDBOX_SECRET?.trim() || null;
  if (sandboxSecret && Buffer.byteLength(sandboxSecret) < 32)
    throw new Error("BILLING_SANDBOX_SECRET requires at least 32 bytes");
  if (sandboxSecret && environment === "production")
    throw new Error("Sandbox billing secret is unavailable in production");

  return {
    environment,
    databaseUrl,
    host: env.BILLING_HOST ?? "127.0.0.1",
    port,
    publicUrl,
    internalSecret: secret(env, "BILLING_INTERNAL_SECRET"),
    snapshotSecret: secret(env, "BILLING_SNAPSHOT_SECRET"),
    sandboxSecret,
    adminSecret: env.KASITEK_ADMIN_SERVICE_SECRET?.trim() || null,
    adminAudience: env.BILLING_ADMIN_AUDIENCE ?? "billing",
    paystack: paystackKey
      ? {
          mode,
          secret: paystackKey,
          baseUrl: (env.PAYSTACK_API_BASE_URL ?? "https://api.paystack.co").replace(/\/+$/, ""),
        }
      : null,
    defaultCurrency: (env.BILLING_DEFAULT_CURRENCY ?? "ZAR").trim().toUpperCase(),
    taxRateBps: integer(env.BILLING_TAX_RATE_BPS, 1500, 0, 10_000, "BILLING_TAX_RATE_BPS"),
    invoicePrefix: (env.BILLING_INVOICE_PREFIX ?? "KS").trim().toUpperCase(),
    reconciliationIntervalSeconds: integer(
      env.BILLING_RECONCILIATION_INTERVAL_SECONDS,
      300,
      30,
      86_400,
      "BILLING_RECONCILIATION_INTERVAL_SECONDS",
    ),
    reconciliationBatchSize: integer(
      env.BILLING_RECONCILIATION_BATCH_SIZE,
      100,
      1,
      500,
      "BILLING_RECONCILIATION_BATCH_SIZE",
    ),
    returnOrigins,
    freePlans: planMap(env.BILLING_FREE_PLANS_JSON, "BILLING_FREE_PLANS_JSON"),
    trialPlans: planMap(env.BILLING_TRIAL_PLANS_JSON, "BILLING_TRIAL_PLANS_JSON"),
    trialDays: integer(env.BILLING_TRIAL_DAYS, 14, 1, 365, "BILLING_TRIAL_DAYS"),
    snapshotTtlSeconds: integer(
      env.BILLING_SNAPSHOT_TTL_SECONDS,
      300,
      30,
      3600,
      "BILLING_SNAPSHOT_TTL_SECONDS",
    ),
  };
}

export function assertReturnUrl(url: string, origins: string[]): string {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol))
    throw new Error("Checkout return URL must be HTTP(S)");
  if (!origins.includes(parsed.origin))
    throw new Error("Checkout return URL origin is not allowed");
  return parsed.toString();
}
