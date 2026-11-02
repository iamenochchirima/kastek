import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer as httpServer } from "node:http";
import { createServer, type ServerHttp2Session } from "node:http2";
import { Pool } from "pg";
import { createEndpointHandler } from "@restatedev/restate-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { composeInbox } from "../src/composition/inbox";
import { PlatformStore } from "../src/product/agents/store";
import { ModelProviderStore } from "../src/product/model-providers/store";
import { ModelCredentialVault } from "../src/infrastructure/model-credential-vault";
import { ConnectionVault } from "../src/infrastructure/vault";
import { createBusinessWorkflow } from "../src/execution/business/business";
import { dispatchBoundModel } from "../src/execution/models/dispatch";
import { dispatchTasksOnce } from "../src/execution/lifecycle/dispatcher";
import { loadExecution } from "../src/execution/lifecycle/state";
import { defaultBusinessConfiguration, terminalTaskStates } from "../src/contracts/contracts";
import { probeProviderModel } from "../src/product/model-providers/probe";
import { KnowledgeRuntime } from "../src/capabilities/knowledge/knowledge-runtime";
import { EvidenceStore } from "../src/execution/context/evidence";
import { customerConfiguration } from "../src/product/offerings/offerings";
import { builtinProviderRegistry } from "../src/adapters/models/registry";
import { createModelFetch, type ModelFetch } from "../src/infrastructure/model-network";
import { dropClosedTestDatabase } from "./support/database-cleanup";
import { purposeResponse } from "./model-purpose-fixture";

