export interface DatabaseIdentity {
  host: string;
  port: number;
  database: string;
  role: string;
}

export interface SandboxEnvironment {
  environment: string;
  evalDatabase: DatabaseIdentity;
  productDatabase: DatabaseIdentity;
  billingEnforcement: "sandbox";
  modelMode: "deterministic";
  identityMode: "seed";
  networkPolicy: "loopback";
}

export class SandboxGuardError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SandboxGuardError";
  }
}

function fail(code: string, message: string): never {
  throw new SandboxGuardError(code, message);
}

function required(
  env: NodeJS.ProcessEnv,
  names: readonly string[],
  label: string,
): string {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return fail("CONFIGURATION_MISSING", `${label} is required`);
}

export function parseDatabaseUrl(
  value: string,
  name: string,
): DatabaseIdentity {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail("DATABASE_URL_INVALID", `${name} must be a valid PostgreSQL URL`);
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    return fail("DATABASE_URL_INVALID", `${name} must use the postgres protocol`);
  }
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!database || database.includes("/")) {
    return fail("DATABASE_URL_INVALID", `${name} must name one database`);
  }
  const role = decodeURIComponent(url.username);
  if (!role) {
    return fail("DATABASE_URL_INVALID", `${name} must include a database role`);
  }
  const port = url.port ? Number(url.port) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return fail("DATABASE_URL_INVALID", `${name} has an invalid port`);
  }
  const host = url.hostname.toLowerCase() === "localhost"
    ? "127.0.0.1"
    : url.hostname.toLowerCase();
  if (!host) {
    return fail("DATABASE_URL_INVALID", `${name} must include a host`);
  }
  return { host, port, database, role };
}

export function databaseKey(database: DatabaseIdentity): string {
  return `${database.host}:${database.port}/${database.database}`;
}

/**
 * Fail closed before the service creates or inspects a sandbox. The persistent
 * Phase 1 sandbox uses the base agents_evals database. Per-run databases remain
 * a fixture-only mode for destructive tests and are not accepted here.
 */
export function validateSandboxEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): SandboxEnvironment {
  const environment = (env.EVALS_ENVIRONMENT ?? "local").trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(environment)) {
    return fail("ENVIRONMENT_INVALID", "EVALS_ENVIRONMENT is invalid");
  }
  if (["production", "prod"].includes(environment)) {
    return fail(
      "PRODUCTION_ENVIRONMENT",
      "Sandbox control plane cannot run in production",
    );
  }

  const evalDatabase = parseDatabaseUrl(
    required(env, ["AGENTS_EVALS_DATABASE_URL"], "AGENTS_EVALS_DATABASE_URL"),
    "AGENTS_EVALS_DATABASE_URL",
  );
  const productDatabase = parseDatabaseUrl(
    required(
      env,
      ["AGENTS_PRODUCT_DATABASE_URL", "AGENTS_DATABASE_URL"],
      "AGENTS_PRODUCT_DATABASE_URL",
    ),
    "AGENTS_PRODUCT_DATABASE_URL",
  );

  if (evalDatabase.database !== "agents_evals") {
    return fail(
      "NON_PERSISTENT_EVAL_DATABASE",
      "Phase 1 requires the persistent agents_evals database",
    );
  }
  if (evalDatabase.role === "postgres") {
    return fail(
      "SUPERUSER_ROLE",
      "Sandbox database must not use the postgres superuser role",
    );
  }
  if (databaseKey(evalDatabase) === databaseKey(productDatabase)) {
    return fail(
      "PRODUCTION_DATABASE",
      "Sandbox database must differ from the product database",
    );
  }
  if ((env.EVALS_MODEL_MODE ?? "deterministic") !== "deterministic") {
    return fail(
      "LIVE_MODEL_NOT_ALLOWED",
      "Phase 1 sandbox only supports the deterministic provider",
    );
  }
  if (
    env.AGENTS_HARBOR_REAL_MODEL === "1" ||
    env.EVALS_ALLOW_LIVE_MODEL === "1"
  ) {
    return fail(
      "LIVE_MODEL_NOT_ALLOWED",
      "Phase 1 sandbox cannot use live model credentials",
    );
  }
  if ((env.EVALS_IDENTITY_MODE ?? "seed") !== "seed") {
    return fail(
      "PRODUCTION_IDENTITY",
      "Phase 1 sandbox only supports the isolated seed identity",
    );
  }
  if ((env.EVALS_NETWORK_POLICY ?? "loopback") !== "loopback") {
    return fail(
      "OPEN_NETWORK_POLICY",
      "Phase 1 sandbox only supports the loopback network policy",
    );
  }

  return {
    environment,
    evalDatabase,
    productDatabase,
    billingEnforcement: "sandbox",
    modelMode: "deterministic",
    identityMode: "seed",
    networkPolicy: "loopback",
  };
}
