import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { contextGrantCeiling } from "../src/execution/models/settings";
import { defaultBusinessConfiguration, executionGrantSchema, type AdmissionAuthority } from "../src/contracts/contracts";
import { collectNativeMetrics } from "../src/observability/metrics";
import { forwardAgentsUsage } from "../src/product/billing/usage";
import { PlatformStore } from "../src/product/agents/store";
import { connectFixtureModel } from "./model-fixture";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const url = process.env.AGENTS_TEST_DATABASE_URL;
(url ? describe : describe.skip)("usage telemetry and billing forwarding", () => {
  let admin: Pool, pool: Pool, store: PlatformStore;
  const database = `agents_metrics_billing_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    admin = new Pool({ connectionString: url }); await admin.query(`CREATE DATABASE "${database}"`);
    const target = new URL(url!); target.pathname = `/${database}`;
    pool = new Pool({ connectionString: target.href }); await setupPlatformSchema(pool); store = new PlatformStore(pool);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); } });

  async function fixture() {
    const account = await store.ensureAccount({ issuer: "http://localhost/metrics-billing", subject: randomUUID(), email: "metrics@example.test", displayName: "Metrics" });
    const organization = await store.createOrganization(account.id, "Metrics fixture");
    await connectFixtureModel(pool, account.id, organization.id);
    const configuration = defaultBusinessConfiguration();
    const agent = await store.createAgent({ accountId: account.id, organizationId: organization.id, name: "Metrics agent", configuration });
    const version = await store.createVersion({ accountId: account.id, organizationId: organization.id, agentId: agent.id, expectedRevision: 1 });
    const authority: AdmissionAuthority = { product: "agents", organizationId: organization.id, resourceId: agent.id,
      callerClientId: "agents-execution", principal: { kind: "human", issuer: account.issuer, subject: account.subject } };
    const grant = executionGrantSchema.parse({ ...authority, id: randomUUID(), versionId: version.id,
      operations: ["model.reply", "knowledge.read"], maxInputBytes: configuration.model.maxInputBytes,
      maxOutputTokens: configuration.model.maxOutputTokens, maxContextTokens: contextGrantCeiling(configuration),
      expiresAt: new Date(Date.now() + 120_000).toISOString(), revokedAt: null });
    await store.createGrant({ accountId: account.id, grant });
    const { task } = await store.admitTask({ authority, grantId: grant.id, versionId: version.id, requestKey: randomUUID(), input: "Metrics fixture" });
    return { task, organization };
  }

  it("attributes token usage to the tenant in the metrics snapshot", async () => {
    const { task, organization } = await fixture();
    await pool.query(`INSERT INTO agents_platform.operations(id,task_id,kind,name,request_digest,request,state,reserved_tokens,accounted_tokens,reserved_ms,started_at,completed_at,attempt_id)
      VALUES($1,$2,'model','model.reply',$3,'{}','completed',0,123,1,now(),now(),$4)`,
      [`model:${randomUUID()}`, task.id, "0".repeat(64), randomUUID()]);
    const points = await collectNativeMetrics(pool, "worker");
    const usage = points.filter(point => point.name === "agents.usage.tokens");
    expect(usage.some(point => point.value === 123 && point.attributes.tenant === organization.id && point.attributes.kind === "model")).toBe(true);
  });

  it("forwards settled usage once and records the forwarding receipt", async () => {
    const { task } = await fixture();
    await pool.query(`INSERT INTO agents_platform.usage_ledger(task_id,operation_id,accounted_tokens,outcome,managed_cost_micros)
      VALUES($1,$2,250,'completed',1500)`, [task.id, `usage:${randomUUID()}`]);
    const client = { usage: vi.fn(async () => undefined) };
    expect(await forwardAgentsUsage(pool, client as never)).toBe(1);
    expect(client.usage).toHaveBeenCalledTimes(2);
    expect(client.usage.mock.calls.map(call => (call[0] as { idempotencyKey: string }).idempotencyKey)).toEqual([
      `agents:task:${task.id}:cost`, `agents:task:${task.id}`]);
    expect(await forwardAgentsUsage(pool, client as never)).toBe(0);
    expect(client.usage).toHaveBeenCalledTimes(2);
    const forwarded = (await pool.query("SELECT skipped_reason FROM agents_platform.billing_usage_forwarded WHERE task_id=$1", [task.id])).rows;
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].skipped_reason).toBeNull();
  });

  it("records an unlinked tenant once instead of retrying forever", async () => {
    const { task } = await fixture();
    await pool.query(`INSERT INTO agents_platform.usage_ledger(task_id,operation_id,accounted_tokens,outcome,managed_cost_micros)
      VALUES($1,$2,10,'completed',0)`, [task.id, `usage:${randomUUID()}`]);
    const client = { usage: vi.fn(async () => { throw new Error("Tenant is not linked to billing"); }) };
    expect(await forwardAgentsUsage(pool, client as never)).toBe(1);
    expect(await forwardAgentsUsage(pool, client as never)).toBe(0);
    expect(client.usage).toHaveBeenCalledTimes(1);
    expect((await pool.query("SELECT skipped_reason FROM agents_platform.billing_usage_forwarded WHERE task_id=$1", [task.id])).rows[0].skipped_reason).toBe("account_not_linked");
  });
});
