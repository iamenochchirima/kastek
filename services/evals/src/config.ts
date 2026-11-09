import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  databaseKey,
  parseDatabaseUrl,
  SandboxGuardError,
  validateSandboxEnvironment,
  type SandboxEnvironment,
} from "./guard.js";

export interface EvalsConfig extends SandboxEnvironment {
  databaseUrl: string;
  host: string;
  port: number;
  operatorToken: string;
  repoRoot: string;
  codeRevisionOverride?: string;
  imageDigest: string;
  runtimeVersion: string;
  modelId: string;
  adapterVersions: Record<string, string>;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new SandboxGuardError(
      "CONFIGURATION_MISSING",
      `${name} is required`,
    );
  }
  return value;
}

function integer(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  if (value == null || value.trim() === "") return fallback;
  if (!/^\+?\d+$/.test(value.trim())) {
    throw new SandboxGuardError(
      "CONFIGURATION_INVALID",
      `${name} must be an integer`,
    );
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new SandboxGuardError(
      "CONFIGURATION_INVALID",
      `${name} is out of range`,
    );
  }
  return parsed;
}

function adapterVersions(
  value: string | undefined,
  fallback: Record<string, string>,
): Record<string, string> {
  if (value == null || value.trim() === "") return fallback;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new SandboxGuardError(
      "ADAPTER_VERSIONS_INVALID",
      "EVALS_ADAPTER_VERSIONS must be a JSON object",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SandboxGuardError(
      "ADAPTER_VERSIONS_INVALID",
      "EVALS_ADAPTER_VERSIONS must be a JSON object",
    );
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(parsed)) {
    if (
      !/^[a-z][a-z0-9_-]{0,63}$/.test(key) ||
      typeof item !== "string" ||
      !item.trim() ||
      item.length > 200
    ) {
      throw new SandboxGuardError(
        "ADAPTER_VERSIONS_INVALID",
        "EVALS_ADAPTER_VERSIONS must contain bounded string versions",
      );
    }
    result[key] = item.trim();
  }
  if (!Object.keys(result).length) {
    throw new SandboxGuardError(
      "ADAPTER_VERSIONS_INVALID",
      "EVALS_ADAPTER_VERSIONS must not be empty",
    );
  }
  return result;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): EvalsConfig {
  const sandbox = validateSandboxEnvironment(env);
  const databaseUrl = required(env, "EVALS_DATABASE_URL");
  const controlDatabase = parseDatabaseUrl(databaseUrl, "EVALS_DATABASE_URL");
  if (
    databaseKey(controlDatabase) === databaseKey(sandbox.evalDatabase) ||
    databaseKey(controlDatabase) === databaseKey(sandbox.productDatabase)
  ) {
    throw new SandboxGuardError(
      "CONTROL_DATABASE_NOT_ISOLATED",
      "Control-plane database must differ from sandbox and product databases",
    );
  }

  const operatorToken = required(env, "EVALS_OPERATOR_TOKEN");
  if (Buffer.byteLength(operatorToken) < 32) {
    throw new SandboxGuardError(
      "OPERATOR_TOKEN_WEAK",
      "EVALS_OPERATOR_TOKEN requires at least 32 bytes",
    );
  }

  const repoRoot = env.EVALS_REPO_ROOT?.trim()
    ? resolve(env.EVALS_REPO_ROOT)
    : fileURLToPath(new URL("../../../", import.meta.url));
  const codeRevisionOverride = env.EVALS_CODE_REVISION?.trim() || undefined;
  if (codeRevisionOverride != null && codeRevisionOverride.length > 200) {
    throw new SandboxGuardError(
      "CODE_REVISION_INVALID",
      "EVALS_CODE_REVISION is too long",
    );
  }

  const imageDigest = (env.EVALS_IMAGE_DIGEST ?? "local-build").trim();
  const runtimeVersion = (env.EVALS_RUNTIME_VERSION ?? "1.7.13").trim();
  const modelId = (env.EVALS_MODEL_ID ?? "deterministic-provider-fixture").trim();
  if (!imageDigest || !runtimeVersion || !modelId) {
    throw new SandboxGuardError(
      "VERSION_MANIFEST_INCOMPLETE",
      "Image, runtime and model identifiers must not be empty",
    );
  }

  return {
    ...sandbox,
    databaseUrl,
    host: env.EVALS_HOST?.trim() || "127.0.0.1",
    port: integer(env.EVALS_PORT, 4600, "EVALS_PORT"),
    operatorToken,
    repoRoot,
    codeRevisionOverride,
    imageDigest,
    runtimeVersion,
    modelId,
    adapterVersions: adapterVersions(env.EVALS_ADAPTER_VERSIONS, {
      core: "1",
      harbor: env.AGENTS_HARBOR_VERSION?.trim() || "0.24.0",
    }),
  };
}
