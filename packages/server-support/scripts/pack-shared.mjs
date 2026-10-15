import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const destination = resolve(process.argv[2] ?? "/tmp/kasitek-shared-artifacts");
if (Number(process.versions.node.split(".")[0]) !== 24)
  throw new Error("Use Node 24 to build the shared artifacts");
const run = (args) => {
  const result = spawnSync("pnpm", args, { cwd: root, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`pnpm ${args.join(" ")} failed`);
};
mkdirSync(destination, { recursive: true });
run(["build:shared"]);
for (const name of ["contracts", "server-support"])
  run([
    "--filter",
    `@kasitek-labs/${name}`,
    "pack",
    "--pack-destination",
    destination,
  ]);
const files = [];
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", "dist"].includes(entry.name)) continue;
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.isFile() && !entry.name.endsWith(".tgz")) files.push(path);
  }
}
for (const name of ["contracts", "server-support"])
  walk(resolve(root, "packages", name));
files.push(
  ...[
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.shared.json",
  ].map((name) => resolve(root, name)),
);
const sourceFiles = files
  .sort()
  .map((path) => ({
    path: relative(root, path),
    sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
  }));
const sourceContentSha256 = createHash("sha256")
  .update(JSON.stringify(sourceFiles))
  .digest("hex");
const git = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
});
const artifacts = ["contracts", "server-support"].map((name) => {
  const metadata = JSON.parse(
    readFileSync(resolve(root, "packages", name, "package.json"), "utf8"),
  );
  const file = `kasitek-labs-${name}-${metadata.version}.tgz`;
  const bytes = readFileSync(resolve(destination, file));
  return {
    package: metadata.name,
    version: metadata.version,
    file,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64"),
  };
});
const manifest = {
  schemaVersion: 1,
  sourceCommit: git.status === 0 ? git.stdout.trim() : null,
  sourceContentSha256,
  node: process.version,
  packageManager: "pnpm@10.30.1",
  sourceFiles,
  artifacts,
};
writeFileSync(
  resolve(destination, "manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(
  `Shared compiled artifacts and checksums written to ${destination}`,
);
