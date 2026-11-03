import {dropClosedTestDatabase} from "./support/database-cleanup";
import { connectFixtureModel } from "./model-fixture";
import {publishFixtureSource} from "./knowledge-fixture";
import * as artifactModule from "../src/infrastructure/object-store";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildPlatformApp } from "../src/composition/app";
import { loadPlatformConfig } from "../src/infrastructure/config";
import { defaultBusinessConfiguration } from "../src/contracts/contracts";
import { setupPlatformSchema } from "../src/composition/setup";
import { PlatformStore } from "../src/product/agents/store";
import { settleTask } from "../src/execution/lifecycle/execution";
import { admitChildren } from "../src/execution/delegation/delegation";
import { HARNESS_RELEASE } from "../src/contracts/execution";

const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const browserOrigin = "http://localhost:3100";
// The fixture supplies a validated identity directly to persistence. It does not test an OIDC provider.
suite("Agents HTTP and PostgreSQL integration", () => {
  let admin: Pool;
  let pool: Pool;
  let store: PlatformStore;
  let app: Awaited<ReturnType<typeof buildPlatformApp>>;
  let endpoint: string;
  const bodies=new Map<string,Uint8Array>(),objects={async put(key:string,value:Uint8Array){bodies.set(key,value);},async get(key:string){const body=bodies.get(key);if(!body)throw Error("Missing fixture source");return body;},async delete(key:string){bodies.delete(key);}};
  const name = `agents_http_test_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${name}`;
    pool = new Pool({ connectionString: url.href, max: 10 });
    await setupPlatformSchema(pool);
    const config = loadPlatformConfig({ NODE_ENV: "test", AGENTS_DATABASE_URL: url.href,
      AGENTS_PUBLIC_URL: browserOrigin, AGENTS_LOGIN_RETURN_SECRET: "isolated-trial-signing-secret-32-characters", AGENTS_OIDC_CLIENT_SECRET: "offline-integration-test-secret-only",
      OPENROUTER_API_KEY: "offline-test-key-never-sent" });
    vi.spyOn(artifactModule,"privateStoreFromEnvironment").mockReturnValue(objects);
    app = await buildPlatformApp({ config, pool, logging: false });
    endpoint = await app.listen({ port: 0, host: "127.0.0.1" });
    store = new PlatformStore(pool);
  });
  afterAll(async () => {
    await app?.close(); await pool?.end(); vi.restoreAllMocks();
    if (admin) { await dropClosedTestDatabase(admin,name); await admin.end(); }
  });
  async function request(path: string, options: { method?: string; payload?: unknown; cookie?: string; origin?: string; token?: string } = {}) {
    const headers: Record<string, string> = {};
    if (options.origin !== undefined) headers.origin = options.origin;
    if (options.cookie) headers.cookie = options.cookie;
    if (options.token) headers.authorization = `Bearer ${options.token}`;
    if (options.payload !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(endpoint + path, { method: options.method ?? "GET", headers,
      body: options.payload === undefined ? undefined : JSON.stringify(options.payload) });
    const body = response.status === 204 ? null : await response.json() as any;
    return { status: response.status, body, headers: response.headers };
  }
  async function actor() {
    const account = await store.ensureAccount({ issuer: "http://localhost:8080/realms/kasitek", subject: randomUUID(), email: "owner@example.com", displayName: "Owner" });
    const session = await store.createSession({ accountId: account.id, providerSessionId: randomUUID(), expiresAt: new Date(Date.now() + 60 * 60_000) });
    const cookie = `agents_session=${session.token}`;
    const organization = await request("/api/organizations", { method: "POST", cookie, origin: browserOrigin, payload: { name: "Example" } });
    expect(organization.status).toBe(201);
    await connectFixtureModel(pool, account.id, organization.body.organization.id);
    return { account, cookie, org: organization.body.organization.id as string };
  }
  it("opens an existing first-login session with one automatic workspace across reloads", async () => {
    const user = await store.ensureAccount({ issuer: "http://localhost:8080/realms/kasitek", subject: randomUUID(), email: "first@example.test", displayName: "First owner" });
    const session = await store.createSession({ accountId: user.id, providerSessionId: randomUUID(), expiresAt: new Date(Date.now() + 60000) });
    const cookie = `agents_session=${session.token}`;
    const first = await request("/api/session", {cookie});
    expect(first.status).toBe(200);
    expect(first.body.organizations).toHaveLength(1);
    expect(first.body.organizations[0]).toMatchObject({name: "My workspace", role: "owner"});
    expect((await request("/api/session", {cookie})).body.organizations).toEqual(first.body.organizations);
  });

  it("creates one customer-service offering and saves guided preferences through the HTTP contract", async () => {
    const f=await actor(),base=`/api/organizations/${f.org}`;
    const catalogue=await request(`${base}/offerings`,{cookie:f.cookie});
    expect(catalogue.body.offerings.map((item:{id:string})=>item.id)).toEqual(["customer-service"]);
    const setup={business:{name:"Studio",website:"",description:"Customer support"},responsibilities:["bookings","enquiries"],channels:["website","whatsapp"],booking:{durationMinutes:30,notes:"Weekdays"},intake:{fields:["name","email"]},behaviour:{agentName:"Studio assistant",language:"English",tone:"friendly",handoffInstructions:"Ask our team"}};
    const created=await request(`${base}/agents`,{method:"POST",cookie:f.cookie,origin:browserOrigin,payload:{name:"Studio assistant",offering:"customer-service",setup}});
    expect(created.status).toBe(201);expect(created.body.agent.setup).toEqual(setup);
    expect(created.body.agent.draft.instructions).toContain("Never claim availability");
    const preferences={...setup,behaviour:{...setup.behaviour,language:"Zulu",tone:"professional"}};
    const saved=await request(`${base}/agents/${created.body.agent.id}/configuration`,{method:"POST",cookie:f.cookie,origin:browserOrigin,payload:{name:"Studio assistant",configuration:created.body.agent.draft,expectedRevision:created.body.agent.draftRevision,setup:preferences,confirmImpact:true}});
    expect(saved.status).toBe(200);expect(saved.body.agent.setup).toEqual(preferences);
    expect(saved.body.agent.draft.instructions).toContain('"Zulu"');
    expect(saved.body.agent.draft.tools).toEqual(created.body.agent.draft.tools);
    const loaded=await request(`${base}/agents/${created.body.agent.id}`,{cookie:f.cookie});
    expect(loaded.body.agent.setup).toEqual(preferences);
  });

  it("stores bare website domains as deduplicated HTTPS origins", async () => {
    const f = await readyAgent();
    const result = await request(`${f.base}/agents/${f.agent.id}/deployments`, {method: "POST", cookie: f.cookie, origin: browserOrigin,
      payload: {allowedOrigins: ["kasitek.co.za", "https://kasitek.co.za/"]}});
    expect(result.status).toBe(201);
    expect(result.body.deployment.allowedOrigins).toEqual(["https://kasitek.co.za"]);
  });

  async function readyAgent(visibility: "public" | "private" = "public") {
    const user = await actor(), base = `/api/organizations/${user.org}`;
    const create = await request(`${base}/agents`, { method: "POST", cookie: user.cookie, origin: browserOrigin, payload: { name: "Opening hours" } });
    expect(create.status).toBe(201);
    const source=await publishFixtureSource(pool,{accountId:user.account.id,organizationId:user.org,title:"Hours",content:"The shop opens Monday at nine.",visibility},objects);
    const configuration = { ...defaultBusinessConfiguration(), sourceRevisionIds: [source.id] };
    const update = await request(`${base}/agents/${create.body.agent.id}`, { method: "PUT", cookie: user.cookie, origin: browserOrigin,
      payload: { configuration, expectedRevision: create.body.agent.draftRevision } });
    expect(update.status).toBe(200);
    const version = await request(`${base}/agents/${create.body.agent.id}/versions`, { method: "POST", cookie: user.cookie, origin: browserOrigin,
      payload: { expectedRevision: update.body.agent.draftRevision } });
    expect(version.status).toBe(201);
    return { ...user, base, agent: update.body.agent, version: version.body.version, configuration };
  }
  async function publish(f: Awaited<ReturnType<typeof readyAgent>>) {
    return request(`${f.base}/agents/${f.agent.id}/deployments`, { method: "POST", cookie: f.cookie, origin: browserOrigin,
      payload: { versionId: f.version.id, allowedOrigins: ["https://shop.example"] } });
  }

  it("creates the customer-service offering and rejects obsolete offering identities",async()=>{
    const user=await actor(),base=`/api/organizations/${user.org}`;
    const catalog=await request(`${base}/offerings`,{cookie:user.cookie});expect(catalog.body.offerings).toEqual([expect.objectContaining({id:"customer-service",available:true})]);
    for(const offering of ["customer-service"]){
      const created=await request(`${base}/agents`,{method:"POST",cookie:user.cookie,origin:browserOrigin,payload:{name:"Customer agent",offering}});expect(created.status).toBe(201);
      expect(created.body.agent.offering).toBe(offering);expect(created.body.agent.draft.program).toEqual({id:"grounded-conversation",version:"1"});expect(created.body.agent.draft.tools).toEqual(["knowledge.search","knowledge.read","channel.request_handoff"]);
      expect(created.body.agent.draft.instructions).toContain("Help customers");
      expect(created.body.agent.draft.capabilities.delegation.enabled).toBe(false);expect(created.body.agent.draft.capabilities.sandbox.enabled).toBe(false);
    }
    for(const offering of ["faq","booking"]){
      const unavailable=await request(`${base}/agents`,{method:"POST",cookie:user.cookie,origin:browserOrigin,payload:{name:"Unavailable",offering}});expect(unavailable.status).toBe(400);
    }
    expect((await pool.query("SELECT count(*)::int n FROM agents_platform.agents WHERE organization_id=$1",[user.org])).rows[0].n).toBe(2);
  });

  it("pins publication and admission compositions while rejecting broader FAQ programs", async () => {
    const f = await readyAgent();
    expect(f.version.effectiveComposition).toMatchObject({ program: { id: "tool-directed", version: "1" }, runtime: { release: HARNESS_RELEASE } });
    const accepted = await request(`${f.base}/tasks`, { method: "POST", cookie: f.cookie, origin: browserOrigin,
      payload: { versionId: f.version.id, input: "Hello", requestKey: "pinned" } });
    expect(accepted.status).toBe(202);
    expect(accepted.body.task.effectiveComposition.digest).toBe(f.version.effectiveComposition.digest);
    const update = await request(`${f.base}/agents/${f.agent.id}`, { method: "PUT", cookie: f.cookie, origin: browserOrigin,
      payload: { expectedRevision: 2, configuration: { ...f.configuration, program: { id: "grounded-conversation", version: "1" }, memory: { enabled: true } } } });
    expect(update.status).toBe(200);
    const publish = await request(`${f.base}/agents/${f.agent.id}/versions`, { method: "POST", cookie: f.cookie, origin: browserOrigin, payload: { expectedRevision: 3 } });
    expect(publish.status).toBe(409); expect(publish.body.error.code).toBe("PROGRAM_COMPOSITION_DENIED");
    expect((await store.getVersion(f.account.id, f.org, f.version.id)).effective_composition.digest).toBe(f.version.effectiveComposition.digest);
  });

  it("isolates evaluation scopes, recovers lost acknowledgements and fences revoked trials", async () => {
    const f = await readyAgent(), trialId = randomUUID();
    const preview = await request(`${f.base}/agents/${f.agent.id}/model-preview`, { method: "POST", cookie: f.cookie, origin: browserOrigin, payload: { versionId: f.version.id, rootTokenLimit: 16384 } });
    expect(preview.status).toBe(200);
    const prepare = { expectedModelRoutesDigest: preview.body.modelRoutesDigest, rootTokenLimit: 16384, trialId, agentId: f.agent.id, versionId: f.version.id, expectedCompositionDigest: f.version.effectiveComposition.digest,
      maxTokens: 32768, expiresAt: new Date(Date.now() + 600_000).toISOString() };
    const mismatch = await request(`${f.base}/evaluation-trials`, { method: "POST", cookie: f.cookie, origin: browserOrigin,
      payload: { ...prepare, expectedCompositionDigest: "0".repeat(64) } });
    expect(mismatch.status).toBe(409);
    const first = await request(`${f.base}/evaluation-trials`, { method: "POST", cookie: f.cookie, origin: browserOrigin, payload: prepare });
    expect(first.status).toBe(201);
    const replay = await request(`${f.base}/evaluation-trials`, { method: "POST", cookie: f.cookie, origin: browserOrigin, payload: prepare });
    expect(replay.body.trial.id).toBe(first.body.trial.id);
    const lookup = await request(`${f.base}/evaluation-trials?trialId=${trialId}`, { cookie: f.cookie });
    expect(lookup.body.trial.id).toBe(first.body.trial.id); expect(lookup.body.rootTaskIds).toEqual([]);
    const normal = await request(`${f.base}/tasks`, { method: "POST", cookie: f.cookie, origin: browserOrigin,
      payload: { versionId: f.version.id, input: "Bypass trial", requestKey: "ordinary" } });
    expect(normal.status).toBe(403); expect(normal.body.error.code).toBe("EVALUATION_SCOPE_REQUIRED");
    const payload = { versionId: f.version.id, input: "Hello", requestKey: "trial-root", evaluationTrialId: first.body.trial.id, evaluationRootTokenLimit: 16384 };
    const accepted = await request(first.body.submitPath, { method: "POST", cookie: f.cookie, origin: browserOrigin, payload });
    expect(accepted.status).toBe(202);
    const duplicate = await request(first.body.submitPath, { method: "POST", cookie: f.cookie, origin: browserOrigin, payload });
    expect(duplicate.body.task.id).toBe(accepted.body.task.id);
    expect((await pool.query("SELECT allocated_tokens FROM agents_platform.evaluation_trials WHERE id=$1", [first.body.trial.id])).rows[0].allocated_tokens).toBe(16384);
    const roots = await request(`${f.base}/evaluation-trials/${first.body.trial.id}`, { cookie: f.cookie });
    expect(roots.body.rootTaskIds).toEqual([accepted.body.task.id]);
    const revoked = await request(first.body.revokePath, { method: "POST", cookie: f.cookie, origin: browserOrigin, payload: {} });
    expect(revoked.body.trial.state).toBe("revoked"); expect(revoked.body.cancellationRequested).toBe(true);
    expect((await pool.query("SELECT state FROM agents_platform.tasks WHERE id=$1", [accepted.body.task.id])).rows[0].state).toBe("cancel_requested");
    const blocked = await request(first.body.submitPath, { method: "POST", cookie: f.cookie, origin: browserOrigin, payload: { ...payload, requestKey: "after-revoke" } });
    expect(blocked.status).toBe(403); expect(blocked.body.error.code).toBe("EVALUATION_TRIAL_INACTIVE");
  });

  it("binds evaluation visitors server-side and exposes channel evidence only to the trial owner",async()=>{
    const f=await readyAgent(),deployed=await publish(f);expect(deployed.status).toBe(201);
    const preview=await request(`${f.base}/agents/${f.agent.id}/model-preview`,{method:"POST",cookie:f.cookie,origin:browserOrigin,payload:{versionId:f.version.id,rootTokenLimit:16384}});
    const prepared=await request(`${f.base}/evaluation-trials`,{method:"POST",cookie:f.cookie,origin:browserOrigin,payload:{expectedModelRoutesDigest:preview.body.modelRoutesDigest,rootTokenLimit:16384,trialId:randomUUID(),agentId:f.agent.id,versionId:f.version.id,expectedCompositionDigest:f.version.effectiveComposition.digest,maxTokens:16384,expiresAt:new Date(Date.now()+600000).toISOString()}});
    expect(prepared.status).toBe(201);const path=`${f.base}/evaluation-trials/${prepared.body.trial.id}`;
    const payload={deploymentId:deployed.body.deployment.id,origin:"https://shop.example"};
    const scope=await request(`${path}/channel-session`,{method:"POST",cookie:f.cookie,origin:browserOrigin,payload});expect(scope.status).toBe(200);
    expect((await request(`${path}/channel-session`,{method:"POST",cookie:f.cookie,origin:browserOrigin,payload})).body).toEqual(scope.body);
    const invalid=await request(`${path}/channel-session`,{method:"POST",cookie:f.cookie,origin:browserOrigin,payload:{...payload,origin:"https://evil.example"}});expect(invalid.status).toBe(403);
    const visitor={token:scope.body.token,origin:payload.origin},website=`/api/website/${payload.deploymentId}/customer-conversations`;
    const opened=await request(website,{...visitor,method:"POST",payload:{}});expect(opened.status).toBe(200);
    const message={requestKey:"lost-channel-ack",body:"When do you open?"};
    const accepted=await request(`${website}/${opened.body.conversation.id}/messages`,{...visitor,method:"POST",payload:message});expect(accepted.status).toBe(201);
    expect((await request(`${website}/${opened.body.conversation.id}/messages`,{...visitor,method:"POST",payload:message})).body.replayed).toBe(true);
    const history=await request(`${path}/channel-history`,{cookie:f.cookie});expect(history.status).toBe(200);expect(history.body.messages).toHaveLength(1);expect(history.body.rootTaskIds).toHaveLength(1);
    const root=history.body.rootTaskIds[0];
    const status=await request(`${f.base}/tasks/${root}`,{cookie:f.cookie});expect(status.status).toBe(200);expect(status.body.task.evaluationTrialId).toBe(prepared.body.trial.id);
    expect((await request(`${f.base}/tasks/${root}/history-export`,{cookie:f.cookie})).status).toBe(200);
    const other=await actor();await pool.query("INSERT INTO agents_platform.memberships(organization_id,account_id,role) VALUES($1,$2,'member')",[f.org,other.account.id]);
    expect((await request(`${path}/channel-history`,{cookie:other.cookie})).status).toBe(404);
    expect((await request(`${f.base}/tasks/${root}`,{cookie:other.cookie})).status).toBe(404);
    expect((await request(`${f.base}/tasks/${root}/history-export`,{cookie:other.cookie})).status).toBe(403);
    expect((await pool.query("SELECT allocated_tokens FROM agents_platform.evaluation_trials WHERE id=$1",[prepared.body.trial.id])).rows[0].allocated_tokens).toBe(16384);
    expect((await request(`${path}/revoke`,{method:"POST",cookie:f.cookie,origin:browserOrigin,payload:{}})).status).toBe(200);
    expect((await request(`${website}/${opened.body.conversation.id}/messages`,{...visitor,method:"POST",payload:{...message,requestKey:"after-revoke"}})).status).toBe(401);
    expect((await request(`${f.base}/tasks/${root}/history-export`,{cookie:f.cookie})).status).toBe(200);
  });

  it("rejects the removed direct approval route and scalar configuration authority",async()=>{
    const user=await actor(),base=`/api/organizations/${user.org}`;
    expect((await request(`${base}/knowledge`,{cookie:user.cookie})).status).toBe(404);
    expect((await request(`${base}/knowledge`,{method:"POST",cookie:user.cookie,origin:browserOrigin,payload:{title:"Bypass",content:"Unreviewed data",visibility:"public"}})).status).toBe(404);
    expect((await request(`${base}/agents`,{method:"POST",cookie:user.cookie,origin:browserOrigin,payload:{name:"Unreviewed",configuration:{...defaultBusinessConfiguration(),knowledgeIds:[randomUUID()]}}})).status).toBe(400);
  });

  it("runs authenticated create, configure, test admission and publication with immutable live configuration", async () => {
    const f = await readyAgent();
    const session = await request("/api/session", { cookie: f.cookie });
    expect(session.body.organizations.map((org: { id: string }) => org.id)).toContain(f.org);
    const detail = await request(`${f.base}/agents/${f.agent.id}`, { cookie: f.cookie });
    expect(detail.body.versions[0].id).toBe(f.version.id);
    const duplicateVersion = await request(`${f.base}/agents/${f.agent.id}/versions`, { method: "POST", cookie: f.cookie, origin: browserOrigin, payload: { expectedRevision: 2 } });
    expect(duplicateVersion.body.version.id).toBe(f.version.id);
    const payload = { versionId: f.version.id, requestKey: "test-question", input: "When does the shop open?" };
    const accepted = await request(`${f.base}/tasks`, { method: "POST", cookie: f.cookie, origin: browserOrigin, payload });
    expect(accepted.status).toBe(202);
    expect(accepted.body.task.state).toBe("accepted");
    const replay = await request(`${f.base}/tasks`, { method: "POST", cookie: f.cookie, origin: browserOrigin, payload });
    expect(replay.status).toBe(200);
    expect(replay.body.task.id).toBe(accepted.body.task.id);
    const changed = await request(`${f.base}/tasks`, { method: "POST", cookie: f.cookie, origin: browserOrigin, payload: { ...payload, input: "Different question" } });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    const status = await request(`${f.base}/tasks/${accepted.body.task.id}`, { cookie: f.cookie });
    expect(status.body.events[0].kind).toBe("accepted");
    const history = await request(`${f.base}/conversations/${accepted.body.task.conversationId}`, { cookie: f.cookie });
    expect(history.status).toBe(200); expect(history.body.tasks[0].id).toBe(accepted.body.task.id);
    const published = await publish(f); expect(published.status).toBe(201);
    const newDraft = await request(`${f.base}/agents/${f.agent.id}`, { method: "PUT", cookie: f.cookie, origin: browserOrigin,
      payload: { configuration: { ...f.configuration, instructions: "Draft revision after publication" }, expectedRevision: 2 } });
    expect(newDraft.status).toBe(200);
    const later = await request(`${f.base}/agents/${f.agent.id}`, { cookie: f.cookie });
    expect(later.body.deployments[0].versionId).toBe(f.version.id);
    expect(later.body.versions[0].configuration.instructions).not.toBe("Draft revision after publication");
    expect((await request("/ready")).status).toBe(200);
  });

  it("refuses private website knowledge, disabled capabilities and unavailable workspace execution", async () => {
    const f = await readyAgent("private");
    const refused = await publish(f);
    expect(refused.status).toBe(409); expect(refused.body.error.code).toBe("PRIVATE_KNOWLEDGE");
    const disabled = await request(`${f.base}/agents/${f.agent.id}`, { method: "PUT", cookie: f.cookie, origin: browserOrigin,
      payload: { configuration: { ...f.configuration, capabilities: { ...f.configuration.capabilities, sandbox: { enabled: true } } }, expectedRevision: 2 } });
    expect(disabled.status).toBe(400);
    const unknown = await request(`${f.base}/agents/${f.agent.id}`, { method: "PUT", cookie: f.cookie, origin: browserOrigin,
      payload: { configuration: { ...f.configuration, arbitraryTool: "shell" }, expectedRevision: 2 } });
    expect(unknown.status).toBe(400);
    const updated = await request(`${f.base}/agents/${f.agent.id}`, { method: "PUT", cookie: f.cookie, origin: browserOrigin,
      payload: { configuration: { ...f.configuration, executionKind: "workspace" }, expectedRevision: 2 } });
    expect(updated.status).toBe(200);
    const version = await request(`${f.base}/agents/${f.agent.id}/versions`, { method: "POST", cookie: f.cookie, origin: browserOrigin, payload: { expectedRevision: 3 } });
    expect(version.status).toBe(503); expect(version.body.error.code).toBe("RUNTIME_UNAVAILABLE");
    expect(Number((await pool.query("SELECT count(*) FROM agents_platform.agent_versions WHERE agent_id=$1 AND execution_kind='workspace'", [f.agent.id])).rows[0].count)).toBe(0);
  });

  it("requires sessions, exact browser origin and current product membership", async () => {
    const f = await readyAgent(), other = await actor();
    const noSession = await request(`${f.base}/agents`); expect(noSession.status).toBe(401);
    const foreign = await request(`${f.base}/agents`, { cookie: other.cookie }); expect(foreign.status).toBe(403);
    for (const origin of ["https://evil.example", undefined]) {
      const csrf = await request("/api/organizations", { method: "POST", cookie: f.cookie, origin, payload: { name: "Cross-origin organization" } });
      expect(csrf.status).toBe(403); expect(csrf.body.error.code).toBe("ORIGIN_DENIED");
    }
    await pool.query("UPDATE agents_platform.memberships SET revoked_at=now() WHERE organization_id=$1 AND account_id=$2", [f.org, f.account.id]);
    expect((await request(`${f.base}/agents`, { cookie: f.cookie })).status).toBe(403);
    await store.revokeSession(f.cookie.split("=")[1]!);
    expect((await request("/api/session", { cookie: f.cookie })).status).toBe(401);
  });

  it("allows the metadata preflight when a saved website session sends authorization", async () => {
    const f = await readyAgent(), deployed = await publish(f);
    const base = `/api/website/${deployed.body.deployment.id}`, origin = "https://shop.example";
    const session = await request(`${base}/session`, { method: "POST", origin });
    expect(session.status).toBe(201);
    const headers = { origin, "access-control-request-method": "GET", "access-control-request-headers": "authorization" };
    const preflight = await fetch(endpoint + base, { method: "OPTIONS", headers });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
    expect(preflight.headers.get("access-control-allow-headers")?.toLowerCase()).toContain("authorization");
    expect(preflight.headers.get("access-control-allow-methods")).toContain("GET");
    const metadata = await request(base, { origin, token: session.body.token });
    expect(metadata.status).toBe(200); expect(metadata.headers.get("access-control-allow-origin")).toBe(origin);
    const denied = await fetch(endpoint + base, { method: "OPTIONS", headers: { ...headers, origin: "https://unrelated.example" } });
    expect(denied.status).toBe(403); expect(denied.headers.get("access-control-allow-origin")).toBeNull();
    const missing = await fetch(endpoint + `/api/website/${randomUUID()}`, { method: "OPTIONS", headers });
    expect(missing.status).toBe(404); expect(missing.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("binds anonymous access to allowed origins and opaque visitor sessions", async () => {
    const f = await readyAgent(), deployed = await publish(f); expect(deployed.status).toBe(201);
    const base = `/api/website/${deployed.body.deployment.id}`;
    const widget = await fetch(endpoint + `${base}/widget.js`);
    expect(widget.status).toBe(200); expect(widget.headers.get("content-type")).toContain("javascript");
    const script = await widget.text(); expect(script).toContain("fetch("); expect(script).not.toContain("iframe");
    const preflight = await request(`${base}/tasks`, { method: "OPTIONS", origin: "https://shop.example" });
    expect(preflight.status).toBe(204); expect(preflight.headers.get("access-control-allow-origin")).toBe("https://shop.example");
    const blocked = await request(`${base}/session`, { method: "POST", origin: "https://evil.example" });
    expect(blocked.status).toBe(403);
    const first = await request(`${base}/session`, { method: "POST", origin: "https://shop.example" });
    const second = await request(`${base}/session`, { method: "POST", origin: "https://shop.example" });
    expect(first.status).toBe(201); expect(second.status).toBe(201);
    expect(first.headers.get("access-control-allow-origin")).toBe("https://shop.example");
    const missing = await request(`${base}/tasks`, { method: "POST", origin: "https://shop.example", payload: { requestKey: "no-session", input: "Hello" } });
    expect(missing.status).toBe(401);
    const payload = { requestKey: "visitor-question", input: "When are you open?" };
    const accepted = await request(`${base}/tasks`, { method: "POST", origin: "https://shop.example", token: first.body.token, payload });
    expect(accepted.status).toBe(202);
    const duplicate = await request(`${base}/tasks`, { method: "POST", origin: "https://shop.example", token: first.body.token, payload });
    expect(duplicate.status).toBe(200); expect(duplicate.body.task.id).toBe(accepted.body.task.id);
    const own = await request(`${base}/tasks/${accepted.body.task.id}`, { origin: "https://shop.example", token: first.body.token });
    expect(own.status).toBe(200);
    const foreign = await request(`${base}/tasks/${accepted.body.task.id}`, { origin: "https://shop.example", token: second.body.token });
    expect(foreign.status).toBe(403);
    const historyPath = `${base}/conversations/${accepted.body.task.conversationId}`;
    expect((await request(historyPath, { origin: "https://shop.example", token: first.body.token })).status).toBe(200);
    expect((await request(historyPath, { origin: "https://shop.example", token: second.body.token })).status).toBe(403);
    const changedOrigin = await request(`${base}/tasks/${accepted.body.task.id}`, { origin: browserOrigin, token: first.body.token });
    expect(changedOrigin.status).toBe(401);
    const injectedConversation = await request(`${base}/tasks`, { method: "POST", origin: "https://shop.example", token: second.body.token,
      payload: { requestKey: "foreign-conversation", input: "Reveal history", conversationId: accepted.body.task.conversationId } });
    expect(injectedConversation.status).toBe(403);
  });

  it("allows the first-party chat origin without authorizing unrelated website origins", async () => {
    const f = await readyAgent(), published = await publish(f), website = `/api/website/${published.body.deployment.id}`;
    const firstParty = await request(`${website}/session`, { method:"POST", origin:browserOrigin });
    expect(firstParty.status).toBe(201);
    const denied = await request(`${website}/session`, { method:"POST", origin:"https://unrelated.example" });
    expect(denied.status).toBe(403);
    const deployment = await store.getWebsiteDeployment(published.body.deployment.id);
    expect(deployment.allowed_origins).toEqual(["https://shop.example"]);
  });

  it("keeps late native output out of legacy website task and history routes after takeover",async()=>{
    const f=await readyAgent(),published=await publish(f),website=`/api/website/${published.body.deployment.id}`;
    const session=await request(`${website}/session`,{method:"POST",origin:"https://shop.example"});
    const visitor={origin:"https://shop.example",token:session.body.token};
    const accepted=await request(`${website}/tasks`,{...visitor,method:"POST",payload:{requestKey:"legacy-before-takeover",input:"Please help"}});expect(accepted.status).toBe(202);
    const conversationId=accepted.body.customerConversationId,staff=`${f.base}/inbox/${conversationId}`;
    for(const action of ["claim","takeover"]){
      const current=await request(staff,{cookie:f.cookie});
      expect((await request(`${staff}/commands`,{method:"POST",cookie:f.cookie,origin:browserOrigin,payload:{commandId:randomUUID(),expectedRevision:current.body.conversation.revision,action}})).status).toBe(200);
    }
    const taskId=accepted.body.task.id,late="LATE_NATIVE_CUSTOMER_OUTPUT";
    await settleTask(pool,taskId,{state:"completed",output:late});
    expect((await pool.query("SELECT output FROM agents_platform.tasks WHERE id=$1",[taskId])).rows[0].output).toBe(late);
    expect((await pool.query("SELECT state FROM agents_platform.customer_deliveries WHERE task_id=$1",[taskId])).rows[0].state).toBe("suppressed");
    for(const path of [`${website}/tasks/${taskId}`,`${website}/tasks/${taskId}/evidence`,`${website}/conversations/${accepted.body.task.conversationId}`,`${website}/customer-conversations/${conversationId}/messages`]){
      const result=await request(path,visitor);expect(result.status).toBe(200);expect(JSON.stringify(result.body)).not.toContain(late);
      if(result.body.task)expect(result.body.task.output).toBeNull();
    }
    const duringHuman=await request(`${website}/tasks`,{...visitor,method:"POST",payload:{requestKey:"legacy-during-human",input:"Another question"}});expect(duringHuman.status).toBe(202);expect(duringHuman.body.task).toBeNull();
    expect((await pool.query("SELECT count(*)::int n FROM agents_platform.tasks WHERE organization_id=$1",[f.org])).rows[0].n).toBe(1);
  });

  it("authorizes child inspection through the original root and renews waiting specialists without new tasks", async () => {
    const f=await readyAgent();
    const specialist=await store.createAgent({accountId:f.account.id,organizationId:f.org,name:"Research specialist",configuration:f.configuration});
    const specialistVersion=await store.createVersion({accountId:f.account.id,organizationId:f.org,agentId:specialist.id,expectedRevision:1});
    const configuration={...f.configuration,tools:["agents.delegate"],capabilities:{...f.configuration.capabilities,
      delegation:{enabled:true,maxChildren:2,maxDepth:1,bindings:[{id:"research",versionId:specialistVersion.id,sourceRevisionIds:f.configuration.sourceRevisionIds,tools:[],maxTokens:8000,maxActiveMs:240000}]}}};
    const update=await request(`${f.base}/agents/${f.agent.id}`,{method:"PUT",cookie:f.cookie,origin:browserOrigin,payload:{configuration,expectedRevision:f.agent.draftRevision}});
    expect(update.status).toBe(200);
    const version=await request(`${f.base}/agents/${f.agent.id}/versions`,{method:"POST",cookie:f.cookie,origin:browserOrigin,payload:{expectedRevision:update.body.agent.draftRevision}});
    expect(version.status).toBe(201);
    const admitted=await request(`${f.base}/tasks`,{method:"POST",cookie:f.cookie,origin:browserOrigin,payload:{versionId:version.body.version.id,requestKey:"delegated-http",input:"Research hours"}});
    expect(admitted.status).toBe(202);const root=admitted.body.task;
    const [child]=await admitChildren(pool,root.id,"http:delegation",{requests:[{bindingId:"research",brief:"Inspect hours"}]});
    const detail=await request(`${f.base}/tasks/${child!.taskId}`,{cookie:f.cookie});
    expect(detail.status).toBe(200);expect(detail.body.task.rootTaskId).toBe(root.id);expect(detail.body.task.parentTaskId).toBe(root.id);
    expect((await request(`${f.base}/tasks/${child!.taskId}/cancel`,{method:"POST",cookie:f.cookie,origin:browserOrigin})).status).toBe(409);
    const other=await actor();await pool.query("INSERT INTO agents_platform.memberships(organization_id,account_id,role) VALUES($1,$2,'member')",[f.org,other.account.id]);
    expect((await request(`${f.base}/tasks/${child!.taskId}`,{cookie:other.cookie})).status).toBe(403);
    await pool.query("UPDATE agents_platform.tasks SET state='waiting_children' WHERE id=$1",[root.id]);
    await pool.query("UPDATE agents_platform.tasks SET state='waiting_authority' WHERE id=$1",[child!.taskId]);
    await pool.query("UPDATE agents_platform.execution_grants SET expires_at=now()-interval '1 second',created_at=now()-interval '1 minute' WHERE id=$1",[root.grantId]);
    const continued=await request(`${f.base}/tasks/${root.id}/continue`,{method:"POST",cookie:f.cookie,origin:browserOrigin});
    expect(continued.status).toBe(200);expect(continued.body.task.id).toBe(root.id);expect(continued.body.task.state).toBe("waiting_children");
    expect(continued.body.task.grantId).not.toBe(root.grantId);
    expect((await pool.query("SELECT count(*)::int AS count FROM agents_platform.tasks WHERE root_task_id=$1",[root.id])).rows[0].count).toBe(2);
    expect((await pool.query("SELECT task_id FROM agents_platform.task_controls WHERE task_id=$1",[child!.taskId])).rowCount).toBe(1);
    await pool.query("UPDATE agents_platform.execution_grants SET revoked_at=now() WHERE id=$1",[continued.body.task.grantId]);
    expect((await request(`${f.base}/tasks/${root.id}/continue`,{method:"POST",cookie:f.cookie,origin:browserOrigin})).status).toBe(403);
    expect((await request(`${f.base}/tasks/${root.id}`,{cookie:f.cookie})).status).toBe(200);
    const branch=(await pool.query("SELECT conversation_id FROM agents_platform.tasks WHERE id=$1",[child!.taskId])).rows[0];
    await pool.query("UPDATE agents_platform.tasks SET output='Deleted source evidence' WHERE id=$1",[child!.taskId]);
    const deleted=await request(`${f.base}/conversations/${branch.conversation_id}`,{method:"DELETE",cookie:f.cookie,origin:browserOrigin});
    expect(deleted.status).toBe(200);
    const afterDelete=await request(`${f.base}/tasks/${root.id}`,{cookie:f.cookie});
    expect(afterDelete.body.children[0].output).toBeNull();
    const childDeleted=await request(`${f.base}/tasks/${child!.taskId}`,{cookie:f.cookie});
    expect(childDeleted.body.task.output).toBeNull();expect(childDeleted.body.task.input).toBe("[Deleted conversation]");
  });

  it("records cancellation intent separately from a terminal cancellation result", async () => {
    const f = await readyAgent();
    const accepted = await request(`${f.base}/tasks`, { method: "POST", cookie: f.cookie, origin: browserOrigin,
      payload: { versionId: f.version.id, requestKey: "cancel-test", input: "Answer this" } });
    const cancelPath = `${f.base}/tasks/${accepted.body.task.id}/cancel`;
    const cancelled = await request(cancelPath, { method: "POST", cookie: f.cookie, origin: browserOrigin });
    expect(cancelled.status).toBe(200); expect(cancelled.body.task.state).toBe("cancel_requested");
    await request(cancelPath, { method: "POST", cookie: f.cookie, origin: browserOrigin });
    const status = await request(`${f.base}/tasks/${accepted.body.task.id}`, { cookie: f.cookie });
    expect(status.body.events.filter((event: { kind: string }) => event.kind === "cancel_requested")).toHaveLength(1);
    expect(status.body.events.some((event: { kind: string }) => event.kind === "cancelled")).toBe(false);
    const other = await actor();
    await pool.query("INSERT INTO agents_platform.memberships(organization_id,account_id,role) VALUES($1,$2,'member')", [f.org, other.account.id]);
    expect((await request(cancelPath, { method: "POST", cookie: other.cookie, origin: browserOrigin })).status).toBe(403);
    expect((await request(`${f.base}/conversations/${accepted.body.task.conversationId}`, { cookie: other.cookie })).status).toBe(403);
  });
});
