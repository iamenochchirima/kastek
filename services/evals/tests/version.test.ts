import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { EvalsConfig } from "../src/config.js";
import { SandboxGuardError } from "../src/guard.js";
import { captureSandboxVersion } from "../src/version.js";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));

const config: EvalsConfig = {
  environment: "test",
  databaseUrl: "postgresql://control@127.0.0.1:5432/evals_service",
  host: "127.0.0.1",
  port: 4600,
  operatorToken: "evals-test-operator-token-000000000000",
  repoRoot,
  codeRevisionOverride: "test-revision",
  imageDigest: "test-image",
  runtimeVersion: "1.7.13",
  modelId: "test-model",
  adapterVersions: { core: "1" },
  evalDatabase: {
    host: "127.0.0.1",
    port: 55432,
    database: "agents_evals",
    role: "agents_evals_admin",
  },
  productDatabase: {
    host: "127.0.0.1",
    port: 16544,
    database: "agents",
    role: "agents_admin",
  },
  billingEnforcement: "disabled",
  modelMode: "deterministic",
  identityMode: "seed",
  networkPolicy: "loopback",
};

test("captures a complete, deterministic manifest", async () => {
  const manifest = await captureSandboxVersion(config);
  assert.equal(manifest.codeRevision, "test-revision");
  assert.equal(manifest.imageDigest, "test-image");
  assert.equal(manifest.schemaVersion, "001_platform");
  assert.match(manifest.migrationChecksum, /^[a-f0-9]{64}$/);
  assert.match(manifest.configDigest, /^[a-f0-9]{64}$/);
  assert.match(manifest.modelRoutesDigest, /^[a-f0-9]{64}$/);
  assert.equal(manifest.runtimeVersion, "1.7.13");
  assert.deepEqual(manifest.adapterVersions, { core: "1" });
});

test("honours explicit version overrides", async () => {
  const overrides = {
    codeRevision: "override-revision",
    imageDigest: "sha256:image",
    schemaVersion: "001_platform",
    migrationChecksum: "a".repeat(64),
    configDigest: "b".repeat(64),
    runtimeVersion: "1.8.0",
    modelRoutesDigest: "c".repeat(64),
    adapterVersions: { core: "2", harbor: "0.24.0" },
  };
  const manifest = await captureSandboxVersion(config, overrides);
  assert.deepEqual(manifest, overrides);
});

test("rejects an incomplete migration checksum", async () => {
  await assert.rejects(
    () =>
      captureSandboxVersion(config, {
        migrationChecksum: "not-a-checksum",
      }),
    (error) =>
      error instanceof SandboxGuardError &&
      error.code === "VERSION_MANIFEST_INCOMPLETE",
  );
});

test("rejects empty adapter versions", async () => {
  await assert.rejects(
    () =>
      captureSandboxVersion(config, {
        adapterVersions: {},
      }),
    (error) =>
      error instanceof SandboxGuardError &&
      error.code === "VERSION_MANIFEST_INCOMPLETE",
  );
});