const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("provider/context switching through the customer channel and real Restate", () => {
  const database = `agents_model_switch_${randomUUID().replaceAll("-", "")}`, container = `agents-model-switch-${randomUUID()}`;
  const sessions = new Set<ServerHttp2Session>(), objects = new Map<string, Uint8Array>();
  const providerCalls: Array<{ path: string; body: Record<string, unknown>; key: string | undefined }> = [];
  const loopPlans = new Map<string, { rounds: number; limit: number }>();
  const dispatched: Array<{ modelId: string; role: string; nativeHistory: unknown; maxInputTokens: number }> = [];
  const origin = "https://switch-customer.fixture.test", signature = "PRIVATE_ANTHROPIC_SWITCH_SIGNATURE", thinking = "PRIVATE_SWITCH_REASONING";
  const longAnswer = "Acknowledged your message. ".repeat(80);
  let admin: Pool, pool: Pool, platform: PlatformStore, providers: ModelProviderStore, inbox: ReturnType<typeof composeInbox>;
  let worker: ReturnType<typeof createServer>, provider: ReturnType<typeof httpServer>, providerOrigin: string, ingress: string, restAdmin: string, started = false;
  const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 60000 }).trim();
  async function until<T>(read: () => Promise<T | false>, timeout = 30000): Promise<T> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const value = await read(); if (value !== false) return value; await new Promise(resolve => setTimeout(resolve, 40)); }
    throw Error("Model switch acceptance timed out");
  }
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${database}`; pool = new Pool({ connectionString: url.href, max: 14 }); await setupPlatformSchema(pool);
    platform = new PlatformStore(pool);
    const vault = new ModelCredentialVault(new ConnectionVault("switch", { switch: randomBytes(32).toString("base64") }));
    providers = new ModelProviderStore(pool, vault, builtinProviderRegistry, { probe: request => probeProviderModel({ ...request, endpoint: `${providerOrigin}/v1` }, { testLoopback: true }) });
    provider = httpServer(async (request, response) => {
      let raw = ""; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw); providerCalls.push({ path: request.url!, body, key: request.headers["x-api-key"] as string | undefined ?? request.headers.authorization });
      if (request.url!.includes("count_tokens")) { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ input_tokens: 128 })); return; }
      const nonce = JSON.stringify(body).match(/"const":"([a-f0-9-]+)"/)?.[1];
      if (nonce) { const hasResult = JSON.stringify(body).includes('"role":"tool"'); purposeResponse(response, "openai_chat_completions", hasResult ? { text: nonce } : { name: "setup_echo", args: { token: nonce } }); return; }
      const plan = loopPlans.get(body.model);
      if (plan) {
        if (JSON.stringify(body).includes("Summarize untrusted records")) { purposeResponse(response, "openai_chat_completions", { text: "Approved knowledge searches returned no records. Continue the requested bounded checks." }); return; }
        plan.rounds++;
        if (plan.rounds > plan.limit) { purposeResponse(response, "openai_chat_completions", { text: "All bounded knowledge checks are complete." }); return; }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(`data: ${JSON.stringify({ id: randomUUID(), model: body.model, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `loopcall${plan.rounds}`, type: "function", function: { name: "knowledge_search", arguments: JSON.stringify({ query: "approved records" }) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 80, completion_tokens: 8 } })}\n\ndata: [DONE]\n\n`); return;
      }
      if (body.model === "switch-large") {
        expect(request.headers["x-api-key"]).toBe("private-large-key");
        const data = (type: string, value: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(data("message_start", { message: { id: randomUUID(), role: "assistant", model: body.model, content: [], usage: { input_tokens: 80, output_tokens: 0 } } }) +
          data("content_block_start", { index: 0, content_block: { type: "thinking", thinking, signature } }) + data("content_block_stop", { index: 0 }) +
          data("content_block_start", { index: 1, content_block: { type: "text", text: "" } }) +
          data("content_block_delta", { index: 1, delta: { type: "text_delta", text: longAnswer } }) + data("content_block_stop", { index: 1 }) +
          data("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 8 } }) + data("message_stop", {})); return;
      }
      expect(body.model).toBe("switch-small"); expect(request.headers.authorization).toBe("Bearer private-small-key");
      const compact = JSON.stringify(body).includes("Summarize untrusted records");
      purposeResponse(response, "openai_chat_completions", { text: compact ? "Prior customer messages were acknowledged. Human support confirmed the conversation can continue." : "The new model route is ready." });
    });
    await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve)); providerOrigin = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
    inbox = composeInbox(pool, { publicOrigin: "https://agents.fixture.test", async assertServices() {} });
    const evidence = new EvidenceStore(pool, { async put(key, value) { objects.set(key, Buffer.from(value)); }, async get(key) { const value = objects.get(key); if (!value) throw Error("Missing fixture object"); return value; }, async delete(key) { objects.delete(key); } });
    worker = createServer(createEndpointHandler({ services: [createBusinessWorkflow(pool, { modelProvider: providers, evidence, knowledgeRuntime: new KnowledgeRuntime(pool, evidence),
      modelRuntime: { dispatch: input => {
        dispatched.push({ modelId: input.accepted.binding.modelId, role: input.accepted.binding.role, nativeHistory: structuredClone(input.nativeHistory), maxInputTokens: input.accepted.policy.maxInputTokens });
        return dispatchBoundModel(input, policy => {
          const sourceOrigin = new URL(input.accepted.binding.endpoint).origin;
          const controlled = createModelFetch({ ...policy, testLoopback: true,
            authorizeUrl: url => url.origin === providerOrigin && policy.authorizeUrl(new URL(url.pathname + url.search, sourceOrigin)) });
          const network = (async (url, init) => { const destination = new URL(String(url)); expect(policy.authorizeUrl(destination)).toBe(true);
            return controlled(new URL(destination.pathname + destination.search, providerOrigin), init); }) as ModelFetch;
          network.markProgress = controlled.markProgress; return network;
        });
      } } })] }));
    worker.on("session", session => { sessions.add(session); session.once("close", () => sessions.delete(session)); });
    const bridge = docker("network", "inspect", "bridge", "--format", "{{(index .IPAM.Config 0).Gateway}}");
    await new Promise<void>(resolve => worker.listen(0, bridge, resolve));
    docker("run", "-d", "--name", container, "--cpus", "2", "--memory", "768m", "--add-host=host.docker.internal:host-gateway", "-p", "127.0.0.1::8080", "-p", "127.0.0.1::9070", "docker.restate.dev/restatedev/restate:1.7.13"); started = true;
    ingress = `http://${docker("port", container, "8080/tcp")}`; restAdmin = `http://${docker("port", container, "9070/tcp")}`;
    await until(async () => { try { return (await fetch(`${restAdmin}/health`)).ok; } catch { return false; } });
    const registered = await fetch(`${restAdmin}/deployments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uri: `http://host.docker.internal:${(worker.address() as { port: number }).port}` }) });
    expect(registered.ok).toBe(true);
  }, 90000);
  afterAll(async () => {
    if (started) docker("rm", "-f", container); for (const session of sessions) session.destroy();
    if (worker) await new Promise<void>(resolve => worker.close(() => resolve())); provider?.closeAllConnections();
    if (provider) await new Promise<void>(resolve => provider.close(() => resolve())); await pool?.end();
    if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); }
  }, 30000);
  async function connect(scope: { accountId: string; organizationId: string }, small: boolean) {
    const modelId = small ? "switch-small" : "switch-large", connection = await providers.create(scope, { providerId: small ? "openrouter" : "anthropic", name: modelId, apiKey: small ? "private-small-key" : "private-large-key" });
    await providers.addManualModel(scope, connection.id, { expectedRevision: connection.revision, modelId, confirmMetadata: true,
      metadata: { reference: "Controlled switch acceptance", contextTokens: small ? 8192 : 32768, maxInputTokens: small ? 6000 : 24000,
        maxOutputTokens: small ? 512 : 4096, tools: false, inputModalities: ["text"], outputModalities: ["text"] } });
    const current = await providers.getDefault(scope); await providers.setDefault(scope, { connectionId: connection.id, modelId, expectedRevision: current.revision });
    return connection;
  }
  async function run(visitor: { deploymentId: string; sessionId: string }, conversationId: string, body: string) {
    const accepted = await inbox.ingress(visitor, conversationId, { requestKey: randomUUID(), body });
    const id = accepted.message.task_id; expect(id).toBeTruthy();
    return until(async () => { await dispatchTasksOnce(pool, { ingressUrl: ingress, adminUrl: restAdmin });
      const task = (await pool.query("SELECT * FROM agents_platform.tasks WHERE id=$1", [id])).rows[0]; return terminalTaskStates.has(task.state) ? task : false; });
  }
  it("repacks and compacts under the smaller provider while preserving the website session and human ownership", async () => {
    const owner = await platform.ensureAccount({ issuer: "https://identity.fixture.test", subject: randomUUID(), email: "owner@example.test", displayName: "Owner" });
    const org = await platform.createOrganization(owner.id, "Model switches"), scope = { accountId: owner.id, organizationId: org.id }, large = await connect(scope, false);
    const configuration = customerConfiguration("customer-service"); configuration.tools = []; configuration.instructions = "Acknowledge customer messages. No external facts or actions are needed.";
    configuration.context = { maxInputTokens: 16000, compactAtTokens: 12000 };
    const initial = await platform.createConfiguredAgent({ ...scope, name: "Support", offering: "customer-service", configuration });
    const deployment = await platform.publishWebsite({ ...scope, agentId: initial.agent.id, versionId: initial.snapshot.id, allowedOrigins: [origin] });
    const sessionId = randomUUID(), tokenHash = createHash("sha256").update(randomBytes(32)).digest("hex");
    await pool.query("INSERT INTO agents_platform.website_sessions(id,deployment_id,token_hash,origin) VALUES($1,$2,$3,$4)", [sessionId, deployment.id, tokenHash, origin]);
    const visitor = { deploymentId: deployment.id, sessionId }, conversation = await inbox.open(visitor), oldTasks: string[] = [];
    for (let i = 0; i < 3; i++) {
      const task = await run(visitor, conversation.id, `Acknowledge customer message ${i + 1}.`); expect(task.state, task.error_code).toBe("completed"); expect(task.output).toBe(longAnswer); oldTasks.push(task.id);
      expect((await loadExecution(pool, task.id)).models.primary.binding.connectionId).toBe(large.id);
    }
    const privateRows = (await pool.query("SELECT native_state FROM agents_platform.private_model_continuations WHERE task_id=ANY($1::uuid[]) AND state='completed'", [oldTasks])).rows;
    expect(privateRows).toHaveLength(3); expect(JSON.stringify(privateRows)).toContain(signature);
    const command = async (action: "claim" | "takeover" | "reply" | "return", body?: string) => {
      const current = await inbox.readStaff(scope, conversation.id); return inbox.command(scope, conversation.id, { commandId: randomUUID(), expectedRevision: current.conversation.revision, action, ...(body ? { body } : {}) });
    };
    await command("claim"); const human = await command("takeover"), before = providerCalls.length;
    const small = await connect(scope, true);
    const changed = structuredClone(configuration); changed.context = { maxInputTokens: 6000, compactAtTokens: 4000 }; changed.model.maxOutputTokens = 512;
    const saved = await platform.saveConfiguration({ ...scope, agentId: initial.agent.id, expectedRevision: initial.agent.draft_revision, configuration: changed, confirmImpact: true });
    expect(saved.deployments.map(item => item.id)).toEqual([deployment.id]); expect(saved.snapshot.id).not.toBe(initial.snapshot.id);
    const afterSave = await inbox.readStaff(scope, conversation.id);
    expect(afterSave.conversation).toMatchObject({ id: conversation.id, session_id: sessionId, deployment_id: deployment.id, state: "human_owned", ownership_generation: human.ownership_generation, assignee_account_id: owner.id });
    expect(afterSave.messages.filter(message => message.author_kind === "assistant").every(message => message.body === longAnswer)).toBe(true);
    const waiting = await inbox.ingress(visitor, conversation.id, { requestKey: randomUUID(), body: "HUMAN_OWNED_MESSAGE" }); expect(waiting.message.task_id).toBeNull();
    await dispatchTasksOnce(pool, { ingressUrl: ingress, adminUrl: restAdmin }); expect(providerCalls).toHaveLength(before);
    expect((await pool.query("SELECT count(*) FROM agents_platform.tasks WHERE organization_id=$1", [org.id])).rows[0].count).toBe("3");
    expect((await inbox.readVisitor(visitor, conversation.id)).messages.filter(message => message.author_kind === "assistant")).toHaveLength(3);
    await command("reply", "Human support confirmed the conversation can continue."); await command("return");
    const next = await run(visitor, conversation.id, "Continue after the model switch."); expect(next.state, next.error_code).toBe("completed"); expect(next.output).toBe("The new model route is ready.");
    const execution = await loadExecution(pool, next.id);
    expect(next.conversation_id).toBe((await loadExecution(pool, oldTasks[0]!)).task.conversation_id);
    expect(execution.models.primary.binding).toMatchObject({ connectionId: small.id, providerId: "openrouter", modelId: "switch-small" });
    expect(execution.models.primary.policy).toMatchObject({ contextTokens: 8192, maxInputTokens: 6000, maxOutputTokens: 512 });
    const compactions = (await pool.query("SELECT request,output FROM agents_platform.operations WHERE task_id=$1 AND kind='compaction' AND state='completed'", [next.id])).rows;
    expect(compactions.length).toBeGreaterThan(0); expect(compactions.every(item => item.request.model === "switch-small")).toBe(true);
    const snapshots = (await pool.query("SELECT payload FROM agents_platform.context_snapshots WHERE task_id=$1", [next.id])).rows;
    expect(snapshots.length).toBeGreaterThan(0);
    for (const snapshot of snapshots) expect(snapshot.payload.estimatedTokens).toBeLessThanOrEqual(6000);
    const newCalls = providerCalls.slice(before); expect(newCalls.every(call => call.body.model === "switch-small")).toBe(true);
    expect(JSON.stringify(newCalls)).not.toContain(signature); expect(JSON.stringify(newCalls)).not.toContain(thinking); expect(JSON.stringify(newCalls)).not.toContain("private-large-key");
    const newDispatches = dispatched.filter(item => item.modelId === "switch-small"); expect(newDispatches.some(item => item.role === "compaction")).toBe(true);
    expect(newDispatches.every(item => item.maxInputTokens === 6000)).toBe(true);
    expect(newDispatches.every(item => !item.nativeHistory || Object.keys(item.nativeHistory).length === 0)).toBe(true);
    const visible = await inbox.readVisitor(visitor, conversation.id); expect(visible.conversation).toMatchObject({ id: conversation.id, session_id: sessionId, deployment_id: deployment.id, state: "automation_active" });
    expect(visible.messages.some(message => message.author_kind === "human" && message.body.includes("confirmed"))).toBe(true);
    expect(visible.messages.at(-1)?.body).toBe(next.output); expect(JSON.stringify(visible)).not.toContain(signature);
    for (const taskId of oldTasks) expect((await loadExecution(pool, taskId)).models.primary.binding.connectionId).toBe(large.id);
  }, 60000);
  it("runs beyond forty model rounds under the accepted allowance and stops at a smaller call quota", async () => {
    const priorPolicy = process.env.AGENTS_MODEL_POLICY_JSON;
    try {
      for (const maxCalls of [64, 3]) {
        process.env.AGENTS_MODEL_POLICY_JSON = JSON.stringify({ maxModelCalls: maxCalls, maxToolCalls: 64 });
        const owner = await platform.ensureAccount({ issuer: "https://loop.fixture.test", subject: randomUUID(), email: "loop@example.test", displayName: "Owner" });
        const org = await platform.createOrganization(owner.id, "Bounded model loop"), scope = { accountId: owner.id, organizationId: org.id };
        const modelId = `loop-model-${maxCalls}`, connection = await providers.create(scope, { providerId: "openrouter", name: "Bounded loop", apiKey: "private-loop-key" });
        loopPlans.set(modelId, { rounds: 0, limit: 41 });
        await providers.addManualModel(scope, connection.id, { expectedRevision: connection.revision, modelId, confirmMetadata: true,
          metadata: { reference: "Controlled long-loop fixture", contextTokens: 32768, maxInputTokens: 24000, maxOutputTokens: 4096,
            tools: true, inputModalities: ["text"], outputModalities: ["text"] } });
        await providers.probe(scope, connection.id, { expectedRevision: connection.revision, modelId, allowBillableRequest: true, verifyTools: true });
        await providers.setDefault(scope, { connectionId: connection.id, modelId, expectedRevision: 0 });
        const configuration = defaultBusinessConfiguration(); configuration.instructions = "Run the bounded approved knowledge checks, then acknowledge completion.";
        configuration.tools = ["knowledge.search"]; configuration.context = { maxInputTokens: 16000, compactAtTokens: 12000 }; configuration.model.maxOutputTokens = 512;
        const { agent, snapshot } = await platform.createConfiguredAgent({ ...scope, name: "Bounded worker", configuration });
        const authority = { product: "agents" as const, organizationId: org.id, resourceId: agent.id, callerClientId: "agents-execution", principal: { kind: "human" as const, issuer: owner.issuer, subject: owner.subject } };
        const grant = await platform.createGrant({ accountId: owner.id, grant: { ...authority, id: randomUUID(), versionId: snapshot.id,
          operations: ["model.reply", "knowledge.read"], sourceRevisionIds: [], connectedToolBindingIds: [], maxInputBytes: configuration.model.maxInputBytes,
          maxOutputTokens: 512, maxContextTokens: 16000, rootTokenLimit: 64000, expiresAt: new Date(Date.now() + 600000).toISOString(), revokedAt: null } });
        const admitted = await platform.admitTask({ authority, grantId: grant.id, versionId: snapshot.id, requestKey: randomUUID(), input: "Run the bounded knowledge checks." });
        const task = await until(async () => { await dispatchTasksOnce(pool, { ingressUrl: ingress, adminUrl: restAdmin });
          const value = (await pool.query("SELECT * FROM agents_platform.tasks WHERE id=$1", [admitted.task.id])).rows[0]; return terminalTaskStates.has(value.state) ? value : false; }, 60000);
        const operations = (await pool.query("SELECT kind,count(*)::int count FROM agents_platform.operations WHERE task_id=$1 AND state='completed' GROUP BY kind", [task.id])).rows;
        const modelCalls = operations.filter(value => value.kind === "model" || value.kind === "compaction").reduce((total, value) => total + value.count, 0);
        if (maxCalls === 64) { expect(task.state, task.error_code).toBe("completed"); expect(task.output).toBe("All bounded knowledge checks are complete."); expect(modelCalls).toBeGreaterThan(40); expect(loopPlans.get(modelId)!.rounds).toBe(42); }
        else { expect(task.error_code).toBe("ROOT_LIMIT"); expect(modelCalls).toBe(3); expect(loopPlans.get(modelId)!.rounds).toBe(3); }
        expect((await loadExecution(pool, task.id)).models.primary.policy.maxModelCalls).toBe(maxCalls);
      }
    } finally { if (priorPolicy === undefined) delete process.env.AGENTS_MODEL_POLICY_JSON; else process.env.AGENTS_MODEL_POLICY_JSON = priorPolicy; }
  }, 90000);

});
