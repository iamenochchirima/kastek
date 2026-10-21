import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { PlatformStore } from "../src/product/agents/store";
import { defaultBusinessConfiguration } from "../src/contracts/contracts";
import { connectFixtureModel, fixtureModelProviders } from "./model-fixture";
import { loadExecution, beginOperation, finishOperation } from "../src/execution/lifecycle/execution";
import { invokeTaskModel } from "../src/execution/models/runtime";
import { dispatchBoundModel } from "../src/execution/models/dispatch";
import { createModelFetch, type ModelFetch } from "../src/infrastructure/model-network";
import { delegatedModelRoutes } from "../src/execution/models/settings";

const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("accepted model routes and native invocation with PostgreSQL", () => {
  const database = `agents_model_admission_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool, pool: Pool, platform: PlatformStore;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${database}`;
    pool = new Pool({ connectionString: url.href }); await setupPlatformSchema(pool); platform = new PlatformStore(pool);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH(FORCE)`); await admin.end(); } });
  async function fixture(configuration = defaultBusinessConfiguration()) {
    const account = await platform.ensureAccount({ issuer: "https://identity.example.test", subject: randomUUID(), email: "owner@example.test", displayName: "Owner" });
    const org = await platform.createOrganization(account.id, "Provider routes");
    const models = await connectFixtureModel(pool, account.id, org.id, "fixture/model-a");
    const { agent, snapshot } = await platform.createConfiguredAgent({ accountId: account.id, organizationId: org.id, name: "Agent", configuration });
    const authority = { product: "agents" as const, organizationId: org.id, resourceId: agent.id, callerClientId: "agents-execution",
      principal: { kind: "human" as const, issuer: account.issuer, subject: account.subject } };
    const grant = await platform.createGrant({ accountId: account.id, grant: { ...authority, id: randomUUID(), versionId: snapshot.id,
      operations: ["model.reply"], sourceRevisionIds: [], connectedToolBindingIds: [], maxInputBytes: configuration.model.maxInputBytes,
      maxOutputTokens: configuration.model.maxOutputTokens, maxContextTokens: configuration.context.maxInputTokens,
      rootTokenLimit: 32000, expiresAt: new Date(Date.now() + 600000).toISOString(), revokedAt: null } });
    const request = { authority, grantId: grant.id, versionId: snapshot.id, requestKey: randomUUID(), input: "Hello" };
    return { account, org, models, configuration, agent, snapshot, request };
  }
  it("pins A across a default change, preserves retries, admits B next and blocks revoked A before HTTP", async () => {
    const f = await fixture(), accepted = await platform.admitTask(f.request);
    await connectFixtureModel(pool, f.account.id, f.org.id, "fixture/model-b");
    const replay = await platform.admitTask(f.request);
    expect(replay.replayed).toBe(true); expect(replay.task.id).toBe(accepted.task.id);
    const execution = await loadExecution(pool, accepted.task.id);
    expect(execution.models.primary.binding.modelId).toBe("fixture/model-a");
    const next = await platform.admitTask({ ...f.request, requestKey: randomUUID(), conversationId: accepted.task.conversation_id });
    expect((await loadExecution(pool, next.task.id)).models.primary.binding.modelId).toBe("fixture/model-b");
    let calls = 0;
    const server = createServer((request, reply) => {
      let body = ""; request.on("data", data => { body += data; }); request.on("end", () => {
        calls++; const payload = JSON.parse(body); expect(payload.model).toBe("fixture/model-a");
        expect(request.headers.authorization).toBe("Bearer fixture-model-key");
        reply.writeHead(200, { "content-type": "text/event-stream" });
        reply.end(`data: ${JSON.stringify({ id: "reply", model: payload.model, choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 2 } })}\n\ndata: [DONE]\n\n`);
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const dispatch: Parameters<typeof invokeTaskModel>[1] = { dispatch: input => dispatchBoundModel(input, policy => {
      const original = new URL(input.accepted.binding.endpoint);
      const physical = createModelFetch({ ...policy, testLoopback: true,
        authorizeUrl: url => url.origin === base && policy.authorizeUrl(new URL(url.pathname + url.search, original.origin)) });
      const network = (async (url, init) => { const destination = new URL(String(url)); expect(policy.authorizeUrl(destination)).toBe(true);
        return physical(new URL(destination.pathname + destination.search, base), init); }) as ModelFetch;
      network.markProgress = physical.markProgress; return network;
    }) };
    const operation = (id: string) => ({ id, kind: "model" as const, name: "model.generate", request: { message: "Hello" },
      reservedTokens: execution.models.primary.policy.maxInputTokens + execution.models.primary.policy.maxOutputTokens,
      reservedMs: execution.models.primary.policy.maxCallDurationMs });
    try {
      const first = operation(`model:${accepted.task.id}:0`);
      const admitted = await beginOperation(pool, accepted.task.id, first); expect(admitted.replayed).toBe(false);
      const response = await invokeTaskModel({ pool, execution, providerStore: fixtureModelProviders(pool), operationId: first.id,
        role: "primary", messages: [{ role: "user", content: "Hello" }], maxRequestBytes: execution.models.primary.policy.maxRequestBytes }, dispatch);
      expect(response.message.content).toBe("Hello"); expect(response).not.toHaveProperty("nativeState");
      await finishOperation(pool, accepted.task.id, first.id, "completed", response, null, 6);
      const account = (await pool.query("SELECT used_micros,reserved_micros,unknown_operations FROM agents_platform.root_model_accounts WHERE root_task_id=$1", [accepted.task.id])).rows[0];
      expect(account).toEqual({ used_micros: "0", reserved_micros: "0", unknown_operations: 0 });
      expect((await loadExecution(pool, accepted.task.id)).task.tokens_used).toBe(6);
      await f.models.store.revoke(f.models.scope, f.models.connection.id, f.models.connection.revision);
      const second = operation(`model:${accepted.task.id}:1`); await beginOperation(pool, accepted.task.id, second);
      await expect(invokeTaskModel({ pool, execution: await loadExecution(pool, accepted.task.id), providerStore: fixtureModelProviders(pool), operationId: second.id,
        role: "primary", messages: [{ role: "user", content: "Another" }], maxRequestBytes: execution.models.primary.policy.maxRequestBytes }, dispatch))
        .rejects.toMatchObject({ code: "MODEL_CONNECTION_CHANGED", outcome: "rejected" });
      expect(calls).toBe(1);
      await finishOperation(pool, accepted.task.id, second.id, "failed", null, "MODEL_CONNECTION_CHANGED", 0);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
  it("rejects an unenforceable finite money cap at admission without reserving work", async () => {
    const config = defaultBusinessConfiguration(); config.model.maxCostMicros = 100;
    const f = await fixture(config);
    await expect(platform.admitTask(f.request)).rejects.toMatchObject({ code: "MODEL_COST_CAP_UNSUPPORTED" });
    expect((await pool.query("SELECT id FROM agents_platform.tasks WHERE organization_id=$1", [f.org.id])).rowCount).toBe(0);
  });
  it("inherits the accepted parent route with bounded child policy, independently of the current default", async () => {
    const f = await fixture(), accepted = await platform.admitTask(f.request), parent = await loadExecution(pool, accepted.task.id);
    await connectFixtureModel(pool, f.account.id, f.org.id, "fixture/model-b");
    const child = delegatedModelRoutes(parent.models, f.configuration, 12000, 300000);
    expect(child.primary.binding.modelId).toBe("fixture/model-a"); expect(child.primary.binding.role).toBe("delegated");
    expect(child.primary.policy.maxInputTokens + child.primary.policy.maxOutputTokens).toBeLessThanOrEqual(12000);
    expect(child.primary.binding.credentialRevision).toBe(parent.models.delegated.binding.credentialRevision);
    expect(() => delegatedModelRoutes(parent.models, { ...f.configuration, model: { ...f.configuration.model,
      selection: { kind: "connection", connectionId: randomUUID(), modelId: "unapproved" } } }, 12000, 300000)).toThrow("parent's authorized route");
  });
});
