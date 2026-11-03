import { contextGrantCeiling } from "../src/execution/models/settings";
import {dropClosedTestDatabase} from "./support/database-cleanup";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { PlatformStore } from "../src/product/agents/store";
import { requestDigest } from "../src/contracts/contracts";
import { EvaluationTrials } from "../src/product/evaluation/evaluation-trials";
import { exportExecutionHistory } from "../src/product/evaluation/history-export";
import { defaultBusinessConfiguration } from "../src/contracts/contracts";
import { connectFixtureModel } from "./model-fixture";
import { loadExecution } from "../src/execution/lifecycle/execution";

const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("immutable evaluation model scopes with PostgreSQL", () => {
  const database = `agents_model_evaluation_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool, pool: Pool, platform: PlatformStore;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${database}`;
    pool = new Pool({ connectionString: url.href }); await setupPlatformSchema(pool); platform = new PlatformStore(pool);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await dropClosedTestDatabase(admin,database); await admin.end(); } });
  async function fixture() {
    const account = await platform.ensureAccount({ issuer: "https://identity.example.test", subject: randomUUID(), email: "owner@example.test", displayName: "Owner" });
    const org = await platform.createOrganization(account.id, "Provider routes");
    const models = await connectFixtureModel(pool, account.id, org.id, "fixture/model-a");
    const configuration = defaultBusinessConfiguration();
    const { agent, snapshot } = await platform.createConfiguredAgent({ accountId: account.id, organizationId: org.id, name: "Agent", configuration });
    const authority = { product: "agents" as const, organizationId: org.id, resourceId: agent.id, callerClientId: "agents-execution",
      principal: { kind: "human" as const, issuer: account.issuer, subject: account.subject } };
    const grant = await platform.createGrant({ accountId: account.id, grant: { ...authority, id: randomUUID(), versionId: snapshot.id,
      operations: ["model.reply"], sourceRevisionIds: [], connectedToolBindingIds: [], maxInputBytes: configuration.model.maxInputBytes,
      maxOutputTokens: configuration.model.maxOutputTokens, maxContextTokens: contextGrantCeiling(configuration),
      rootTokenLimit: 32000, expiresAt: new Date(Date.now() + 600000).toISOString(), revokedAt: null } });
    const request = { authority, grantId: grant.id, versionId: snapshot.id, requestKey: randomUUID(), input: "Hello" };
    return { account, org, models, configuration, agent, snapshot, request };
  }
  async function prepare(f: Awaited<ReturnType<typeof fixture>>) {
    const trials = new EvaluationTrials(pool), preview = await trials.preview(f.account.id, f.org.id, f.agent.id, { versionId: f.snapshot.id, rootTokenLimit: 32000 });
    const input = { trialId: randomUUID(), agentId: f.agent.id, versionId: f.snapshot.id, expectedCompositionDigest: f.snapshot.effective_composition.digest,
      expectedModelRoutesDigest: preview.modelRoutesDigest, rootTokenLimit: 32000, maxTokens: 64000, expiresAt: new Date(Date.now() + 600000).toISOString() };
    return { trials, preview, input };
  }
  it("rejects a changed route between operator preview and trial preparation without reserving the agent", async () => {
    const f = await fixture(), p = await prepare(f);
    await connectFixtureModel(pool, f.account.id, f.org.id, "fixture/model-b");
    await expect(p.trials.prepare(f.account.id, f.org.id, p.input)).rejects.toMatchObject({ code: "EVALUATION_MODEL_MISMATCH" });
    expect((await pool.query("SELECT id FROM agents_platform.evaluation_trials WHERE agent_id=$1", [f.agent.id])).rowCount).toBe(0);
  });
  it("pins prepared routes through default changes, independent turns, exports and exact retries", async () => {
    const f = await fixture(), p = await prepare(f), trial = await p.trials.prepare(f.account.id, f.org.id, p.input);
    expect(trial.modelRoutesDigest).toBe(p.preview.modelRoutesDigest);
    await connectFixtureModel(pool, f.account.id, f.org.id, "fixture/model-b");
    expect((await p.trials.prepare(f.account.id, f.org.id, p.input)).id).toBe(trial.id);
    const request = { ...f.request, evaluationTrialId: trial.id }, first = await platform.admitTask(request);
    expect((await platform.admitTask(request)).task.id).toBe(first.task.id);
    const execution = await loadExecution(pool, first.task.id);
    expect(requestDigest(execution.models)).toBe(trial.modelRoutesDigest);
    expect(execution.models.primary.binding.modelId).toBe("fixture/model-a");
    const exported = await exportExecutionHistory(pool, first.task.id, async () => { await platform.getTask(f.request.authority, first.task.id); });
    expect(exported.modelRoutesDigest).toBe(trial.modelRoutesDigest);
    expect(exported.tasks[0]!.modelRoutes).toEqual(execution.models);
    expect(JSON.stringify(exported)).not.toContain("fixture-model-key");
    const next = await platform.admitTask({ ...request, requestKey: randomUUID(), conversationId: first.task.conversation_id });
    expect(requestDigest((await loadExecution(pool, next.task.id)).models)).toBe(trial.modelRoutesDigest);
    await expect(pool.query("UPDATE agents_platform.evaluation_trials SET model_routes_digest=$2 WHERE id=$1", [trial.id, "0".repeat(64)])).rejects.toMatchObject({ code: "23514" });
  });
  it("rejects new trial work after provider revocation instead of using the new default", async () => {
    const f = await fixture(), p = await prepare(f), trial = await p.trials.prepare(f.account.id, f.org.id, p.input);
    await connectFixtureModel(pool, f.account.id, f.org.id, "fixture/model-b");
    await f.models.store.revoke(f.models.scope, f.models.connection.id, f.models.connection.revision);
    await expect(platform.admitTask({ ...f.request, evaluationTrialId: trial.id })).rejects.toMatchObject({ code: "MODEL_CONNECTION_CHANGED" });
    expect((await pool.query("SELECT id FROM agents_platform.tasks WHERE evaluation_trial_id=$1", [trial.id])).rowCount).toBe(0);
  });
});
