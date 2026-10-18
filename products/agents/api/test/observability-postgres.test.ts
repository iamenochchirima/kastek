import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultBusinessConfiguration, executionGrantSchema } from "../src/contracts/contracts";
import { observationSchema } from "../src/contracts/observations";
import { PlatformStore } from "../src/product/agents/store";
import { setupPlatformSchema } from "../src/composition/setup";
import { beginOperation, finishOperation } from "../src/execution/lifecycle/execution";
import { collectNativeMetrics, createNativeMetrics } from "../src/observability/metrics";
import { createObservationTelemetry, publishObservationBatch } from "../src/observability/telemetry";

const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("native observation persistence and export", () => {
  let admin: Pool, pool: Pool, store: PlatformStore;
  const name = `agents_observations_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE DATABASE "${name}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${name}`; pool = new Pool({ connectionString: url.href });
    await setupPlatformSchema(pool); store = new PlatformStore(pool);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); await admin.end(); } });
  async function fixture() {
    const account = await store.ensureAccount({ issuer: "https://identity.example.test", subject: randomUUID(), email: "test@example.test", displayName: "Test" });
    const org = await store.createOrganization(account.id, "Observation fixture"), config = defaultBusinessConfiguration();
    const agent = await store.createAgent({ accountId: account.id, organizationId: org.id, name: "Fixture", configuration: config });
    const version = await store.createVersion({ accountId: account.id, organizationId: org.id, agentId: agent.id, expectedRevision: 1 });
    const authority = { product: "agents" as const, organizationId: org.id, resourceId: agent.id, callerClientId: "agents-execution",
      principal: { kind: "human" as const, issuer: account.issuer, subject: account.subject } };
    const grant = executionGrantSchema.parse({ ...authority, id: randomUUID(), versionId: version.id, operations: ["model.reply"],
      maxInputBytes: config.model.maxInputBytes, maxOutputTokens: config.model.maxOutputTokens, expiresAt: new Date(Date.now() + 600000).toISOString(), revokedAt: null });
    await store.createGrant({ accountId: account.id, grant });
    const { task } = await store.admitTask({ authority, versionId: version.id, grantId: grant.id, requestKey: randomUUID(), input: "PRIVATE_CUSTOMER_TEXT" });
    const operation = { id: `model:${task.id}:0`, kind: "model" as const, name: "model.generate", request: { messages: [{ role: "user", content: "PRIVATE_CUSTOMER_TEXT" }] }, reservedTokens: 100, reservedMs: 30000 };
    await beginOperation(pool, task.id, operation);
    await finishOperation(pool, task.id, operation.id, "completed", { message: { role: "assistant", content: "PRIVATE_MODEL_TEXT" }, usage: { inputTokens: 5, outputTokens: 2 } }, null, 7);
    return { task, operation };
  }
  it("deduplicates logical replay and commits metadata and export intents with native receipts", async () => {
    const f = await fixture();
    expect((await beginOperation(pool, f.task.id, f.operation)).replayed).toBe(true);
    const events = (await pool.query("SELECT observation FROM agents_platform.task_events WHERE task_id=$1 ORDER BY sequence", [f.task.id])).rows.map(row => observationSchema.parse(row.observation));
    expect(events).toHaveLength(3);
    expect(events.map(event => event.category)).toEqual(["task", "model", "model"]);
    expect(events[2]!.metadata).toMatchObject({ inputTokens: 5, outputTokens: 2, totalTokens: 7, outcome: "completed" });
    expect(JSON.stringify(events)).not.toContain("PRIVATE_");
    expect((await pool.query("SELECT count(*)::int n FROM agents_platform.observation_exports WHERE observation_id=ANY($1::text[])", [events.map(event => event.id)])).rows[0].n).toBe(3);
  });
  it("keeps collector failures outside authority and usage, then exports pending events once acknowledged", async () => {
    const before = (await pool.query("SELECT sum(tokens_used)::int n FROM agents_platform.tasks")).rows[0].n;
    expect(await publishObservationBatch(pool, { async export() { throw Error("collector unavailable"); }, async shutdown() {} })).toBe(0);
    expect((await pool.query("SELECT sum(tokens_used)::int n FROM agents_platform.tasks")).rows[0].n).toBe(before);
    expect((await pool.query("SELECT count(*)::int n FROM agents_platform.observation_exports WHERE exported_at IS NOT NULL")).rows[0].n).toBe(0);
    await pool.query("UPDATE agents_platform.observation_exports SET available_at=now()");
    const seen: string[] = [];
    const transport = { async export(events: { id: string }[]) { seen.push(...events.map(event => event.id)); }, async shutdown() {} };
    expect(await publishObservationBatch(pool, transport)).toBe(3);
    expect(await publishObservationBatch(pool, transport)).toBe(0);
    expect(new Set(seen).size).toBe(3);
  });
  it("projects bounded native metrics without content or export retry accounting",async()=>{
    const points=await collectNativeMetrics(pool,"worker");
    expect(points.find(point=>point.name==="agents.usage.tokens")?.value).toBe(7);
    expect(points.find(point=>point.name==="agents.tasks")?.value).toBeGreaterThan(0);
    expect(JSON.stringify(points)).not.toContain("PRIVATE_");
    for(const point of points)expect(Object.keys(point.attributes).every(key=>["product","program","state","workload","kind","action","role"].includes(key))).toBe(true);
    expect((await collectNativeMetrics(pool,"worker")).filter(point=>point.name==="agents.usage.tokens")).toEqual(points.filter(point=>point.name==="agents.usage.tokens"));
  });
  it.skipIf(!process.env.AGENTS_TEST_OTEL_METRICS_ENDPOINT)("exports real SDK metric points through the local Collector",async()=>{
    const telemetry=createNativeMetrics(pool,"acceptance",{OTEL_EXPORTER_OTLP_METRICS_ENDPOINT:process.env.AGENTS_TEST_OTEL_METRICS_ENDPOINT})!;
    try{await telemetry.forceFlush();}finally{await telemetry.shutdown();}
  });
  it.skipIf(!process.env.AGENTS_TEST_OTEL_ENDPOINT)("sends actual SDK spans through the local Collector OTLP receiver", async () => {
    await fixture();
    const transport = createObservationTelemetry("agents-observation-acceptance", { NODE_ENV: "test", OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: process.env.AGENTS_TEST_OTEL_ENDPOINT })!;
    try { expect(await publishObservationBatch(pool, transport)).toBe(3); } finally { await transport.shutdown(); }
  });
});
