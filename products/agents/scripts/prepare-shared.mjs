import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const agentsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const labsRoot = process.argv[2] ?? process.env.LABS_SOURCE_DIR;
if (!labsRoot) throw new Error("Provide the Labs source checkout path or LABS_SOURCE_DIR");
if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("Use Node 24");

const destination = resolve(agentsRoot, ".artifacts/shared");
mkdirSync(destination, { recursive: true });
const expected = JSON.parse(readFileSync(resolve(agentsRoot, "shared-packages.json"), "utf8"));
const result = spawnSync("pnpm", ["pack:shared", destination], { cwd: resolve(labsRoot), stdio: "inherit" });
if (result.status !== 0) throw new Error("Build the Labs packages after installing its frozen lockfile");

const actual = JSON.parse(readFileSync(resolve(destination, "manifest.json"), "utf8"));
if (actual.sourceCommit !== expected.sourceCommit) throw new Error("Labs source commit differs from the pinned migration packages");
if (actual.sourceContentSha256 !== expected.sourceContentSha256) throw new Error("Labs source content differs from the pinned migration packages");
for (const artifact of expected.artifacts) {
  const bytes = readFileSync(resolve(destination, artifact.file));
  if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new Error(`Shared package digest mismatch: ${artifact.package}`);
  if (`sha512-${createHash("sha512").update(bytes).digest("base64")}` !== artifact.integrity) throw new Error(`Shared package integrity mismatch: ${artifact.package}`);
}
const contracts = expected.artifacts.find((artifact) => artifact.package === "@kasitek-labs/contracts");
if (!contracts) throw new Error("The pinned Labs contracts package is missing");
copyFileSync(resolve(agentsRoot, "shared-packages.json"), resolve(destination, "pinned-manifest.json"));
console.log("Pinned Labs contracts package prepared. Run pnpm install --frozen-lockfile.");
