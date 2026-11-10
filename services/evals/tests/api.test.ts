import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { buildApi } from "../src/api.js";
import type { EvalsConfig } from "../src/config.js";
import { createPool } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { createSandboxPair, updateSandboxProvisioning } from "../src/store.js";

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
  evalDatabaseUrl:
    databaseUrl ?? "postgresql://control@127.0.0.1:55432/agents_evals",
  productDatabaseUrl:
    "postgresql://control@127.0.0.1:16544/agents",
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
  billingEnforcement: "sandbox",
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
    "TRUNCATE evals.sandbox_pairs, evals.interactive_turns, evals.interactive_sessions, evals.outcome_refs, evals.agent_refs, evals.workspace_refs, evals.sandbox_versions, evals.sandboxes CASCADE",
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
    payload: { product: "agency" },
  });
  assert.equal(response.statusCode, 400);
  assert.equal(
    (response.json() as { code: string }).code,
    "unsupported_product",
  );
});

test("records and reads agent references for a sandbox", { skip }, async () => {
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
    payload: { productWorkspaceId: "workspace-agent-ref", label: "Agent ref workspace" },
  });
  const workspaceRefId = (workspace.json() as { workspaceRef: { id: string } }).workspaceRef.id;
  const payload = {
    workspaceRefId,
    productAgentId: "agent-123",
    productVersionId: "version-456",
    sourceIds: ["source-1", "source-2"],
    compositionDigest: "a".repeat(64),
    modelRoutesDigest: "b".repeat(64),
  };
  const recorded = await app!.inject({
    method: "POST",
    url: `/v1/sandboxes/${sandboxId}/agents`,
    headers: auth,
    payload,
  });
  assert.equal(recorded.statusCode, 201);
  const agentRef = (recorded.json() as {
    agentRef: {
      id: string;
      productAgentId: string;
      productVersionId: string;
      sourceIds: string[];
      compositionDigest: string;
      modelRoutesDigest: string;
    };
  }).agentRef;
  assert.equal(agentRef.productAgentId, "agent-123");
  assert.equal(agentRef.productVersionId, "version-456");
  assert.deepEqual(agentRef.sourceIds, ["source-1", "source-2"]);
  assert.equal(agentRef.compositionDigest, "a".repeat(64));
  assert.equal(agentRef.modelRoutesDigest, "b".repeat(64));

  const listed = await app!.inject({
    method: "GET",
    url: `/v1/sandboxes/${sandboxId}/agents`,
    headers: auth,
  });
  assert.equal(listed.statusCode, 200);
  assert.equal((listed.json() as { agentRefs: Array<{ id: string }> }).agentRefs.length, 1);

  const fetched = await app!.inject({
    method: "GET",
    url: `/v1/sandboxes/${sandboxId}/agents/${agentRef.id}`,
    headers: auth,
  });
  assert.equal(fetched.statusCode, 200);
  assert.equal((fetched.json() as { agentRef: { id: string } }).agentRef.id, agentRef.id);

  const duplicate = await app!.inject({
    method: "POST",
    url: `/v1/sandboxes/${sandboxId}/agents`,
    headers: auth,
    payload,
  });
  assert.equal(duplicate.statusCode, 409);
  assert.equal((duplicate.json() as { code: string }).code, "AGENT_REF_EXISTS");

  const unknown = await app!.inject({
    method: "POST",
    url: "/v1/sandboxes/00000000-0000-4000-8000-000000000000/agents",
    headers: auth,
    payload,
  });
  assert.equal(unknown.statusCode, 404);
});

