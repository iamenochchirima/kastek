import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer as httpServer } from "node:http";
import { createServer, type ServerHttp2Session } from "node:http2";
import { Pool } from "pg";
import { createEndpointHandler } from "@restatedev/restate-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { composeInbox } from "../src/composition/inbox";
import { buildPlatformApp } from "../src/composition/app";
import { loadPlatformConfig } from "../src/infrastructure/config";
import { PlatformStore } from "../src/product/agents/store";
import { ModelProviderStore } from "../src/product/model-providers/store";
import { probeProviderModel } from "../src/product/model-providers/probe";
import { ModelCredentialVault } from "../src/infrastructure/model-credential-vault";
import { ConnectionVault } from "../src/infrastructure/vault";
import { createBusinessWorkflow } from "../src/execution/business/business";
import { dispatchBoundModel } from "../src/execution/models/dispatch";
import { dispatchTasksOnce } from "../src/execution/lifecycle/dispatcher";
import { terminalTaskStates } from "../src/contracts/contracts";
import { EvidenceStore } from "../src/execution/context/evidence";
import { KnowledgeRuntime } from "../src/platform/knowledge/knowledge-runtime";
import { EvaluationTrials } from "../src/product/evaluation/evaluation-trials";
import { exportExecutionHistory } from "../src/product/evaluation/history-export";
import { customerConfiguration } from "../src/product/offerings/offerings";
import { builtinProviderRegistry } from "../src/adapters/models/registry";
import type { ModelFetch } from "../src/infrastructure/model-network";
import { publishFixtureSource } from "./knowledge-fixture";
import { dropClosedTestDatabase } from "./support/database-cleanup";
import { createBookingFixture, createBookingProviderFixture, type BookingProviderFixture } from "./booking-fixture";
import type { BookingService } from "../src/workflows/booking/bookings";
import { purposeResponse } from "./model-purpose-fixture";

