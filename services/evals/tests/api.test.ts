import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { buildApi } from "../src/api.js";
import type { EvalsConfig } from "../src/config.js";
import { createPool } from "../src/db.js";
import { migrate } from "../src/migrate.js";

const databaseUrl = process.env.EVALS_TEST_DATABASE_URL;
const skip = databaseUrl
  ? false
  : "Set EVALS_TEST_DATABASE_URL to a disposable PostgreSQL database";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const operatorToken = "evals-test-operator-token-000000000000";
const config: EvalsConfig = {
  environment: "test",
  databaseUrl:
    databaseUrl ?? "postgresql://control@127.0.0.1:5432/evals_service_test",
  host: "127.0.0.1",
  port: 4600,
  operatorToken,
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

const auth = { authorization: `Bearer ${operatorToken}` };

let app: FastifyInstance | undefined;
let pool: Pool | undefined;

before(async () => {
  if (!databaseUrl) return;
  await migrate(databaseUrl);
  pool = createPool(databaseUrl);
  app = buildApi(pool, config, { logger: false });
  await pool.query(
    "TRUNCATE evals.workspace_refs, evals.sandbox_versions, evals.sandboxes CASCADE",
  );
});

after(async () => {
  await app?.close();
  await pool?.end();
});

test("creates, lists and inspects a sandbox", { skip }, async () => {
  const created = await app!.inject({
    method: "POST",
    url: "/v1/sandboxes",
    headers: auth,
    payload: {
      product: "agents",
      adapterVersions: { core: "1", harbor: "0.24.0" },
    },
  });
  assert.equal(created.statusCode, 201);
  const detail = created.json() as {
    sandbox: { id: string; product: string; status: string };
    version: {
      codeRevision: string;
      schemaVersion: string;
      adapterVersions: Record<string, string>;
    };
    workspaceRefs: unknown[];
  };
  assert.equal(detail.sandbox.product, "agents");
  assert.equal(detail.sandbox.status, "active");
  assert.equal(detail.version.codeRevision, "test-revision");
  assert.equal(detail.version.schemaVersion, "001_platform");
  assert.deepEqual(detail.version.adapterVersions, {
    core: "1",
    harbor: "0.24.0",
  });
  assert.deepEqual(detail.workspaceRefs, []);

  const list = await app!.inject({
    method: "GET",
    url: "/v1/sandboxes",
    headers: auth,
  });
  assert.equal(list.statusCode, 200);
  const listed = list.json() as { sandboxes: Array<{ sandbox: { id: string } }> };
  assert.equal(listed.sandboxes.length, 1);
  assert.equal(listed.sandboxes[0]!.sandbox.id, detail.sandbox.id);

  const fetched = await app!.inject({
    method: "GET",
    url: `/v1/sandboxes/${detail.sandbox.id}`,
    headers: auth,
  });
  assert.equal(fetched.statusCode, 200);
  assert.equal(
    (fetched.json() as { sandbox: { id: string } }).sandbox.id,
    detail.sandbox.id,
  );
});

test("registers a workspace reference", { skip }, async () => {
  const created = await app!.inject({
    method: "POST",
    url: "/v1/sandboxes",
    headers: auth,
    payload: {},
  });
  const sandboxId = (created.json() as { sandbox: { id: string } }).sandbox.id;

  const workspace = await app!.inject({
    method: "POST",
    url: `/v1/sandboxes/${sandboxId}/workspaces`,
    headers: auth,
    payload: {
      productWorkspaceId: "workspace-123",
      label: "Persistent workspace",
    },
  });
  assert.equal(workspace.statusCode, 201);
  const ref = (workspace.json() as {
    workspaceRef: { productWorkspaceId: string; label: string };
  }).workspaceRef;
  assert.equal(ref.productWorkspaceId, "workspace-123");
  assert.equal(ref.label, "Persistent workspace");

  const fetched = await app!.inject({
    method: "GET",
    url: `/v1/sandboxes/${sandboxId}`,
    headers: auth,
  });
  const detail = fetched.json() as {
    workspaceRefs: Array<{ productWorkspaceId: string }>;
  };
  assert.equal(detail.workspaceRefs.length, 1);
  assert.equal(detail.workspaceRefs[0]!.productWorkspaceId, "workspace-123");
});

test("returns 401 without an operator token", { skip }, async () => {
  const response = await app!.inject({
    method: "GET",
    url: "/v1/sandboxes",
  });
  assert.equal(response.statusCode, 401);
});

test("returns 404 for an unknown sandbox", { skip }, async () => {
  const response = await app!.inject({
    method: "GET",
    url: "/v1/sandboxes/00000000-0000-4000-8000-000000000000",
    headers: auth,
  });
  assert.equal(response.statusCode, 404);
});

test("rejects an unsupported product", { skip }, async () => {
  const response = await app!.inject({
    method: "POST",
    url: "/v1/sandboxes",
    headers: auth,
    payload: { product: "growth" },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(
    (response.json() as { code: string }).code,
    "unsupported_product",
  );
});