test("records and reads outcome references for an agent", { skip }, async () => {
  const created = await app!.inject({ method: "POST", url: "/v1/sandboxes", headers: auth, payload: {} });
  const sandboxId = (created.json() as { sandbox: { id: string } }).sandbox.id;
  const workspace = await app!.inject({
    method: "POST",
    url: `/v1/sandboxes/${sandboxId}/workspaces`,
    headers: auth,
    payload: { productWorkspaceId: "workspace-outcome-ref", label: "Outcome workspace" },
  });
  const workspaceRefId = (workspace.json() as { workspaceRef: { id: string } }).workspaceRef.id;
  const agent = await app!.inject({
    method: "POST",
    url: `/v1/sandboxes/${sandboxId}/agents`,
    headers: auth,
    payload: {
      workspaceRefId,
      productAgentId: "agent-outcome",
      productVersionId: "version-outcome",
      sourceIds: ["source-outcome"],
      compositionDigest: "a".repeat(64),
      modelRoutesDigest: "b".repeat(64),
    },
  });
  const agentRefId = (agent.json() as { agentRef: { id: string } }).agentRef.id;
  const payload = {
    workspaceRefId,
    agentRefId,
    kind: "enquiry",
    productOutcomeId: "enquiry-123",
    productRecordId: "record-123",
    status: "submitted",
    taskId: "task-123",
    requestDigest: "c".repeat(64),
    responseDigest: "d".repeat(64),
  };
  const recorded = await app!.inject({
    method: "POST",
    url: `/v1/sandboxes/${sandboxId}/outcomes`,
    headers: auth,
    payload,
  });
  assert.equal(recorded.statusCode, 201);
  const outcome = (recorded.json() as {
    outcomeRef: {
      id: string;
      kind: string;
      productOutcomeId: string;
      productRecordId: string;
      status: string;
      taskId: string;
      requestDigest: string;
      responseDigest: string;
    };
  }).outcomeRef;
  assert.equal(outcome.kind, "enquiry");
  assert.equal(outcome.productOutcomeId, "enquiry-123");
  assert.equal(outcome.productRecordId, "record-123");
  assert.equal(outcome.status, "submitted");
  assert.equal(outcome.taskId, "task-123");
  assert.equal(outcome.requestDigest, "c".repeat(64));
  assert.equal(outcome.responseDigest, "d".repeat(64));

  const listed = await app!.inject({
    method: "GET",
    url: `/v1/sandboxes/${sandboxId}/outcomes`,
    headers: auth,
  });
  assert.equal(listed.statusCode, 200);
  assert.equal((listed.json() as { outcomeRefs: Array<{ id: string }> }).outcomeRefs.length, 1);

  const fetched = await app!.inject({
    method: "GET",
    url: `/v1/sandboxes/${sandboxId}/outcomes/${outcome.id}`,
    headers: auth,
  });
  assert.equal(fetched.statusCode, 200);
  assert.equal((fetched.json() as { outcomeRef: { id: string } }).outcomeRef.id, outcome.id);

  const duplicate = await app!.inject({
    method: "POST",
    url: `/v1/sandboxes/${sandboxId}/outcomes`,
    headers: auth,
    payload,
  });
  assert.equal(duplicate.statusCode, 409);
  assert.equal((duplicate.json() as { code: string }).code, "OUTCOME_REF_EXISTS");

  const other = await app!.inject({ method: "POST", url: "/v1/sandboxes", headers: auth, payload: {} });
  const otherSandboxId = (other.json() as { sandbox: { id: string } }).sandbox.id;
  const wrongAgent = await app!.inject({
    method: "POST",
    url: `/v1/sandboxes/${otherSandboxId}/outcomes`,
    headers: auth,
    payload: { ...payload, workspaceRefId, agentRefId },
  });
  assert.equal(wrongAgent.statusCode, 400);
  assert.equal((wrongAgent.json() as { code: string }).code, "WORKSPACE_REF_NOT_FOUND");

  const unknown = await app!.inject({
    method: "POST",
    url: "/v1/sandboxes/00000000-0000-4000-8000-000000000000/outcomes",
    headers: auth,
    payload,
  });
  assert.equal(unknown.statusCode, 404);
});

