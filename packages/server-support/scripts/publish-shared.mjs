import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const registry = "https://npm.pkg.github.com";
const token = process.env.NODE_AUTH_TOKEN;

if (Number(process.versions.node.split(".")[0]) !== 24) {
  throw new Error("Use Node 24 to publish shared packages");
}
if (!token || /[\r\n]/.test(token)) {
  throw new Error("Set NODE_AUTH_TOKEN to a GitHub token with write:packages");
}

const git = (args) => {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
  return result.stdout.trim();
};
if (git(["branch", "--show-current"]) !== "main") {
  throw new Error("Publish shared packages from the Labs main branch");
}
if (git(["status", "--porcelain"])) {
  throw new Error("Commit or discard Labs changes before publishing packages");
}

for (const name of ["contracts", "server-support"]) {
  const metadata = JSON.parse(
    readFileSync(resolve(root, "packages", name, "package.json"), "utf8"),
  );
  if (metadata.publishConfig?.registry !== registry || metadata.private) {
    throw new Error(`${metadata.name} is not configured for GitHub Packages`);
  }
}

const authDirectory = mkdtempSync(resolve(tmpdir(), "kasitek-npm-auth-"));
const authFile = resolve(authDirectory, ".npmrc");
try {
  writeFileSync(
    authFile,
    `@kasitek-labs:registry=${registry}\n//npm.pkg.github.com/:_authToken=${token}\n`,
    { mode: 0o600 },
  );
  const env = {
    ...process.env,
    NPM_CONFIG_USERCONFIG: authFile,
    npm_config_userconfig: authFile,
  };
  const run = (args) => {
    const result = spawnSync("pnpm", args, {
      cwd: root,
      env,
      stdio: "inherit",
    });
    if (result.status !== 0) {
      throw new Error(`pnpm ${args.join(" ")} failed`);
    }
  };
  run(["build:shared"]);
  for (const name of ["contracts", "server-support"]) {
    run([
      "--filter",
      `@kasitek-labs/${name}`,
      "publish",
      "--access",
      "restricted",
      "--no-git-checks",
    ]);
  }
} finally {
  rmSync(authDirectory, { recursive: true, force: true });
}
