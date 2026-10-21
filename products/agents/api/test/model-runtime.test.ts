import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PlatformError, requestDigest } from "../src/contracts/contracts";
import type { Execution } from "../src/contracts/execution";
import type { AcceptedModelRoutes } from "../src/contracts/model-bindings";
import type { BoundModelDispatchInput } from "../src/execution/models/dispatch";
import { dispatchBoundModel } from "../src/execution/models/dispatch";
import { invokeTaskModel, saveTaskModelRoutes, loadTaskModelRoutes, type ModelRuntimeDependencies } from "../src/execution/models/runtime";
import type { ProviderTransportResponse } from "../src/adapters/models/pi-transport";
import { createModelFetch, type ModelFetch } from "../src/infrastructure/model-network";
import { transaction } from "../src/infrastructure/database";
import { setupPlatformSchema } from "../src/composition/setup";

const source = { kind: "operator" as const, reference: "runtime-fixture", observedAt: "2026-10-21T00:00:00.000Z" };
function routes(organizationId: string, agentId: string): AcceptedModelRoutes {
  const definition = { id: "fixture", name: "Fixture", protocol: "openai_chat_completions" as const, baseUrl: "https://fixture.invalid/v1",
    auth: { kind: "bearer" as const }, discovery: { kind: "curated" as const }, officialDocsUrl: "https://fixture.invalid/docs",
    adapter: { id: "fixture-adapter", revision: "1", readiness: "installed" as const } };
  const policy = { revision: "fixture-1", digest: "b".repeat(64), contextTokens: 32000, maxInputTokens: 16000, maxOutputTokens: 32,
    safetyTokens: 1000, compactAtTokens: 12000, maxModelCalls: 10, maxToolCalls: 10, maxDurationMs: 2000, maxCallDurationMs: 2000,
    maxInputBytes: 100, maxRequestBytes: 2097152, maxMessages: 256, maxTools: 64, maxResponseBytes: 100000, maxRootTokens: 32000, maxCostMicros: null };
  const model = { id: "fixture-model", providerId: "fixture", name: "Fixture model", protocol: definition.protocol, revision: "fixture-1",
    contextTokens: { value: 32000, source }, maxInputTokens: { value: 16000, source }, maxOutputTokens: { value: 32, source },
    capabilities: { tools: { value: true, evidence: "verified" as const, source }, reasoning: { value: null, evidence: "unknown" as const, source: null },
      structuredOutput: { value: null, evidence: "unknown" as const, source: null } }, inputModalities: ["text" as const], outputModalities: ["text" as const], pricing: null, lifecycle: "active" as const };
  const binding = { organizationId, connectionId: randomUUID(), connectionRevision: 1, credentialRevision: 1,
    useGrantId: randomUUID(), useGrantRevision: 1, providerId: "fixture", providerDefinitionDigest: requestDigest(definition),
    endpoint: definition.baseUrl, protocol: definition.protocol, modelId: model.id, modelRevision: model.revision,
    adapterId: definition.adapter.id, adapterRevision: "1", role: "primary" as const, policyDigest: policy.digest };
  const route = { binding, definition, model, policy, consumer: { kind: "agent" as const, agentId } };
  return { primary: route, compaction: { ...route, binding: { ...binding, role: "compaction" } }, delegated: { ...route, binding: { ...binding, role: "delegated" } } };
}
const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("pinned model runtime with fresh PostgreSQL", () => {
  const database = `agents_runtime_models_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool, pool: Pool;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${database}`; pool = new Pool({ connectionString: url.href }); await setupPlatformSchema(pool);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH(FORCE)`); await admin.end(); } });
  async function fixture(save = true) {
    const organizationId = randomUUID(), account = randomUUID(), agent = randomUUID(), version = randomUUID(), grant = randomUUID(), conversation = randomUUID(), taskId = randomUUID();
    const pinned = routes(organizationId, agent);
    await transaction(pool, async db => {
      await db.query(`INSERT INTO agents_platform.accounts(id,issuer,subject,email,display_name) VALUES($1::uuid,'fixture',($1::uuid)::text,'fixture@example.test','Fixture')`, [account]);
      await db.query(`INSERT INTO agents_platform.organizations(id,name) VALUES($1,'Fixture')`, [organizationId]);
      await db.query(`INSERT INTO agents_platform.agents(id,organization_id,name,draft,created_by) VALUES($1,$2,'Fixture','{}',$3)`, [agent, organizationId, account]);
      await db.query(`INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,draft_revision,execution_kind,configuration,created_by,effective_composition)
        VALUES($1,$2,$3,1,1,'business','{"executionKind":"business"}',$4,jsonb_build_object('schemaVersion','1','digest',repeat('a',64)))`, [version, organizationId, agent, account]);
      await db.query(`INSERT INTO agents_platform.execution_grants(id,product,organization_id,resource_id,caller_client_id,principal,version_id,operations,max_input_bytes,max_output_tokens,expires_at)
        VALUES($1,'agents',$2,$3,'fixture','{"kind":"human"}',$4,'[]',16384,1024,now()+interval '1 hour')`, [grant, organizationId, agent, version]);
      await db.query(`INSERT INTO agents_platform.conversations(id,organization_id,agent_id,principal) VALUES($1,$2,$3,'{}')`, [conversation, organizationId, agent]);
      await db.query(`INSERT INTO agents_platform.tasks(id,product,organization_id,resource_id,caller_client_id,principal,version_id,grant_id,conversation_id,request_key,request_digest,input,root_task_id,effective_composition)
        VALUES($1,'agents',$2,$3,'fixture','{}',$4,$5,$6,($1::uuid)::text,repeat('a',64),'Fixture',$1,jsonb_build_object('schemaVersion','1','digest',repeat('a',64)))`, [taskId, organizationId, agent, version, grant, conversation]);
      if (save) await saveTaskModelRoutes(db, taskId, organizationId, pinned);
    });
    const task = (await pool.query("SELECT * FROM agents_platform.tasks WHERE id=$1", [taskId])).rows[0];
    return { taskId, organizationId, pinned, execution: { task, agentId: agent, configuration: {}, models: pinned, connectedBindings: [], toolBindings: [] } as unknown as Execution };
  }
  async function operation(f: Awaited<ReturnType<typeof fixture>>, compaction = false) {
    const id = randomUUID();
    await pool.query(`INSERT INTO agents_platform.operations(id,task_id,kind,name,request_digest,request,state,reserved_tokens,reserved_ms,attempt_id)
      VALUES($1,$2,$3,'fixture',repeat('a',64),'{}','started',32000,0,$4)`, [id, f.taskId, compaction ? "compaction" : "model", randomUUID()]);
    return id;
  }
  function response(request: BoundModelDispatchInput): ProviderTransportResponse {
    return { message: { role: "assistant", content: "Visible answer", tool_calls: [{ id: "call-fixture", type: "function", function: { name: "lookup", arguments: "{}" } }] },
      finishReason: "tool_calls", usage: { observed: true, inputTokens: 5, outputTokens: 2, cachedInputTokens: 0, cacheWriteTokens: 0 },
      nativeState: { provider: "fixture", protocol: "openai_chat_completions", model: "fixture-model", baseUrl: request.accepted.binding.endpoint,
        credentialRevision: "1", assistant: { role: "assistant", content: [{ type: "thinking", thinking: "private-reasoning", signature: "private-signature" }] } } };
  }
  function invocation(f: Awaited<ReturnType<typeof fixture>>, operationId: string) {
    return { pool, execution: f.execution, providerStore: { resolveCredential: vi.fn(async () => "private-fixture-key") },
      operationId, role: "primary" as const, messages: [{ role: "user" as const, content: "Hello" }], maxRequestBytes: 100000 };
  }
  function controlledDispatch() {
    const assertAuthority = vi.fn(async () => {});
    const dispatch = vi.fn(async (request: BoundModelDispatchInput) => {
      await request.beforePayloadDispatch?.({ messages: request.messages }); await request.beforeDispatch?.(); return response(request);
    });
    return { assertAuthority, dispatch } satisfies ModelRuntimeDependencies;
  }
  it("persists immutable organization-scoped route snapshots and detects missing or corrupt snapshots", async () => {
    const f = await fixture(), other = await fixture();
    expect(await loadTaskModelRoutes(pool, f.taskId, f.organizationId)).toEqual(f.pinned);
    await expect(loadTaskModelRoutes(pool, f.taskId, other.organizationId)).rejects.toMatchObject({ code: "MODEL_ROUTES_UNAVAILABLE" });
    await transaction(pool, db => saveTaskModelRoutes(db, f.taskId, f.organizationId, f.pinned));
    const changed = structuredClone(f.pinned); changed.primary.model.name = "Changed";
    await expect(transaction(pool, db => saveTaskModelRoutes(db, f.taskId, f.organizationId, changed))).rejects.toMatchObject({ code: "MODEL_ROUTES_INTEGRITY" });
    await expect(pool.query("UPDATE agents_platform.task_model_routes SET snapshot_digest=repeat('c',64) WHERE task_id=$1", [f.taskId])).rejects.toMatchObject({ code: "23514" });
    const missing = await fixture(false);
    await expect(loadTaskModelRoutes(pool, missing.taskId, missing.organizationId)).rejects.toMatchObject({ code: "MODEL_ROUTES_UNAVAILABLE" });
    await pool.query("INSERT INTO agents_platform.task_model_routes(task_id,organization_id,routes,snapshot_digest) VALUES($1,$2,$3,repeat('c',64))", [missing.taskId, missing.organizationId, missing.pinned]);
    await expect(loadTaskModelRoutes(pool, missing.taskId, missing.organizationId)).rejects.toMatchObject({ code: "MODEL_ROUTES_INTEGRITY" });
  });
  it("keeps native reasoning/signatures in private storage and excludes them from returned journal data", async () => {
    const f = await fixture(), id = await operation(f), dependencies = controlledDispatch();
    const result = await invokeTaskModel(invocation(f, id), dependencies);
    expect(result.message.content).toBe("Visible answer"); expect(result.usage.observed).toBe(true);
    expect(dependencies.assertAuthority).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toMatch(/private-reasoning|private-signature|nativeState|private-fixture-key/);
    const row = (await pool.query("SELECT * FROM agents_platform.private_model_continuations WHERE operation_id=$1", [id])).rows[0];
    expect(row.state).toBe("completed"); expect(JSON.stringify(row.native_state)).toContain("private-signature");
    expect(JSON.stringify(row)).not.toContain("private-fixture-key"); expect(row.route_binding_digest).toBe(requestDigest(f.pinned.primary.binding));
    await expect(invokeTaskModel(invocation(f, id), dependencies)).rejects.toMatchObject({ code: "MODEL_NATIVE_OPERATION_ALREADY_RECORDED", outcome: "uncertain" });
    expect(dependencies.dispatch).toHaveBeenCalledOnce();
  });
  it("restores exact matching assistant/tool groups only for the same task and route role", async () => {
    const f = await fixture(), first = await operation(f), dependencies = controlledDispatch();
    const original = await invokeTaskModel(invocation(f, first), dependencies);
    const continuation = [...invocation(f, first).messages, original.message, { role: "tool" as const, content: "Found", tool_call_id: "call-fixture" }];
    const verify = async (role: "primary" | "delegated" | "compaction", content = "Visible answer") => {
      const id = await operation(f, role === "compaction"), next = controlledDispatch();
      await invokeTaskModel({ ...invocation(f, id), role, messages: continuation.map(message => message.role === "assistant" ? { ...message, content } : message) }, next);
      return next.dispatch.mock.calls[0]![0].nativeHistory;
    };
    expect((await verify("primary"))![1]!.assistant).toMatchObject({ content: [{ signature: "private-signature" }] });
    expect(await verify("primary", "Changed visible answer")).toEqual({});
    expect(await verify("delegated")).toEqual({}); expect(await verify("compaction")).toEqual({});
    const other = await fixture(), otherDependencies = controlledDispatch();
    await invokeTaskModel({ ...invocation(other, await operation(other)), messages: continuation }, otherDependencies);
    expect(otherDependencies.dispatch.mock.calls[0]![0].nativeHistory).toEqual({});
  });
  it("rejects corrupt matching native continuation before dispatch", async () => {
    const f = await fixture(), priorId = await operation(f), state = controlledDispatch();
    const original = response({ accepted: f.pinned.primary } as BoundModelDispatchInput);
    await pool.query(`INSERT INTO agents_platform.private_model_continuations(operation_id,organization_id,task_id,role,route_binding_digest,request_digest,state,
      assistant_digest,tool_call_ids,native_state,native_state_digest,completed_at)
      VALUES($1,$2,$3,'primary',$4,repeat('a',64),'completed',$5,$6,$7,repeat('c',64),now())`,
      [priorId, f.organizationId, f.taskId, requestDigest(f.pinned.primary.binding), requestDigest(original.message), ['call-fixture'], original.nativeState]);
    const nextId = await operation(f);
    await expect(invokeTaskModel({ ...invocation(f, nextId), messages: [...invocation(f, nextId).messages, original.message,
      { role: "tool", content: "Found", tool_call_id: "call-fixture" }] }, state)).rejects.toMatchObject({ code: "MODEL_NATIVE_HISTORY_INTEGRITY", outcome: "rejected" });
    expect(state.dispatch).not.toHaveBeenCalled();
  });
  it("marks persistence failure uncertain and blocks physical replay", async () => {
    const f = await fixture(), id = await operation(f), dependencies = controlledDispatch();
    dependencies.dispatch.mockImplementationOnce(async request => {
      const result = response(request); result.nativeState.credentialRevision = "wrong-revision"; return result;
    });
    await expect(invokeTaskModel(invocation(f, id), dependencies)).rejects.toMatchObject({ code: "MODEL_CONTINUATION_PERSISTENCE_UNCERTAIN", outcome: "uncertain" });
    await expect(invokeTaskModel(invocation(f, id), dependencies)).rejects.toMatchObject({ code: "MODEL_NATIVE_OPERATION_ALREADY_RECORDED", outcome: "uncertain" });
    expect(dependencies.dispatch).toHaveBeenCalledOnce();
    expect((await pool.query("SELECT state FROM agents_platform.private_model_continuations WHERE operation_id=$1", [id])).rows[0].state).toBe("uncertain");
  });
  it("validates the true protocol payload against input and context allowance before physical dispatch", async () => {
    const f = await fixture(), id = await operation(f), dependencies = controlledDispatch();
    await expect(invokeTaskModel({ ...invocation(f, id), estimateRequestTokens: () => 16001 }, dependencies)).rejects.toMatchObject({ code: "CONTEXT_LIMIT", outcome: "rejected" });
    expect(dependencies.assertAuthority).not.toHaveBeenCalled();
  });
  it("streams a real controlled HTTP call and persists only private native continuation", async () => {
    const f = await fixture(), id = await operation(f); let calls = 0;
    const server = createServer((request, reply) => {
      calls++; expect(request.headers.authorization).toBe("Bearer private-fixture-key"); request.resume();
      request.on("end", () => { reply.writeHead(200, { "Content-Type": "text/event-stream" }); reply.end(`data: ${JSON.stringify({ id: "runtime-reply", model: "fixture-model", choices: [{ index: 0, delta: { role: "assistant", content: "Hello" }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`); });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const authority = vi.fn(async () => {});
      const dependencies: ModelRuntimeDependencies = { assertAuthority: authority, dispatch: request => dispatchBoundModel(request, policy => {
        const physical = createModelFetch({ ...policy, testLoopback: true, authorizeUrl: url => url.origin === base && policy.authorizeUrl(new URL(url.pathname, "https://fixture.invalid")) });
        const wrapped = (async (url: RequestInfo | URL, init?: RequestInit) => {
          const original = new URL(String(url)); expect(policy.authorizeUrl(original)).toBe(true);
          return physical(new URL(original.pathname, base), init);
        }) as ModelFetch; wrapped.markProgress = physical.markProgress; return wrapped;
      }) };
      const result = await invokeTaskModel(invocation(f, id), dependencies);
      expect(result.message.content).toBe("Hello"); expect(calls).toBe(1); expect(result).not.toHaveProperty("nativeState");
      expect((await pool.query("SELECT state FROM agents_platform.private_model_continuations WHERE operation_id=$1", [id])).rows[0].state).toBe("completed");
      const overflow = await operation(f);
      await expect(invokeTaskModel({ ...invocation(f, overflow), estimateRequestTokens: () => 16001 }, dependencies))
        .rejects.toMatchObject({ code: "CONTEXT_LIMIT", outcome: "rejected" });
      expect(calls).toBe(1);
      const expired = await operation(f);
      authority.mockRejectedValueOnce(new PlatformError("AUTHORITY_EXPIRED", 403, "Expired"));
      await expect(invokeTaskModel(invocation(f, expired), dependencies)).rejects.toMatchObject({ code: "AUTHORITY_EXPIRED", outcome: "rejected" });
      expect(calls).toBe(1);
      const rejectedRows = (await pool.query("SELECT state FROM agents_platform.private_model_continuations WHERE operation_id=ANY($1::text[])", [[overflow, expired]])).rows;
      expect(rejectedRows).toEqual([{ state: "rejected" }, { state: "rejected" }]);
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
