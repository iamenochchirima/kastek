import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

type ReleaseManifest = {
  manifestVersion?: unknown;
  releaseId?: unknown;
  source?: { baseCommit?: unknown; worktreeFingerprint?: unknown; dirty?: unknown };
  runtime?: {
    migrations?: { first?: unknown; last?: unknown; count?: unknown };
    analyticsRegistrySha256?: unknown;
  };
  artifacts?: Array<{ path?: unknown; present?: unknown; sha256?: unknown; fileCount?: unknown }>;
  releaseGates?: Record<string, unknown>;
};

const repositoryRoot = resolve(__dirname, "..");
const agentsRoot = repositoryRoot;
const manifestPath = resolve(process.env.MEMORY_RELEASE_MANIFEST ?? join(agentsRoot, ".artifacts", "memory-release-manifest.json"));
const failures: string[] = [];

function sha256(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

function filesIn(path: string): string[] {
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  return readdirSync(path, { withFileTypes: true })
    .flatMap((entry) => filesIn(join(path, entry.name)))
    .sort();
}

function artifactDigest(path: string): { digest: string; count: number } {
  const digest = createHash("sha256");
  const files = filesIn(path);
  for (const file of files) {
    digest.update(relative(repositoryRoot, file));
    digest.update("\0");
    digest.update(readFileSync(file));
    digest.update("\0");
  }
  return { digest: digest.digest("hex"), count: files.length };
}

function git(args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: repositoryRoot, encoding: "utf8" }).trim();
}

function addFailure(message: string): void {
  failures.push(message);
}

let manifest: ReleaseManifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ReleaseManifest;
} catch (error) {
  throw new Error(`Unable to read release manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`);
}

if (manifest.manifestVersion !== 1) addFailure("manifestVersion must be 1");
if (typeof manifest.releaseId !== "string" || !manifest.releaseId.trim()) addFailure("releaseId is required");
if (typeof manifest.source?.baseCommit !== "string" || !/^[0-9a-f]{40,64}$/u.test(manifest.source.baseCommit)) {
  addFailure("source.baseCommit must be a commit SHA");
}
if (typeof manifest.source?.worktreeFingerprint !== "string" || !/^[0-9a-f]{64}$/u.test(manifest.source.worktreeFingerprint)) {
  addFailure("source.worktreeFingerprint must be a SHA-256 digest");
}

const allowDirty = ["1", "true", "yes"].includes((process.env.MEMORY_RELEASE_ALLOW_DIRTY ?? "").trim().toLowerCase());
if (manifest.source?.dirty === true && !allowDirty) addFailure("manifest was generated from a dirty worktree; set MEMORY_RELEASE_ALLOW_DIRTY=true only for local pre-release verification");
if (manifest.source?.dirty !== true && manifest.source?.dirty !== false) addFailure("source.dirty must be a boolean");

const migrationFiles = readdirSync(join(agentsRoot, "migrations"))
  .filter((file) => /^\d+_.+\.sql$/u.test(file))
  .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
const migrations = manifest.runtime?.migrations;
if (migrations?.first !== migrationFiles[0]) addFailure(`migration first mismatch: manifest=${String(migrations?.first)} current=${migrationFiles[0] ?? "none"}`);
if (migrations?.last !== migrationFiles.at(-1)) addFailure(`migration last mismatch: manifest=${String(migrations?.last)} current=${migrationFiles.at(-1) ?? "none"}`);
if (migrations?.count !== migrationFiles.length) addFailure(`migration count mismatch: manifest=${String(migrations?.count)} current=${migrationFiles.length}`);

const registrySource = readFileSync(join(agentsRoot, "src/analytics/generated-registry.ts"), "utf8");
const currentRegistrySha = registrySource.match(/ANALYTICS_REGISTRY_SHA256\s*=\s*"([a-f0-9]{64})"/u)?.[1];
if (manifest.runtime?.analyticsRegistrySha256 !== currentRegistrySha) addFailure("analytics registry checksum does not match the current source");

for (const expected of manifest.artifacts ?? []) {
  if (typeof expected.path !== "string") {
    addFailure("artifact path is missing");
    continue;
  }
  const artifactPath = resolve(repositoryRoot, expected.path);
  if (expected.present !== true || !statSafe(artifactPath)) {
    addFailure(`artifact is missing: ${expected.path}`);
    continue;
  }
  const actual = artifactDigest(artifactPath);
  if (expected.sha256 !== actual.digest) addFailure(`artifact digest mismatch: ${expected.path}`);
  if (expected.fileCount !== actual.count) addFailure(`artifact file count mismatch: ${expected.path}`);
}

if (failures.length) {
  process.stderr.write(`Memory release manifest verification failed (${failures.length}):\n${failures.map((failure) => `- ${failure}`).join("\n")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Memory release manifest verified: ${manifestPath}\n`);
  process.stdout.write(`Release ID: ${String(manifest.releaseId)}\n`);
  process.stdout.write(`Base commit: ${String(manifest.source?.baseCommit)}\n`);
  process.stdout.write(`Artifacts: ${(manifest.artifacts ?? []).length}\n`);
}

function statSafe(path: string): boolean {
  try {
    return statSync(path).isFile() || statSync(path).isDirectory();
  } catch {
    return false;
  }
}