test("records an interactive session and appends idempotent turns", { skip }, async () => {
  const created = await app!.inject({ method: "POST", url: "/v1/sandboxes", headers: auth, payload: {} });
  const sandboxId = (created.json() as { sandbox: { id: string } }).sandbox.id;
  const workspace = await app!.inject({
    method: "POST",
    url: `/v1/sandboxes/${sandboxId}/workspaces`,
    headers: auth,
    payload: { productWorkspaceId: "workspace-interactive", label: "Interactive workspace" },
  });
  const workspaceRefId = (workspace.json() as { workspaceRef: { id: string } }).workspaceRef.id;
  const agent = await app!.inject({
    method: "POST",
    url: `/v1/sandboxes/${sandboxId}/agents`,
    headers: auth,
    payload: {
      workspaceRefId,
      productAgentId: "agent-interactive",
      productVersionId: "version-interactive",
      sourceIds: ["source-interactive"],
      compositionDigest: "a".repeat(64),
      modelRoutesDigest: "b".repeat(64),
    },
  });
  const agentRefId = (agent.json() as { agentRef: { id: string } }).agentRef.id;
  const base = {
    workspaceRefId,
    agentRefId,
    productConversationId: "conversation-interactive",
    productTaskId: "task-interactive-1",
    inputDigest: "c".repeat(64),
    outputDigest: "d".repeat(64),
    state: "completed",
  };
  const sessionResponse = await app!.inject({
    method: "POST",
    url: `/v1/sandboxes/${sandboxId}/sessions`,
    headers: auth,
    payload: base,
  });
  assert.equal(sessionResponse.statusCode, 201);
  const sessionBody = sessionResponse.json() as {
    created: boolean;
    session: {
      id: string;
      productConversationId: string;
      firstTaskId: string;
      latestTaskId: string;
      turnCount: number;
      state: string;
    };
    turn: { id: string; sequence: number; productTaskId: string };
  };
  assert.equal(sessionBody.created, true);
  assert.equal(sessionBody.session.productConversationId, "conversation-interactive");
  assert.equal(sessionBody.session.firstTaskId, "task-interactive-1");
  assert.equal(sessionBody.session.latestTaskId, "task-interactive-1");
  assert.equal(sessionBody.session.turnCount, 1);
  assert.equal(sessionBody.session.state, "completed");
  assert.equal(sessionBody.turn.sequence, 1);
  assert.equal(sessionBody.turn.productTaskId, "task-interactive-1");
  const sessionId = sessionBody.session.id;

  const duplicate = await app!.inject({
    method: "POST",
    url: `/v1/sandboxes/${sandboxId}/sessions`,
    headers: auth,
    payload: base,
  });
  assert.equal(duplicate.statusCode, 200);
  assert.equal((duplicate.json() as { created: boolean }).created, false);
  assert.equal(
    (duplicate.json() as { session: { id: string } }).session.id,
    sessionId,
  );

  const listed = await app!.inject({
    method: "GET",
    url: `/v1/sandboxes/${sandboxId}/sessions`,
    headers: auth,
  });
  assert.equal(listed.statusCode, 200);
  assert.equal(
    (listed.json() as { sessions: Array<{ id: string }> }).sessions.length,
    1,
  );

  const fetched = await app!.inject({
    method: "GET",
    url: `/v1/sandboxes/${sandboxId}/sessions/${sessionId}`,
    headers: auth,
  });
  assert.equal(fetched.statusCode, 200);
  const detail = fetched.json() as {
    session: { turnCount: number };
    turns: Array<{ sequence: number; productTaskId: string }>;
  };
  assert.equal(detail.session.turnCount, 1);
  assert.equal(detail.turns.length, 1);

  const secondTurn = {
    productTaskId: "task-interactive-2",
    inputDigest: "e".repeat(64),
    outputDigest: "f".repeat(64),
    state: "active",
  };
  const appended = await app!.inject({
    method: "POST",
    url: `/v1/sandboxes/${sandboxId}/sessions/${sessionId}/turns`,
    headers: auth,
    payload: secondTurn,
  });
  assert.equal(appended.statusCode, 201);
  const appendedBody = appended.json() as {
    created: boolean;
    session: { turnCount: number; latestTaskId: string; state: string };
    turn: { sequence: number };
  };
  assert.equal(appendedBody.created, true);
  assert.equal(appendedBody.session.turnCount, 2);
  assert.equal(appendedBody.session.latestTaskId, "task-interactive-2");
  assert.equal(appendedBody.session.state, "active");
  assert.equal(appendedBody.turn.sequence, 2);

  const replay = await app!.inject({
    method: "POST",
    url: `/v1/sandboxes/${sandboxId}/sessions/${sessionId}/turns`,
    headers: auth,
    payload: secondTurn,
  });
  assert.equal(replay.statusCode, 200);
  assert.equal((replay.json() as { created: boolean }).created, false);
  const afterReplay = await app!.inject({
    method: "GET",
    url: `/v1/sandboxes/${sandboxId}/sessions/${sessionId}`,
    headers: auth,
  });
  assert.equal(
    (afterReplay.json() as { session: { turnCount: number } }).session.turnCount,
    2,
  );

  const conflict = await app!.inject({
    method: "POST",
    url: `/v1/sandboxes/${sandboxId}/sessions/${sessionId}/turns`,
    headers: auth,
    payload: { ...secondTurn, inputDigest: "1".repeat(64) },
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal((conflict.json() as { code: string }).code, "TURN_CONFLICT");

  const secondAgent = await app!.inject({
    method: "POST",
    url: `/v1/sandboxes/${sandboxId}/agents`,
    headers: auth,
    payload: {
      workspaceRefId,
      productAgentId: "agent-interactive",
      productVersionId: "version-interactive-2",
      sourceIds: [],
      compositionDigest: "2".repeat(64),
      modelRoutesDigest: "3".repeat(64),
    },
  });
  const secondAgentRefId = (secondAgent.json() as { agentRef: { id: string } }).agentRef.id;
  const sessionConflict = await app!.inject({
    method: "POST",
    url: `/v1/sandboxes/${sandboxId}/sessions`,
    headers: auth,
    payload: { ...base, agentRefId: secondAgentRefId },
  });
  assert.equal(sessionConflict.statusCode, 409);
  assert.equal((sessionConflict.json() as { code: string }).code, "SESSION_CONFLICT");

  const other = await app!.inject({ method: "POST", url: "/v1/sandboxes", headers: auth, payload: {} });
  const otherSandboxId = (other.json() as { sandbox: { id: string } }).sandbox.id;
  const wrongRefs = await app!.inject({
    method: "POST",
    url: `/v1/sandboxes/${otherSandboxId}/sessions`,
    headers: auth,
    payload: { ...base, productConversationId: "conversation-other" },
  });
  assert.equal(wrongRefs.statusCode, 400);
  assert.equal((wrongRefs.json() as { code: string }).code, "WORKSPACE_REF_NOT_FOUND");

  const unknownSession = await app!.inject({
    method: "POST",
    url: `/v1/sandboxes/${sandboxId}/sessions/00000000-0000-4000-8000-000000000000/turns`,
    headers: auth,
    payload: secondTurn,
  });
  assert.equal(unknownSession.statusCode, 404);
  assert.equal((unknownSession.json() as { code: string }).code, "SESSION_NOT_FOUND");
});

test("stores provisioning progress and runtime metadata", { skip }, async () => {
  const created = await app!.inject({ method: "POST", url: "/v1/sandboxes", headers: auth, payload: {} });
  const sandboxId = (created.json() as { sandbox: { id: string } }).sandbox.id;
  const updated = await updateSandboxProvisioning(pool!, sandboxId, {
    status: "ready",
    steps: [
      { name: "database", status: "complete" },
      { name: "workspace", status: "complete" },
    ],
    provisionedAt: "2026-11-09T20:00:00.000Z",
    runtime: { productApiUrl: "http://127.0.0.1:4000", productDatabase: "agents_sandbox_test" },
  });
  assert.ok(updated);
  assert.equal(updated.status, "ready");
  assert.equal(updated.profile, "local");
  assert.equal(updated.provisioningSteps.length, 2);
  assert.equal(updated.provisioningSteps[1]!.name, "workspace");
  assert.equal(updated.provisionedAt, "2026-11-09T20:00:00.000Z");
  assert.equal(updated.runtime.productApiUrl, "http://127.0.0.1:4000");
});

test("pairs one Growth sandbox with one Agents sandbox", { skip }, async () => {
  const growth = await app!.inject({
    method: "POST",
    url: "/v1/sandboxes",
    headers: auth,
    payload: { product: "growth" },
  });
  const growthId = (growth.json() as { sandbox: { id: string } }).sandbox.id;
  const agents = await app!.inject({
    method: "POST",
    url: "/v1/sandboxes",
    headers: auth,
    payload: { product: "agents" },
  });
  const agentsId = (agents.json() as { sandbox: { id: string } }).sandbox.id;
  const pair = await createSandboxPair(pool!, growthId, agentsId);
  assert.equal(pair.growthSandboxId, growthId);
  assert.equal(pair.agentsSandboxId, agentsId);

  const detail = await app!.inject({
    method: "GET",
    url: `/v1/sandboxes/${growthId}`,
    headers: auth,
  });
  assert.equal(detail.statusCode, 200);
  assert.equal((detail.json() as { pair: { agentsSandboxId: string } }).pair.agentsSandboxId, agentsId);

  const secondAgents = await app!.inject({
    method: "POST",
    url: "/v1/sandboxes",
    headers: auth,
    payload: { product: "agents" },
  });
  const secondAgentsId = (secondAgents.json() as { sandbox: { id: string } }).sandbox.id;
  await assert.rejects(
    () => createSandboxPair(pool!, growthId, secondAgentsId),
    (error: unknown) => (error as { code?: string }).code === "PAIR_CONFLICT",
  );
});


test("deletes a paired sandbox and retires both records", { skip }, async () => {
  const growth = await app!.inject({
    method: "POST",
    url: "/v1/sandboxes",
    headers: auth,
    payload: { product: "growth" },
  });
  const growthId = (growth.json() as { sandbox: { id: string } }).sandbox.id;
  const agents = await app!.inject({
    method: "POST",
    url: "/v1/sandboxes",
    headers: auth,
    payload: { product: "agents" },
  });
  const agentsId = (agents.json() as { sandbox: { id: string } }).sandbox.id;
  await createSandboxPair(pool!, growthId, agentsId);

  const deleted = await app!.inject({
    method: "DELETE",
    url: `/v1/sandboxes/${growthId}`,
    headers: auth,
  });
  assert.equal(deleted.statusCode, 200, deleted.body);
  const result = deleted.json() as { deleted: string[] };
  assert.deepEqual(new Set(result.deleted), new Set([growthId, agentsId]));

  for (const id of [growthId, agentsId]) {
    const detail = await app!.inject({ method: "GET", url: `/v1/sandboxes/${id}`, headers: auth });
    assert.equal(detail.statusCode, 200);
    assert.equal((detail.json() as { sandbox: { status: string } }).sandbox.status, "retired");
  }

  const unknown = await app!.inject({
    method: "DELETE",
    url: "/v1/sandboxes/00000000-0000-4000-8000-000000000000",
    headers: auth,
  });
  assert.equal(unknown.statusCode, 404);

  const blocked = await app!.inject({
    method: "POST",
    url: "/v1/sandboxes",
    headers: auth,
    payload: { product: "agents" },
  });
  const blockedId = (blocked.json() as { sandbox: { id: string } }).sandbox.id;
  await updateSandboxProvisioning(pool!, blockedId, { status: "provisioning" });
  const refused = await app!.inject({
    method: "DELETE",
    url: `/v1/sandboxes/${blockedId}`,
    headers: auth,
  });
  assert.equal(refused.statusCode, 409);
  assert.equal((refused.json() as { code: string }).code, "sandbox_provisioning");
  await updateSandboxProvisioning(pool!, blockedId, { status: "failed" });
});

test("requires explicit confirmation before deleting all sandboxes", { skip }, async () => {
  const first = await app!.inject({
    method: "POST",
    url: "/v1/sandboxes",
    headers: auth,
    payload: { product: "agents" },
  });
  const firstId = (first.json() as { sandbox: { id: string } }).sandbox.id;
  const second = await app!.inject({
    method: "POST",
    url: "/v1/sandboxes",
    headers: auth,
    payload: { product: "growth" },
  });
  const secondId = (second.json() as { sandbox: { id: string } }).sandbox.id;

  const unconfirmed = await app!.inject({
    method: "DELETE",
    url: "/v1/sandboxes",
    headers: auth,
    payload: {},
  });
  assert.equal(unconfirmed.statusCode, 400);
  assert.equal((unconfirmed.json() as { code: string }).code, "confirmation_required");

  const deleted = await app!.inject({
    method: "DELETE",
    url: "/v1/sandboxes",
    headers: auth,
    payload: { confirm: "DELETE" },
  });
  assert.equal(deleted.statusCode, 200, deleted.body);
  const result = deleted.json() as { deleted: string[]; failed: Array<{ id: string }> };
  assert.ok(result.deleted.includes(firstId));
  assert.ok(result.deleted.includes(secondId));
  assert.deepEqual(result.failed, []);

  for (const id of [firstId, secondId]) {
    const detail = await app!.inject({ method: "GET", url: `/v1/sandboxes/${id}`, headers: auth });
    assert.equal((detail.json() as { sandbox: { status: string } }).sandbox.status, "retired");
  }

  const all = await app!.inject({ method: "GET", url: "/v1/sandboxes?limit=200", headers: auth });
  assert.ok((all.json() as { sandboxes: Array<{ sandbox: { status: string } }> }).sandboxes.every(
    (item) => item.sandbox.status === "retired",
  ));
});


test("lists product agents and chats through the Growth product API", { skip }, async () => {
  const sandbox = await app!.inject({
    method: "POST",
    url: "/v1/sandboxes",
    headers: auth,
    payload: { product: "growth" },
  });
  const sandboxId = (sandbox.json() as { sandbox: { id: string } }).sandbox.id;
  await app!.inject({
    method: "POST",
    url: `/v1/sandboxes/${sandboxId}/workspaces`,
    headers: auth,
    payload: { productWorkspaceId: "growth-org-test", label: "Growth test" },
  });

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/agents/bootstrap") {
      return send(200, {
        features: [
          {
            id: "assistant",
            name: "Growth assistant",
            description: "Test assistant",
            revision: 1,
            ready: true,
            avatar: "moss",
            model: { label: "Test model", provider: "test", modelId: "test/model" },
            specialists: [],
          },
        ],
        setup: { state: "ready", code: null },
        model: { label: "Test model", ready: true },
      });
    }
    if (url.pathname === "/api/agents/conversations" && request.method === "POST") {
      return send(201, { conversation: { id: "conversation-test", featureId: "assistant" } });
    }
    if (url.pathname === "/api/agents/conversations/conversation-test/messages" && request.method === "POST") {
      return send(202, { replayed: false, task: { id: "task-test", conversationId: "conversation-test", state: "accepted" } });
    }
    if (url.pathname === "/api/agents/tasks/task-test") {
      return send(200, {
        task: {
          id: "task-test",
          conversationId: "conversation-test",
          state: "completed",
          output: "Hello from Growth",
        },
      });
    }
    if (url.pathname === "/api/agents/conversations/conversation-test") {
      return send(200, {
        conversation: { id: "conversation-test", featureId: "assistant" },
        messages: [
          { id: "task-test:user", role: "user", text: "Hello", taskId: "task-test", createdAt: "2026-11-10T00:00:00.000Z" },
          { id: "task-test:assistant", role: "assistant", text: "Hello from Growth", taskId: "task-test", createdAt: "2026-11-10T00:00:01.000Z" },
        ],
      });
    }
    return send(404, { error: "Not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture failed to listen");
  const directory = await mkdtemp(join(tmpdir(), "evals-product-"));
  const sessionFile = join(directory, "owner-session.json");
  await writeFile(sessionFile, JSON.stringify({
    origin: `http://127.0.0.1:${address.port}`,
    organizationId: "growth-org-test",
    organizationName: "Growth test",
    session: "growth-session-test",
  }), { mode: 0o600 });
  try {
    await updateSandboxProvisioning(pool!, sandboxId, {
      status: "ready",
      runtime: { sessionFile, organizationId: "growth-org-test" },
    });

    const agents = await app!.inject({
      method: "GET",
      url: `/v1/sandboxes/${sandboxId}/product-agents`,
      headers: auth,
    });
    assert.equal(agents.statusCode, 200, agents.body);
    const productAgents = (agents.json() as {
      agents: Array<{ refId: string; name: string; ready: boolean; productAgentId: string }>;
    }).agents;
    assert.equal(productAgents.length, 1);
    assert.equal(productAgents[0]!.name, "Growth assistant");
    assert.equal(productAgents[0]!.productAgentId, "assistant");
    assert.equal(productAgents[0]!.ready, true);

    const chat = await app!.inject({
      method: "POST",
      url: `/v1/sandboxes/${sandboxId}/chat`,
      headers: auth,
      payload: { agentRefId: productAgents[0]!.refId, message: "Hello" },
    });
    assert.equal(chat.statusCode, 200, chat.body);
    const result = chat.json() as {
      session: { id: string; state: string; turnCount: number };
      messages: Array<{ role: string; text: string }>;
    };
    assert.equal(result.session.state, "completed");
    assert.equal(result.session.turnCount, 1);
    assert.deepEqual(result.messages.map((item) => [item.role, item.text]), [
      ["user", "Hello"],
      ["assistant", "Hello from Growth"],
    ]);

    const messages = await app!.inject({
      method: "GET",
      url: `/v1/sandboxes/${sandboxId}/sessions/${result.session.id}/messages`,
      headers: auth,
    });
    assert.equal(messages.statusCode, 200, messages.body);
    assert.equal((messages.json() as { messages: unknown[] }).messages.length, 2);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
