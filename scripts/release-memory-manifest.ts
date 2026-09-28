import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

type Artifact = {
  path: string;
  present: boolean;
  sha256: string | null;
  fileCount: number;
};

const repositoryRoot = resolve(__dirname, "../..");
const agentsRoot = resolve(repositoryRoot, "agents");
const outputPath = resolve(process.env.MEMORY_RELEASE_MANIFEST_OUT ?? join(agentsRoot, ".artifacts", "memory-release-manifest.json"));
const now = new Date();
const timestamp = now.toISOString().replace(/[-:.]/gu, "").replace(/Z$/u, "Z");
const releaseId = process.env.MEMORY_RELEASE_ID?.trim() || `memory-v2-pre-release-${timestamp}`;

function git(args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: repositoryRoot, encoding: "utf8" }).trim();
}

function sha256(input: Buffer | string): string {
  return createHash("sha256").update(input).digest("hex");
}

function collectFiles(path: string): string[] {
  const stat = statSync(path);
  if (stat.isFile()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => collectFiles(join(path, entry.name))).sort();
}

function artifact(path: string): Artifact {
  if (!statExists(path)) return { path: relative(repositoryRoot, path), present: false, sha256: null, fileCount: 0 };
  const files = collectFiles(path);
  const digest = createHash("sha256");
  for (const file of files) {
    digest.update(relative(repositoryRoot, file));
    digest.update("\0");
    digest.update(readFileSync(file));
    digest.update("\0");
  }
  return { path: relative(repositoryRoot, path), present: true, sha256: digest.digest("hex"), fileCount: files.length };
}

function statExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}

function worktreeFingerprint(): string {
  const releaseRecordPath = "docs/plans/active/AGENT_MEMORY_ARCHITECTURE_RELEASE_RECORD.md";
  const digest = createHash("sha256");
  // The release record stores this fingerprint. Exclude it from both status
  // and diff inputs so updating the record does not invalidate its own digest.
  digest.update(git(["status", "--porcelain=v1", "--", ".", `:(exclude)${releaseRecordPath}`]));
  digest.update("\0");
  digest.update(git(["diff", "--binary", "--", ".", `:(exclude)${releaseRecordPath}`]));
  digest.update("\0");
  const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter((file) => Boolean(file) && file !== releaseRecordPath)
    .sort();
  for (const file of untracked) {
    const absolute = resolve(repositoryRoot, file);
    if (!statExists(absolute) || !statSync(absolute).isFile()) continue;
    digest.update(file);
    digest.update("\0");
    digest.update(readFileSync(absolute));
    digest.update("\0");
  }
  return digest.digest("hex");
}

const packageJson = JSON.parse(readFileSync(join(agentsRoot, "package.json"), "utf8")) as { version?: string };
const migrationFiles = readdirSync(join(agentsRoot, "migrations"))
  .filter((file) => /^\d+_.+\.sql$/u.test(file))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const registrySource = readFileSync(join(agentsRoot, "src/analytics/generated-registry.ts"), "utf8");
const registrySha = registrySource.match(/ANALYTICS_REGISTRY_SHA256\s*=\s*"([a-f0-9]{64})"/u)?.[1] ?? null;
const manifest = {
  manifestVersion: 1,
  releaseId,
  generatedAt: now.toISOString(),
  source: {
    baseCommit: git(["rev-parse", "HEAD"]),
    worktreeFingerprint: worktreeFingerprint(),
    dirty: git(["status", "--porcelain=v1"]).length > 0,
  },
  runtime: {
    agentPackageVersion: packageJson.version ?? null,
    migrations: { first: migrationFiles[0] ?? null, last: migrationFiles.at(-1) ?? null, count: migrationFiles.length },
    rolloutFlags: ["MEMORY_V2_ENABLED", "memory_v2_writes_enabled", "memory_v2_retrieval_enabled", "memory_consolidation_enabled", "memory_projection_enabled"],
    analyticsRegistrySha256: registrySha,
  },
  artifacts: [artifact(join(agentsRoot, "dist")), artifact(join(agentsRoot, "packages/mcp/dist"))],
  releaseGates: {
    stagingDeployment: "pending",
    providerConfigurationRevision: "pending",
    productionPromotion: "pending",
    rollbackDrill: "pending",
  },
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
process.stdout.write(`Memory release manifest written: ${relative(repositoryRoot, outputPath)}\n`);
process.stdout.write(`Release ID: ${releaseId}\n`);
process.stdout.write(`Worktree fingerprint: ${manifest.source.worktreeFingerprint}\n`);
