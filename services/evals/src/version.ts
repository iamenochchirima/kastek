import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvalsConfig } from "./config.js";
import { SandboxGuardError } from "./guard.js";

export interface SandboxManifest {
  codeRevision: string;
  imageDigest: string;
  schemaVersion: string;
  migrationChecksum: string;
  configDigest: string;
  runtimeVersion: string;
  modelRoutesDigest: string;
  adapterVersions: Record<string, string>;
}

export interface SandboxManifestOverrides {
  codeRevision?: string;
  imageDigest?: string;
  schemaVersion?: string;
  migrationChecksum?: string;
  configDigest?: string;
  runtimeVersion?: string;
  modelRoutesDigest?: string;
  adapterVersions?: Record<string, string>;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

function text(value: string | undefined, name: string, max: number): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length > max) {
    throw new SandboxGuardError(
      "VERSION_MANIFEST_INCOMPLETE",
      `${name} must be between 1 and ${max} characters`,
    );
  }
  return normalized;
}

function checksum(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized || !/^[a-f0-9]{64}$/.test(normalized)) {
    throw new SandboxGuardError(
      "VERSION_MANIFEST_INCOMPLETE",
      `${name} must be a SHA-256 checksum`,
    );
  }
  return normalized;
}

async function agentsSchema(
  repoRoot: string,
): Promise<{ schemaVersion: string; migrationChecksum: string }> {
  const directory = join(repoRoot, "products/agents/api/schema");
  const files = (await readdir(directory))
    .filter((name) => /^\d+_[a-z_]+\.sql$/.test(name))
    .sort();
  if (!files.length) {
    throw new SandboxGuardError(
      "VERSION_MANIFEST_INCOMPLETE",
      "Agents schema migrations were not found",
    );
  }
  const contents = await Promise.all(
    files.map((name) => readFile(join(directory, name), "utf8")),
  );
  return {
    schemaVersion: "001_platform",
    migrationChecksum: digest(contents.join("\n")),
  };
}

function gitRevision(repoRoot: string): string {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
    if (!/^[a-f0-9]{40}$/.test(head)) throw new Error("Unexpected git revision");
    const dirty = execFileSync("git", ["status", "--porcelain"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
    return `${head}${dirty ? "-dirty" : ""}`;
  } catch {
    throw new SandboxGuardError(
      "CODE_REVISION_UNAVAILABLE",
      "Set EVALS_CODE_REVISION when git metadata is unavailable",
    );
  }
}

function adapterVersions(
  value: Record<string, string> | undefined,
): Record<string, string> {
  if (!value || !Object.keys(value).length) {
    throw new SandboxGuardError(
      "VERSION_MANIFEST_INCOMPLETE",
      "Adapter versions must not be empty",
    );
  }
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      !/^[a-z][a-z0-9_-]{0,63}$/.test(key) ||
      typeof item !== "string" ||
      !item.trim() ||
      item.length > 200
    ) {
      throw new SandboxGuardError(
        "VERSION_MANIFEST_INCOMPLETE",
        "Adapter versions must contain bounded string versions",
      );
    }
    result[key] = item.trim();
  }
  return result;
}

export async function captureSandboxVersion(
  config: EvalsConfig,
  overrides: SandboxManifestOverrides = {},
): Promise<SandboxManifest> {
  const computedSchema = await agentsSchema(config.repoRoot);
  const codeRevision =
    overrides.codeRevision ??
    config.codeRevisionOverride ??
    gitRevision(config.repoRoot);
  const schemaVersion = overrides.schemaVersion ?? computedSchema.schemaVersion;
  const migrationChecksum =
    overrides.migrationChecksum ?? computedSchema.migrationChecksum;
  const imageDigest = overrides.imageDigest ?? config.imageDigest;
  const runtimeVersion = overrides.runtimeVersion ?? config.runtimeVersion;
  const configDigest =
    overrides.configDigest ??
    digest(
      canonical({
        environment: config.environment,
        evalDatabase: config.evalDatabase,
        productDatabase: config.productDatabase,
        billingEnforcement: config.billingEnforcement,
        modelMode: config.modelMode,
        identityMode: config.identityMode,
        networkPolicy: config.networkPolicy,
        modelId: config.modelId,
      }),
    );
  const modelRoutesDigest =
    overrides.modelRoutesDigest ??
    digest(
      canonical({
        modelMode: config.modelMode,
        modelId: config.modelId,
      }),
    );
  const adapters = adapterVersions(
    overrides.adapterVersions ?? config.adapterVersions,
  );

  return {
    codeRevision: text(codeRevision, "codeRevision", 200),
    imageDigest: text(imageDigest, "imageDigest", 200),
    schemaVersion: text(schemaVersion, "schemaVersion", 120),
    migrationChecksum: checksum(migrationChecksum, "migrationChecksum"),
    configDigest: checksum(configDigest, "configDigest"),
    runtimeVersion: text(runtimeVersion, "runtimeVersion", 120),
    modelRoutesDigest: checksum(modelRoutesDigest, "modelRoutesDigest"),
    adapterVersions: adapters,
  };
}