const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
const profiles = builtinProviderRegistry.filter(profile => ["openrouter", "openai", "anthropic", "google", "mistral"].includes(profile.id));
(databaseUrl ? describe : describe.skip)("independent purpose acceptance with native model routes, PostgreSQL and Restate", () => {
  const database = `agents_purposes_${randomUUID().replaceAll("-", "")}`, container = `agents-purposes-${randomUUID()}`;
  const sessions = new Set<ServerHttp2Session>(), objects = new Map<string, Uint8Array>();
  const storage = { async put(key: string, value: Uint8Array) { objects.set(key, Buffer.from(value)); }, async get(key: string) { const value = objects.get(key); if (!value) throw Error("Missing fixture object"); return value; }, async delete(key: string) { objects.delete(key); } };
  let admin: Pool, pool: Pool, platform: PlatformStore, providers: ModelProviderStore, trials: EvaluationTrials;
  let worker: ReturnType<typeof createServer>, provider: ReturnType<typeof httpServer>, providerOrigin: string, ingress: string, restAdmin: string;
  let inbox: ReturnType<typeof composeInbox>, started = false, calendar: BookingProviderFixture, bookingService: BookingService;
  const bookingPlans = new Map<string, { start: string; end: string; conflict: boolean; steps: number }>();
  const proof: Array<Record<string, unknown>> = [], rejectedCustomerPurposes: string[] = [];
  const calls: Array<{ provider: string; path: string; body: any }> = [];
  const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 60000 }).trim();
  async function until<T>(read: () => Promise<T | false>, timeout = 30000): Promise<T> {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const value = await read(); if (value !== false) return value; await new Promise(resolve => setTimeout(resolve, 40)); }
    throw Error("Purpose acceptance timed out");
  }
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${database}`; pool = new Pool({ connectionString: url.href, max: 14 }); await setupPlatformSchema(pool);
    platform = new PlatformStore(pool); trials = new EvaluationTrials(pool);
    provider = httpServer(async (request, response) => {
      let raw = ""; for await (const chunk of request) raw += chunk; const body = JSON.parse(raw);
      const path = new URL(request.url!, "http://fixture").searchParams.get("path") ?? request.url!;
      const profileId = String(request.headers["x-purpose-provider"] ?? request.url!.split("/")[1]), profile = builtinProviderRegistry.find(profile => profile.id === profileId)!;
      calls.push({ provider: profileId, path, body });
      if (/input_tokens|count_tokens|:countTokens/.test(path)) { response.setHeader("content-type", "application/json"); response.end(JSON.stringify(profile.protocol === "google_generate_content" ? { totalTokens: 100 } : { input_tokens: 100 })); return; }
      const serialized = JSON.stringify(body), nonce = serialized.match(/"const":"([a-f0-9-]+)"/)?.[1];
      const hasResult = /"role":"tool"|"type":"tool_result"|"type":"function_call_output"|"functionResponse"/.test(serialized);
      if (nonce) { purposeResponse(response, profile.protocol, hasResult ? { text: nonce } : { name: "setup_echo", args: { token: nonce } }); return; }
      const plan = bookingPlans.get(body.model);
      if (plan) {
        plan.steps++;
        purposeResponse(response, profile.protocol, plan.steps === 1 ? { name: "booking_availability", args: { start: plan.start, end: plan.end } }
          : plan.steps === 2 ? { name: "booking_reserve", args: { start: plan.start } }
          : { text: plan.conflict ? "The booking was not confirmed." : "Your consultation is confirmed." }); return;
      }
      if (serialized.includes("UNKNOWN_PURPOSE_CASE")) { purposeResponse(response, profile.protocol, { name: "channel_request_handoff", args: {} }); return; }
      const label = serialized.match(/E[a-f0-9]{32}/)?.[0];
      purposeResponse(response, profile.protocol, { text: label ? `We open at nine. [${label}]` : "No approved opening-hours source is available." });
    });
    await new Promise<void>(resolve => provider.listen(0, "127.0.0.1", resolve)); providerOrigin = `http://127.0.0.1:${(provider.address() as { port: number }).port}`;
    const vault = new ModelCredentialVault(new ConnectionVault("purpose", { purpose: randomBytes(32).toString("base64") }));
    providers = new ModelProviderStore(pool, vault, builtinProviderRegistry, { probe: request => probeProviderModel({ ...request, endpoint: `${providerOrigin}/${request.provider.id}/v1` }, { testLoopback: true }) });
    inbox = composeInbox(pool, { publicOrigin: "https://agents.fixture.test", async assertServices() {} });
    calendar = await createBookingProviderFixture();
    const bookings = { prepare: (...args: Parameters<BookingService["prepare"]>) => bookingService.prepare(...args),
      availability: (...args: Parameters<BookingService["availability"]>) => bookingService.availability(...args),
      execute: (...args: Parameters<BookingService["execute"]>) => bookingService.execute(...args) } as BookingService;
    const evidence = new EvidenceStore(pool, storage);
    worker = createServer(createEndpointHandler({ services: [createBusinessWorkflow(pool, { modelProvider: providers, evidence, bookings, knowledgeRuntime: new KnowledgeRuntime(pool, evidence),
      modelRuntime: { dispatch: input => dispatchBoundModel(input, policy => {
        const network = (async (url, init) => {
          const destination = new URL(String(url)); if (!policy.authorizeUrl(destination)) throw Error("Fixture destination rejected");
          await policy.beforeDispatch?.();
          const headers = new Headers(init?.headers); headers.set("x-purpose-provider", input.accepted.definition.id);
          return fetch(`${providerOrigin}/?path=${encodeURIComponent(destination.pathname)}`, { ...init, headers });
        }) as ModelFetch; network.markProgress = () => {}; return network;
      }) } })] }));
    worker.on("session", session => { sessions.add(session); session.once("close", () => sessions.delete(session)); });
    await new Promise<void>(resolve => worker.listen(0, "0.0.0.0", resolve));
    docker("run", "-d", "--name", container, "--add-host=host.docker.internal:host-gateway", "-p", "127.0.0.1::8080", "-p", "127.0.0.1::9070", "docker.restate.dev/restatedev/restate:1.7.13"); started = true;
    ingress = `http://${docker("port", container, "8080/tcp")}`; restAdmin = `http://${docker("port", container, "9070/tcp")}`;
    await until(async () => { try { return (await fetch(`${restAdmin}/health`)).ok; } catch { return false; } });
    const registered = await fetch(`${restAdmin}/deployments`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ uri: `http://host.docker.internal:${(worker.address() as { port: number }).port}` }) });
    expect(registered.ok).toBe(true);
  }, 90000);
  afterAll(async () => {
    const directory = resolve(__dirname, "../../../../.audit"); await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, "model-purpose-acceptance.json"), JSON.stringify({ schemaVersion: "purpose-acceptance.v1",
      status: proof.length === profiles.length * 2 + 4 && rejectedCustomerPurposes.length === 3 ? "complete" : "partial",
      execution: "Actual PostgreSQL, Restate, native protocol HTTP fixtures, EvaluationTrials and authorized exports",
      providerQuality: "Not evaluated; no live provider requests", supported: proof,
      unsupported: [
        ...rejectedCustomerPurposes.map(purpose => ({ purpose, surface: "Agents customer creation", providers: "all",
          status: "unsupported", reason: "The customer API offers FAQ and customer service. Research, content and campaign features belong to Growth or Agencies.",
          evidence: "Authenticated creation requests rejected with HTTP400; no agent records created" })),
        { purpose: "campaign publishing", surface: "Growth/Agencies", providers: "all", status: "unsupported",
          reason: "No product campaign publishing action and purpose-specific authoritative publishing verifier are integrated. Generic product assertion execution and controlled research programs do not establish campaign outcomes." },
      ], separateEvidence: ["model-evaluation.test.ts: immutable trial routes across default changes", "product-execution.test.ts: delegated product identity and route authorization",
        "Harbor research-connected-skill and campaign-research-connected-skill verifiers grade controlled read/skill receipts, not campaign publishing"],
    }, null, 2), { mode: 0o600 });
    if (started) docker("rm", "-f", container);
    for (const session of sessions) session.destroy(); if (worker) await new Promise<void>(resolve => worker.close(() => resolve()));
    await calendar?.close();
    provider?.closeAllConnections(); if (provider) await new Promise<void>(resolve => provider.close(() => resolve()));
    await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); }
  }, 30000);
  async function connectModel(profile: typeof profiles[number], scope: { accountId: string; organizationId: string }) {
    const modelId = `purpose-${randomUUID()}`, connection = await providers.create(scope, { providerId: profile.id, name: "Purpose route", apiKey: "purpose-fixture-key" });
    await providers.addManualModel(scope, connection.id, { expectedRevision: connection.revision, modelId, confirmMetadata: true,
      metadata: { reference: "Controlled protocol fixture", contextTokens: 65536, maxInputTokens: 32768, maxOutputTokens: 8192, tools: true, inputModalities: ["text"], outputModalities: ["text"] } });
    // This setup probe performs a real native tool round against the isolated HTTP fixture.
    await providers.probe(scope, connection.id, { expectedRevision: connection.revision, modelId, allowBillableRequest: true, verifyTools: true }).catch(error => { throw Error(`Setup ${profile.id}: ${error.code}`, { cause: error }); });
    const prior = await providers.getDefault(scope);
    await providers.setDefault(scope, { connectionId: connection.id, modelId, expectedRevision: prior.revision });
    return { modelId, connection };
  }
  async function fixture(profile: typeof profiles[number], offering: "faq" | "customer-service") {
    const owner = await platform.ensureAccount({ issuer: "https://purpose.fixture.test", subject: randomUUID(), email: "owner@example.test", displayName: "Owner" });
    const organization = await platform.createOrganization(owner.id, "Isolated purpose trial"), scope = { accountId: owner.id, organizationId: organization.id };
    const { modelId, connection } = await connectModel(profile, scope);
    const source = await publishFixtureSource(pool, { ...scope, title: "Opening hours", content: "The office opens at nine. Opening hours begin at nine every weekday.", visibility: "public" }, storage);
    const configuration = customerConfiguration(offering); configuration.sourceRevisionIds = [source.id]; configuration.context = { maxInputTokens: 16000, compactAtTokens: 12000 };
    const { agent, snapshot } = await platform.createConfiguredAgent({ ...scope, name: offering, offering, configuration });
    const preview = await trials.preview(owner.id, organization.id, agent.id, { versionId: snapshot.id, rootTokenLimit: 64000 });
    const trial = await trials.prepare(owner.id, organization.id, { trialId: randomUUID(), agentId: agent.id, versionId: snapshot.id,
      expectedCompositionDigest: snapshot.effective_composition.digest, expectedModelRoutesDigest: preview.modelRoutesDigest,
      rootTokenLimit: 64000, maxTokens: 128000, expiresAt: new Date(Date.now() + 600000).toISOString() });
    const deployment = await platform.publishWebsite({ ...scope, agentId: agent.id, versionId: snapshot.id, allowedOrigins: ["https://customer.fixture.test"] });
    await trials.channelSession(owner.id, organization.id, trial.id, { deploymentId: deployment.id, origin: "https://customer.fixture.test" }, "isolated-purpose-signing-secret");
    const session = (await pool.query("SELECT session_id FROM agents_platform.evaluation_trial_channels WHERE trial_id=$1", [trial.id])).rows[0];
    const visitor = { deploymentId: deployment.id, sessionId: session.session_id }, conversation = await inbox.open(visitor);
    return { owner, scope, agent, snapshot, trial, connection, modelId, source, visitor, conversation };
  }
  async function run(f: Omit<Awaited<ReturnType<typeof fixture>>, "source">, body: string) {
    const admitted = await inbox.ingress(f.visitor, f.conversation.id, { requestKey: randomUUID(), body });
    const id = admitted.message.task_id!; expect(id).toBeTruthy();
    const task = await until(async () => { await dispatchTasksOnce(pool, { ingressUrl: ingress, adminUrl: restAdmin }); const task = (await pool.query("SELECT * FROM agents_platform.tasks WHERE id=$1", [id])).rows[0]; return task && terminalTaskStates.has(task.state) ? task : false; });
    const exported = await exportExecutionHistory(pool, id, async db => {
      const authorization = await trials.authorizeVisitorRoot(db, f.owner.id, f.scope.organizationId, id);
      if (!authorization) throw Error("Trial export ownership unavailable"); return authorization;
    });
    expect(exported.modelRoutesDigest).toBe(f.trial.modelRoutesDigest);
    expect(exported.tasks[0]!.modelRoutes.primary.binding).toMatchObject({ providerId: f.connection.providerId, modelId: f.modelId, connectionId: f.connection.id });
    expect(exported.tasks[0]!.modelCalls).toHaveLength(1);
    expect(exported.tasks[0]!.modelCalls[0]!.modelBinding.modelId).toBe(f.modelId);
    expect(JSON.stringify(exported)).not.toContain("purpose-fixture-key");
    return { task, exported };
  }
  for (const profile of profiles) {
    it(`${profile.id}: independently grades FAQ grounding against retrieved evidence`, async () => {
      const f = await fixture(profile, "faq"), before = calls.length;
      const { task, exported } = await run(f, "What are your opening hours?");
      expect(task.state).toBe("completed"); expect(task.output).toContain("nine");
      const root = exported.tasks[0]!, references = root.evidenceReferences as Array<{ source_id: string; revision_id: string; citation_label: string }>;
      expect(references.some(reference => reference.source_id === f.source.sourceId && reference.revision_id === f.source.id)).toBe(true);
      expect(references.some(reference => task.output.includes(`[${reference.citation_label}]`))).toBe(true);
      expect(root.initialOperations).toEqual(expect.arrayContaining([expect.objectContaining({ name: "knowledge.search", state: "completed" })]));
      expect((await inbox.readVisitor(f.visitor, f.conversation.id)).messages.some(message => message.author_kind === "assistant" && message.body === task.output)).toBe(true);
      expect(calls.slice(before).filter(call => !/input_tokens|count_tokens|:countTokens/.test(call.path))).toHaveLength(1);
      proof.push({ purpose: "faq-grounding", provider: profile.id, protocol: profile.protocol, taskId: task.id, trialId: f.trial.id,
        modelRoutesDigest: exported.modelRoutesDigest, evidenceReferences: references.length, outcome: "passed" });
      await trials.revoke(f.owner.id, f.scope.organizationId, f.trial.id);
    }, 30000);
    it(`${profile.id}: independently grades support escalation by canonical Inbox state`, async () => {
      const f = await fixture(profile, "customer-service");
      const { task, exported } = await run(f, "UNKNOWN_PURPOSE_CASE: Please ask a human about an unsupported personal account change.");
      expect(task).toMatchObject({ state: "incomplete", error_code: "CHANNEL_HANDOFF_REQUESTED" });
      expect((await inbox.readVisitor(f.visitor, f.conversation.id)).conversation.state).toBe("handoff_pending");
      expect((await pool.query("SELECT action,command_id FROM agents_platform.customer_commands WHERE conversation_id=$1", [f.conversation.id])).rows).toEqual([{ action: "request_handoff", command_id: task.id }]);
      const result = exported.tasks[0]!.modelCalls[0]!.toolResults[0]!;
      expect(result).toMatchObject({ state: "completed", nativeOutput: { state: "handoff_pending" } });
      expect((await pool.query("SELECT state,message_id FROM agents_platform.customer_deliveries WHERE task_id=$1", [task.id])).rows).toEqual([{ state: "suppressed", message_id: null }]);
      proof.push({ purpose: "support-handoff", provider: profile.id, protocol: profile.protocol, taskId: task.id, trialId: f.trial.id,
        modelRoutesDigest: exported.modelRoutesDigest, inboxState: "handoff_pending", outcome: "passed" });
      await trials.revoke(f.owner.id, f.scope.organizationId, f.trial.id);
    }, 30000);
  }
  for (const profile of profiles.filter(profile => ["openrouter", "anthropic"].includes(profile.id))) {
    it(`${profile.id}: grades booking confirmation, conflict and duplicate prevention by provider records`, async () => {
      for (const conflict of [false, true]) {
        calendar.reset();
        const f = await createBookingFixture(pool, calendar); bookingService = f.service;
        const { modelId, connection } = await connectModel(profile, f.scope);
        const policy = await f.service.createPolicy(f.scope, f.agent.id, f.policyInput);
        const configuration = customerConfiguration("customer-service"); configuration.tools = [];
        configuration.context = { maxInputTokens: 16000, compactAtTokens: 12000 };
        configuration.capabilities.businessActions = { enabled: true, profileId: "calendar-booking-v1", policyId: policy.id, policyDigest: policy.policyDigest };
        const draft = await platform.updateDraft({ ...f.scope, agentId: f.agent.id, configuration, expectedRevision: 1 });
        const snapshot = await platform.createVersion({ ...f.scope, agentId: f.agent.id, expectedRevision: draft.draft_revision });
        const preview = await trials.preview(f.account.id, f.organization.id, f.agent.id, { versionId: snapshot.id, rootTokenLimit: 64000 });
        const trial = await trials.prepare(f.account.id, f.organization.id, { trialId: randomUUID(), agentId: f.agent.id, versionId: snapshot.id,
          expectedCompositionDigest: snapshot.effective_composition.digest, expectedModelRoutesDigest: preview.modelRoutesDigest,
          rootTokenLimit: 64000, maxTokens: 128000, expiresAt: new Date(Date.now() + 600000).toISOString() });
        const deployment = await platform.publishWebsite({ ...f.scope, agentId: f.agent.id, versionId: snapshot.id, allowedOrigins: ["https://customer.fixture.test"] });
        await trials.channelSession(f.account.id, f.organization.id, trial.id, { deploymentId: deployment.id, origin: "https://customer.fixture.test" }, "isolated-purpose-signing-secret");
        const session = (await pool.query("SELECT session_id FROM agents_platform.evaluation_trial_channels WHERE trial_id=$1", [trial.id])).rows[0];
        const visitor = { deploymentId: deployment.id, sessionId: session.session_id }, conversation = await inbox.open(visitor);
        const end = new Date(Date.parse(f.start) + 3600000).toISOString(); bookingPlans.set(modelId, { start: f.start, end, conflict, steps: 0 });
        const input = { requestKey: randomUUID(), body: "Book the consultation after I confirm." };
        const ingressResult = await inbox.ingress(visitor, conversation.id, input), taskId = ingressResult.message.task_id!;
        const intent = await until(async () => {
          await dispatchTasksOnce(pool, { ingressUrl: ingress, adminUrl: restAdmin });
          const row = (await pool.query("SELECT b.*,t.state AS task_state FROM agents_platform.booking_intents b JOIN agents_platform.tasks t ON t.id=b.task_id WHERE b.task_id=$1", [taskId])).rows[0];
          return row?.state === "pending" && row.task_state === "waiting_review" ? row : false;
        });
        const inserts = () => calendar.state.requests.filter(request => request.method === "POST" && request.url.includes("/events?"));
        expect(inserts()).toHaveLength(0);
        if (conflict) calendar.state.busy = [{ start: f.start, end }];
        const principal = (await pool.query("SELECT principal FROM agents_platform.tasks WHERE id=$1", [taskId])).rows[0].principal;
        await f.service.decide(taskId, principal, intent.id, { decision: "approve", requestDigest: intent.request_digest });
        const task = await until(async () => {
          await dispatchTasksOnce(pool, { ingressUrl: ingress, adminUrl: restAdmin });
          const row = (await pool.query("SELECT state,output FROM agents_platform.tasks WHERE id=$1", [taskId])).rows[0]; return terminalTaskStates.has(row.state) ? row : false;
        });
        expect(task.state).toBe("completed");
        const stored = (await pool.query("SELECT state,provider_result FROM agents_platform.booking_intents WHERE id=$1", [intent.id])).rows[0];
        expect(stored.state).toBe(conflict ? "conflict" : "confirmed"); expect(inserts()).toHaveLength(conflict ? 0 : 1);
        if (!conflict) {
          expect(stored.provider_result.receiptDigest).toMatch(/^[a-f0-9]{64}$/);
          expect(calendar.state.events.has(stored.provider_result.eventId)).toBe(true);
        }
        const exported = await exportExecutionHistory(pool, taskId, async db => (await trials.authorizeVisitorRoot(db, f.account.id, f.organization.id, taskId))!);
        expect(exported.modelRoutesDigest).toBe(trial.modelRoutesDigest);
        expect(exported.tasks[0]!.modelCalls).toHaveLength(3);
        expect(exported.tasks[0]!.modelCalls[1]!.toolResults[0]!.nativeOutput).toMatchObject({ state: conflict ? "conflict" : "confirmed" });
        const replay = await inbox.ingress(visitor, conversation.id, input); expect(replay.message.task_id).toBe(taskId);
        await dispatchTasksOnce(pool, { ingressUrl: ingress, adminUrl: restAdmin }); expect(inserts()).toHaveLength(conflict ? 0 : 1);
        proof.push({ purpose: conflict ? "booking-conflict" : "booking-confirmation", provider: profile.id, protocol: profile.protocol,
          taskId, trialId: trial.id, modelRoutesDigest: exported.modelRoutesDigest, providerInserts: inserts().length, duplicateReplay: "same-task-no-insert", outcome: "passed" });
        await trials.revoke(f.account.id, f.organization.id, trial.id);
      }
    }, 60000);
  }
  it("rejects research/campaign purposes in the customer creation API rather than exposing unsupported offerings", async () => {
    const owner = await platform.ensureAccount({ issuer: "https://purpose.fixture.test", subject: randomUUID(), email: "owner@example.test", displayName: "Owner" });
    const org = await platform.createOrganization(owner.id, "Purpose boundaries"), session = await platform.createSession({ accountId: owner.id, providerSessionId: randomUUID(), expiresAt: new Date(Date.now() + 600000) });
    const config = loadPlatformConfig({ NODE_ENV: "test", AGENTS_DATABASE_URL: databaseUrl!, AGENTS_PUBLIC_URL: "https://agents.fixture.test", AGENTS_OIDC_ISSUER_URL: "https://purpose.fixture.test", AGENTS_OIDC_CLIENT_SECRET: "purpose-fixture-session-secret-long" });
    const app = await buildPlatformApp({ config, pool, logging: false });
    try { for (const offering of ["research", "content", "campaign"]) {
      const response = await app.inject({ method: "POST", url: `/api/organizations/${org.id}/agents`, headers: { cookie: `__Host-agents_session=${session.token}`, origin: "https://agents.fixture.test" }, payload: { name: "Unsupported customer purpose", offering } });
      expect(response.statusCode).toBe(400); rejectedCustomerPurposes.push(offering);
    } } finally { await app.close(); }
    expect((await pool.query("SELECT id FROM agents_platform.agents WHERE organization_id=$1", [org.id])).rowCount).toBe(0);
  });
});
