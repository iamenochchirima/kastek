import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type ServerHttp2Session } from "node:http2";
import { resolve } from "node:path";
import { createEndpointHandler } from "@restatedev/restate-sdk";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { callFaqModel, createBusinessWorkflow, retrieveFaqKnowledge } from "../src/platform/business";
import { defaultFaqConfiguration, type AdmissionAuthority, type ExecutionGrant } from "../src/platform/contracts";
import { dispatchTasksOnce } from "../src/platform/dispatcher";
import { PlatformStore } from "../src/platform/store";

describe("FAQ provider boundary with deterministic fixtures", () => {
  it("uses only the configured free model and sends no tools or paid fallback", async () => {
    const provider = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: "Our opening time is nine." } }],
      usage: { prompt_tokens: 51, completion_tokens: 9 },
    })));
    const result = await callFaqModel(defaultFaqConfiguration(), "When do you open?", "Open at nine.",
      { openRouterApiKey: "fixture-credential", fetch: provider as typeof fetch });
    expect(result).toEqual({ output: "Our opening time is nine.", inputTokens: 51, outputTokens: 9 });
    expect(provider).toHaveBeenCalledOnce();
    const [url, request] = provider.mock.calls[0]! as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const body = JSON.parse(String(request.body));
    expect(body.model).toBe("nvidia/nemotron-3-super-120b-a12b:free");
    expect(body.provider.allow_fallbacks).toBe(false);
    expect(body.tools).toBeUndefined();
    expect(body.max_tokens).toBe(1024);
    expect(request.signal).toBeInstanceOf(AbortSignal);
  });

  it("denies oversized total prompts and missing credentials before calling a provider", async () => {
    const provider = vi.fn();
    await expect(callFaqModel(defaultFaqConfiguration(), "x".repeat(16_384), "", {
      openRouterApiKey: "fixture", fetch: provider,
    })).rejects.toMatchObject({ code: "INPUT_LIMIT" });
    await expect(callFaqModel(defaultFaqConfiguration(), "Question", "", {
      openRouterApiKey: undefined, fetch: provider,
    })).rejects.toMatchObject({ code: "MODEL_CREDENTIAL_UNAVAILABLE" });
    expect(provider).not.toHaveBeenCalled();
  });

  it("rejects tool responses, missing metering, excess tokens, and oversized responses", async () => {
    for (const body of [
      { choices: [{ message: { content: "reply", tool_calls: [{}] } }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      { choices: [{ message: { content: "reply" } }] },
      { choices: [{ message: { content: "reply" } }], usage: { prompt_tokens: 1, completion_tokens: 1025 } },
      { choices: [{ message: { content: "x".repeat(128_001) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
    ]) {
      await expect(callFaqModel(defaultFaqConfiguration(), "Question", "", {
        openRouterApiKey: "fixture", fetch: async () => new Response(JSON.stringify(body)),
      })).rejects.toBeInstanceOf(Error);
    }
  });

  it("returns a bounded error without exposing provider response content or credentials", async () => {
    await expect(callFaqModel(defaultFaqConfiguration(), "Question", "", {
      openRouterApiKey: "secret-fixture", fetch: async () => new Response("private-provider-error", { status: 429 }),
    })).rejects.toMatchObject({ code: "MODEL_RATE_LIMITED", message: "Model rate limit reached" });
  });
});

const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("business workflow with real PostgreSQL and Restate and fixture provider", () => {
  let admin: Pool;
  let pool: Pool;
  let store: PlatformStore;
  let server: ReturnType<typeof createServer>;
  let workflow: ReturnType<typeof createBusinessWorkflow>;
  let ingressUrl: string;
  let adminUrl: string;
  let containerStarted = false;
  let providerMode: "reply" | "lost-response" | "held-reply" | "rejected" = "reply";
  let rejectionStatus = 429;
  let releaseProvider: (() => void) | undefined;
  const calls: string[] = [];
  const sessions = new Set<ServerHttp2Session>();
  const databaseName = `agents_business_test_${randomUUID().replaceAll("-", "")}`;
  const containerName = `agents-business-test-${randomUUID()}`;
  const docker = (...args: string[]) => execFileSync("docker", args, { encoding: "utf8", timeout: 60_000 }).trim();

  async function eventually<T>(check: () => Promise<T | false>): Promise<T> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const result = await check();
      if (result !== false) return result;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("Business workflow verification timed out");
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: url.href });
    await pool.query(await readFile(resolve(__dirname, "../schema/001_platform.sql"), "utf8"));
    store = new PlatformStore(pool);
    workflow = createBusinessWorkflow(pool, { openRouterApiKey: "fixture", fetch: async (_url, request) => {
      calls.push(String(request?.body));
      if (providerMode === "lost-response") throw new TypeError("Fixture connection interrupted");
      if (providerMode === "rejected") return new Response("private-provider-error", { status: rejectionStatus });
      if (providerMode === "held-reply") await new Promise<void>(resolve => { releaseProvider = resolve; });
      return new Response(JSON.stringify({ choices: [{ message: { content: "Open at nine." } }],
        usage: { prompt_tokens: 52, completion_tokens: 4 } }));
    } });
    server = createServer(createEndpointHandler({ services: [workflow] }));
    server.on("session", session => { sessions.add(session); session.once("close", () => sessions.delete(session)); });
    await new Promise<void>(resolve => server.listen(0, "0.0.0.0", resolve));
    const port = (server.address() as { port: number }).port;
    docker("run", "-d", "--name", containerName, "--cpus", "2", "--memory", "768m",
      "--add-host", "host.docker.internal:host-gateway", "-p", "127.0.0.1::8080", "-p", "127.0.0.1::9070",
      "docker.restate.dev/restatedev/restate:1.7.13");
    containerStarted = true;
    ingressUrl = `http://${docker("port", containerName, "8080/tcp")}`;
    adminUrl = `http://${docker("port", containerName, "9070/tcp")}`;
    await eventually(async () => { try { return (await fetch(`${adminUrl}/health`)).ok; } catch { return false; } });
    const response = await fetch(`${adminUrl}/deployments`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ uri: `http://host.docker.internal:${port}`, force: false }) });
    expect(response.ok, await response.text()).toBe(true);
  }, 60_000);

  afterAll(async () => {
    for (const session of sessions) session.destroy();
    if (server) await new Promise<void>(resolve => server.close(() => resolve()));
    if (containerStarted) docker("rm", "-f", containerName);
    await pool?.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); await admin.end(); }
  });

  async function fixture() {
    providerMode = "reply";
    calls.length = 0;
    const account = await store.ensureAccount({ issuer: "http://localhost:8080/realms/test", subject: randomUUID(),
      email: "fixture@example.com", displayName: "Owner" });
    const org = await store.createOrganization(account.id, "Business fixture");
    const source = await store.approveKnowledge({ accountId: account.id, organizationId: org.id,
      title: "Hours", content: "Open at nine.\n\n" + "Other information. ".repeat(3000), visibility: "public" });
    const config = { ...defaultFaqConfiguration(), knowledgeIds: [source.id] };
    const agent = await store.createAgent({ accountId: account.id, organizationId: org.id, name: "FAQ", configuration: config });
    const version = await store.createVersion({ accountId: account.id, organizationId: org.id, agentId: agent.id, expectedRevision: 1 });
    const authority: AdmissionAuthority = { product: "agents", organizationId: org.id, resourceId: agent.id,
      callerClientId: "agents-execution", principal: { kind: "human", issuer: account.issuer, subject: account.subject } };
    const grant: ExecutionGrant = { ...authority, id: randomUUID(), versionId: version.id, operations: ["model.reply", "knowledge.read"],
      knowledgeIds: [source.id], maxInputBytes: config.model.maxInputBytes, maxOutputTokens: config.model.maxOutputTokens,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), revokedAt: null };
    await store.createGrant({ accountId: account.id, grant });
    const request = { authority, grantId: grant.id, versionId: version.id, requestKey: randomUUID(), input: "What are the opening hours?" };
    const { task } = await store.admitTask(request);
    return { task, grant, request };
  }

  async function execute(taskId: string) {
    await dispatchTasksOnce(pool, { ingressUrl, adminUrl });
    return eventually(async () => {
      const row = (await pool.query("SELECT * FROM agents_platform.tasks WHERE id=$1", [taskId])).rows[0];
      return ["completed", "failed", "cancelled", "uncertain"].includes(row.state) ? row : false;
    });
  }

  it("executes the admitted pinned FAQ, bounds approved retrieval, and settles once across duplicate submissions", async () => {
    const f = await fixture();
    const task = await execute(f.task.id);
    expect(task.state).toBe("completed");
    expect(task.output).toBe("Open at nine.");
    expect(task.runtime_invocation_id).toMatch(/^inv_/);
    expect(calls).toHaveLength(1);
    const messages = JSON.parse(calls[0]!).messages as { content: string }[];
    expect(Buffer.byteLength(messages.map(message => message.content).join(""))).toBeLessThanOrEqual(16_384);
    const duplicate = await store.admitTask(f.request);
    expect(duplicate.task.id).toBe(f.task.id);
    await dispatchTasksOnce(pool, { ingressUrl, adminUrl });
    expect(calls).toHaveLength(1);
    expect((await pool.query("SELECT accounted_tokens FROM agents_platform.usage_ledger WHERE task_id=$1", [f.task.id])).rows).toEqual([{ accounted_tokens: 56 }]);
    expect((await pool.query("SELECT reserved_tokens,consumed_tokens FROM agents_platform.usage_accounts WHERE organization_id=$1", [f.task.organization_id])).rows)
      .toEqual([{ reserved_tokens: 0, consumed_tokens: 56 }]);
  }, 30_000);

  it("rechecks a revoked grant immediately before the provider effect", async () => {
    const f = await fixture();
    await pool.query("UPDATE agents_platform.execution_grants SET revoked_at=now() WHERE id=$1", [f.grant.id]);
    const task = await execute(f.task.id);
    expect(task).toMatchObject({ state: "failed", error_code: "GRANT_INACTIVE" });
    expect(calls).toHaveLength(0);
    expect((await pool.query("SELECT accounted_tokens FROM agents_platform.usage_ledger WHERE task_id=$1", [f.task.id])).rows[0].accounted_tokens).toBe(0);
  }, 30_000);

  it("serializes grant revocation with operation admission without holding permission locks across the provider call", async () => {
    const f = await fixture();
    providerMode = "held-reply";
    const blocker = await pool.connect();
    const revoker = await pool.connect();
    let revoke: Promise<unknown> | undefined;
    try {
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE agents_platform.knowledge_sources IN ACCESS EXCLUSIVE MODE");
      await dispatchTasksOnce(pool, { ingressUrl, adminUrl });
      await eventually(async () => {
        const waiting = await pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND state='active' AND wait_event_type='Lock' AND query LIKE 'SELECT k.id,k.title,k.content,k.visibility%'
          AND pid<>pg_backend_pid()`);
        return Boolean(waiting.rowCount);
      });
      const pid = (await revoker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      revoke = revoker.query("UPDATE agents_platform.execution_grants SET revoked_at=now() WHERE id=$1", [f.grant.id]);
      await eventually(async () => {
        const waiting = await pool.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1", [pid]);
        return waiting.rows[0]?.wait_event_type === "Lock";
      });
      expect(calls).toHaveLength(0);
      await blocker.query("COMMIT");
      await revoke;
      await eventually(async () => calls.length === 1);
      expect((await pool.query("SELECT revoked_at FROM agents_platform.execution_grants WHERE id=$1", [f.grant.id])).rows[0].revoked_at).not.toBeNull();
      // Revocation has completed while the previously admitted provider operation is still in flight.
      expect((await pool.query("SELECT state FROM agents_platform.model_operations WHERE task_id=$1", [f.task.id])).rows[0].state).toBe("started");
      releaseProvider!();
      expect((await execute(f.task.id)).state).toBe("completed");
    } finally {
      await blocker.query("ROLLBACK");
      await revoke;
      blocker.release(); revoker.release();
      releaseProvider?.();
    }
  }, 30_000);

  it("rechecks grant expiry after a delayed preparation before claiming the model effect", async () => {
    const f = await fixture();
    const blocker = await pool.connect();
    try {
      await pool.query("UPDATE agents_platform.execution_grants SET expires_at=now()+interval '5 seconds' WHERE id=$1", [f.grant.id]);
      await blocker.query("BEGIN");
      await blocker.query("LOCK TABLE agents_platform.knowledge_sources IN ACCESS EXCLUSIVE MODE");
      await dispatchTasksOnce(pool, { ingressUrl, adminUrl });
      await eventually(async () => Boolean((await pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND state='active' AND wait_event_type='Lock' AND query LIKE 'SELECT k.id,k.title,k.content,k.visibility%'
        AND pid<>pg_backend_pid()`)).rowCount));
      await eventually(async () => (await pool.query("SELECT expires_at<clock_timestamp() AS expired FROM agents_platform.execution_grants WHERE id=$1", [f.grant.id])).rows[0].expired);
      await blocker.query("COMMIT");
      const task = await execute(f.task.id);
      expect(task).toMatchObject({ state: "failed", error_code: "GRANT_INACTIVE" });
      expect(calls).toHaveLength(0);
      expect((await pool.query("SELECT 1 FROM agents_platform.model_operations WHERE task_id=$1", [f.task.id])).rowCount).toBe(0);
    } finally { await blocker.query("ROLLBACK"); blocker.release(); }
  }, 30_000);

  it("retries a lost outbox acceptance response using the same running workflow and settles once", async () => {
    const f = await fixture();
    providerMode = "held-reply";
    await dispatchTasksOnce(pool, { ingressUrl, adminUrl, fetch: async (url, init) => {
      const response = await fetch(url, init);
      if (String(url).includes("/restate/send/")) {
        expect(response.ok).toBe(true);
        await response.text();
        throw new TypeError("Fixture lost acceptance response");
      }
      return response;
    } });
    await eventually(async () => calls.length === 1);
    const first = (await pool.query("SELECT runtime_invocation_id FROM agents_platform.tasks WHERE id=$1", [f.task.id])).rows[0];
    expect(first.runtime_invocation_id).toMatch(/^inv_/);
    await pool.query("UPDATE agents_platform.task_outbox SET available_at=now() WHERE task_id=$1", [f.task.id]);
    await dispatchTasksOnce(pool, { ingressUrl, adminUrl });
    const second = (await pool.query("SELECT runtime_invocation_id FROM agents_platform.tasks WHERE id=$1", [f.task.id])).rows[0];
    expect(second.runtime_invocation_id).toBe(first.runtime_invocation_id);
    expect(calls).toHaveLength(1);
    releaseProvider!();
    expect((await execute(f.task.id)).state).toBe("completed");
    expect((await pool.query("SELECT count(*)::int AS count FROM agents_platform.usage_ledger WHERE task_id=$1", [f.task.id])).rows[0].count).toBe(1);
  }, 30_000);

  it("keeps cancellation requested until the model outcome is known", async () => {
    const f = await fixture();
    providerMode = "held-reply";
    await dispatchTasksOnce(pool, { ingressUrl, adminUrl });
    await eventually(async () => calls.length === 1);
    await pool.query("UPDATE agents_platform.tasks SET state='cancel_requested' WHERE id=$1", [f.task.id]);
    await dispatchTasksOnce(pool, { ingressUrl, adminUrl });
    expect((await pool.query("SELECT state FROM agents_platform.tasks WHERE id=$1", [f.task.id])).rows[0].state).toBe("cancel_requested");
    releaseProvider!();
    const task = await execute(f.task.id);
    expect(task.state).toBe("uncertain");
    expect(calls).toHaveLength(1);
    const reservation = (await pool.query("SELECT tokens FROM agents_platform.usage_reservations WHERE task_id=$1", [f.task.id])).rows[0];
    expect((await pool.query("SELECT accounted_tokens FROM agents_platform.usage_ledger WHERE task_id=$1", [f.task.id])).rows[0].accounted_tokens).toBe(reservation.tokens);
    await eventually(async () => (await pool.query("SELECT state FROM agents_platform.model_operations WHERE task_id=$1", [f.task.id])).rows[0].state === "completed");
  }, 30_000);

  it("never repeats an interrupted provider request and conservatively settles its reservation", async () => {
    const f = await fixture();
    providerMode = "lost-response";
    const task = await execute(f.task.id);
    expect(task).toMatchObject({ state: "uncertain", error_code: "MODEL_OUTCOME_UNCERTAIN" });
    expect(calls).toHaveLength(1);
    const reservation = (await pool.query("SELECT tokens,settled_at FROM agents_platform.usage_reservations WHERE task_id=$1", [f.task.id])).rows[0];
    const ledger = (await pool.query("SELECT accounted_tokens FROM agents_platform.usage_ledger WHERE task_id=$1", [f.task.id])).rows[0];
    expect(ledger.accounted_tokens).toBe(reservation.tokens);
    expect(reservation.settled_at).not.toBeNull();
    await dispatchTasksOnce(pool, { ingressUrl, adminUrl });
    expect(calls).toHaveLength(1);
  }, 30_000);

  it.each([400, 401, 402, 403, 404, 422, 429])("settles definitive provider HTTP %i rejection with zero usage and no retry", async status => {
    const f = await fixture();
    providerMode = "rejected";
    rejectionStatus = status;
    const task = await execute(f.task.id);
    expect(task).toMatchObject({ state: "failed", error_code: status === 429 ? "MODEL_RATE_LIMITED" : "MODEL_REQUEST_REJECTED" });
    expect(calls).toHaveLength(1);
    expect((await pool.query("SELECT state,output,error_code,input_tokens,output_tokens FROM agents_platform.model_operations WHERE task_id=$1", [f.task.id])).rows[0])
      .toEqual({ state: "failed", output: null, error_code: status === 429 ? "MODEL_RATE_LIMITED" : "MODEL_REQUEST_REJECTED", input_tokens: 0, output_tokens: 0 });
    expect((await pool.query("SELECT accounted_tokens FROM agents_platform.usage_ledger WHERE task_id=$1", [f.task.id])).rows[0].accounted_tokens).toBe(0);
    expect((await pool.query("SELECT reserved_tokens,consumed_tokens FROM agents_platform.usage_accounts WHERE organization_id=$1", [f.task.organization_id])).rows[0])
      .toEqual({ reserved_tokens: 0, consumed_tokens: 0 });
    await dispatchTasksOnce(pool, { ingressUrl, adminUrl });
    expect(calls).toHaveLength(1);
  }, 30_000);

  it.each([408, 500, 503])("keeps provider HTTP %i outcomes uncertain with conservative usage", async status => {
    const f = await fixture();
    providerMode = "rejected";
    rejectionStatus = status;
    expect(await execute(f.task.id)).toMatchObject({ state: "uncertain", error_code: "MODEL_OUTCOME_UNCERTAIN" });
    const reservation = (await pool.query("SELECT tokens FROM agents_platform.usage_reservations WHERE task_id=$1", [f.task.id])).rows[0];
    expect((await pool.query("SELECT accounted_tokens FROM agents_platform.usage_ledger WHERE task_id=$1", [f.task.id])).rows[0].accounted_tokens).toBe(reservation.tokens);
    expect(calls).toHaveLength(1);
  }, 30_000);

  it("recovers a recorded rejection without retrying the provider or consuming its reservation", async () => {
    const f = await fixture();
    await pool.query(`INSERT INTO agents_platform.model_operations(task_id,operation_id,state,error_code,input_tokens,output_tokens)
      VALUES($1,$2,'failed','MODEL_RATE_LIMITED',0,0)`, [f.task.id, `model:${f.task.id}`]);
    expect(await execute(f.task.id)).toMatchObject({ state: "failed", error_code: "MODEL_RATE_LIMITED" });
    expect(calls).toHaveLength(0);
    expect((await pool.query("SELECT reserved_tokens,consumed_tokens FROM agents_platform.usage_accounts WHERE organization_id=$1", [f.task.organization_id])).rows[0])
      .toEqual({ reserved_tokens: 0, consumed_tokens: 0 });
  }, 30_000);

  it("recovers an existing started model operation as uncertain without calling the provider", async () => {
    const f = await fixture();
    await pool.query("INSERT INTO agents_platform.model_operations(task_id,operation_id,state) VALUES($1,$2,'started')", [f.task.id, `model:${f.task.id}`]);
    expect((await execute(f.task.id)).state).toBe("uncertain");
    expect(calls).toHaveLength(0);
  }, 30_000);

  it("replays after a worker connection restart without repeating an unconfirmed provider operation", async () => {
    const f = await fixture();
    providerMode = "held-reply";
    await dispatchTasksOnce(pool, { ingressUrl, adminUrl });
    await eventually(async () => calls.length === 1);
    const original = (await pool.query("SELECT runtime_invocation_id FROM agents_platform.tasks WHERE id=$1", [f.task.id])).rows[0];
    const port = (server.address() as { port: number }).port;
    for (const session of sessions) session.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    server = createServer(createEndpointHandler({ services: [workflow] }));
    server.on("session", session => { sessions.add(session); session.once("close", () => sessions.delete(session)); });
    await new Promise<void>(resolve => server.listen(port, "0.0.0.0", resolve));
    const recovered = await execute(f.task.id);
    expect(recovered).toMatchObject({ state: "uncertain", runtime_invocation_id: original.runtime_invocation_id });
    expect(calls).toHaveLength(1);
    releaseProvider!();
    await eventually(async () => (await pool.query("SELECT state FROM agents_platform.model_operations WHERE task_id=$1", [f.task.id])).rows[0].state === "completed");
    expect((await pool.query("SELECT count(*)::int AS count FROM agents_platform.usage_ledger WHERE task_id=$1", [f.task.id])).rows[0].count).toBe(1);
  }, 30_000);

  it("cancels an undispatched accepted task without starting a model or runtime invocation", async () => {
    const f = await fixture();
    await pool.query("UPDATE agents_platform.tasks SET state='cancel_requested' WHERE id=$1", [f.task.id]);
    const task = await execute(f.task.id);
    expect(task).toMatchObject({ state: "cancelled", runtime_invocation_id: null });
    expect(calls).toHaveLength(0);
  }, 30_000);

  it("stops cancellation retries after the bounded window and reports uncertainty when the runtime is unreachable", async () => {
    const f = await fixture();
    await pool.query(`UPDATE agents_platform.tasks SET state='cancel_requested',runtime_invocation_id='inv_fixture',
      created_at=now()-interval '25 hours' WHERE id=$1`, [f.task.id]);
    await pool.query("UPDATE agents_platform.task_outbox SET dispatched_at=now() WHERE task_id=$1", [f.task.id]);
    await dispatchTasksOnce(pool, { ingressUrl, adminUrl, fetch: async () => { throw new TypeError("Fixture runtime unavailable"); } });
    expect((await pool.query("SELECT state,error_code FROM agents_platform.tasks WHERE id=$1", [f.task.id])).rows[0])
      .toEqual({ state: "uncertain", error_code: "CANCELLATION_UNCONFIRMED" });
    expect(calls).toHaveLength(0);
  }, 30_000);
});

describe("bounded retrieval from already authorized knowledge", () => {
  it("ranks matching source paragraphs and includes source identity", () => {
    const result = retrieveFaqKnowledge("What is the refund policy?", [
      { id: "first", title: "Hours", content: "We open at nine." },
      { id: "second", title: "Payments", content: "Refund policy allows seven days." },
    ], 90);
    expect(result).toMatch(/^\[source:second\] Payments\nRefund policy/);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(90);
  });

  it("truncates multibyte content without corrupting Unicode or exceeding the byte limit", () => {
    const result = retrieveFaqKnowledge("flowers", [{ id: "flowers", title: "Flowers", content: "🌸é".repeat(1000) }], 101);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(101);
    expect(result).not.toContain("�");
    expect(result).toContain("🌸");
    expect(retrieveFaqKnowledge("flowers", [{ id: "flowers", title: "Flowers", content: "text" }], 1)).toBe("");
  });
});
