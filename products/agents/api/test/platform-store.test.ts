import {publishFixtureSource} from "./knowledge-fixture";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultFaqConfiguration, type AdmissionAuthority, type ExecutionGrant } from "../src/contracts/contracts";
import { PlatformStore } from "../src/product/agents/store";
import { setupPlatformSchema } from "../src/composition/setup";

const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
suite("fresh platform PostgreSQL store", () => {
  let admin: Pool;
  let pool: Pool;
  let store: PlatformStore;
  const databaseName = `agents_store_test_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: url.href, max: 10 });
    await setupPlatformSchema(pool);
    store = new PlatformStore(pool);
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`); await admin.end(); }
  });

  async function fixture(kind: "business" | "workspace" = "business") {
    const account = await store.ensureAccount({ issuer: "http://localhost:8080/realms/test", subject: randomUUID(), email: "same@example.com", displayName: "Owner" });
    const org = await store.createOrganization(account.id, "Test organization");
    const config = defaultFaqConfiguration(); config.executionKind = kind;
    const agent = await store.createAgent({ accountId: account.id, organizationId: org.id, name: "FAQ", configuration: config });
    const version = await store.createVersion({ accountId: account.id, organizationId: org.id, agentId: agent.id, expectedRevision: 1 });
    const authority: AdmissionAuthority = { product: "agents", organizationId: org.id, resourceId: agent.id, callerClientId: "agents-execution",
      principal: { kind: "human", issuer: account.issuer, subject: account.subject } };
    const grant: ExecutionGrant = { ...authority, id: randomUUID(), versionId: version.id, operations: ["model.reply", "knowledge.read"],
      maxInputBytes: config.model.maxInputBytes, maxOutputTokens: config.model.maxOutputTokens,
      expiresAt: new Date(Date.now() + 20 * 60_000).toISOString(), revokedAt: null };
    await store.createGrant({ accountId: account.id, grant });
    return { account, org, config, agent, version, authority, grant,
      request: { authority, grantId: grant.id, versionId: version.id, requestKey: randomUUID(), input: "When are you open?" } };
  }

  it("uses issuer and subject identity, and opaque revocable sessions with idle expiry", async () => {
    const first = await fixture(); const second = await fixture();
    expect(first.account.id).not.toBe(second.account.id);
    const same = await store.ensureAccount({ issuer: first.account.issuer, subject: first.account.subject, email: "changed@example.com", displayName: "Updated" });
    expect(same.id).toBe(first.account.id);
    const session = await store.createSession({ accountId: same.id, providerSessionId: "provider-session", expiresAt: new Date(Date.now() + 60_000) });
    expect((await store.getSession(session.token))?.account.id).toBe(same.id);
    const saved = (await pool.query("SELECT token_hash FROM agents_platform.sessions WHERE account_id=$1", [same.id])).rows[0];
    expect(saved.token_hash).not.toBe(session.token);
    await pool.query("UPDATE agents_platform.sessions SET last_seen_at=now()-interval '8 days' WHERE account_id=$1", [same.id]);
    expect(await store.getSession(session.token)).toBeNull();
    const active = await store.createSession({ accountId: same.id, providerSessionId: "provider-session", expiresAt: new Date(Date.now() + 60_000) });
    await store.revokeProviderSession(same.issuer, "provider-session");
    expect(await store.getSession(active.token)).toBeNull();
  });

  it("pins immutable versions while draft updates reject stale revisions and foreign knowledge", async () => {
    const f = await fixture(); const other = await fixture();
    const duplicate = await store.createVersion({ accountId: f.account.id, organizationId: f.org.id, agentId: f.agent.id, expectedRevision: 1 });
    expect(duplicate.id).toBe(f.version.id);
    expect(await store.listVersions(f.account.id, f.org.id, f.agent.id)).toHaveLength(1);
    const publicKnowledge = await publishFixtureSource(pool,{ accountId: f.account.id, organizationId: f.org.id, title: "Hours", content: "Open Monday.", visibility: "public" });
    const config = { ...f.config, instructions: "Updated instructions", sourceRevisionIds: [publicKnowledge.id] };
    const updated = await store.updateDraft({ accountId: f.account.id, organizationId: f.org.id, agentId: f.agent.id, configuration: config, expectedRevision: 1 });
    expect(updated.draft_revision).toBe(2);
    expect((await store.getVersion(f.account.id, f.org.id, f.version.id)).configuration.sourceRevisionIds).toEqual([]);
    await expect(store.updateDraft({ accountId: f.account.id, organizationId: f.org.id, agentId: f.agent.id, configuration: config, expectedRevision: 1 })).rejects.toMatchObject({ code: "DRAFT_CONFLICT" });
    await expect(pool.query("UPDATE agents_platform.agent_versions SET configuration=$2 WHERE id=$1", [f.version.id, config])).rejects.toMatchObject({ code: "23514" });
    await expect(pool.query("UPDATE agents_platform.source_revisions SET text_digest=repeat('a',64) WHERE id=$1", [publicKnowledge.id])).rejects.toMatchObject({ code: "23514" });
    const foreign = await publishFixtureSource(pool,{ accountId: other.account.id, organizationId: other.org.id, title: "Secret", content: "Private.", visibility: "private" });
    await store.updateDraft({ accountId: f.account.id, organizationId: f.org.id, agentId: f.agent.id, configuration: { ...config, sourceRevisionIds: [foreign.id] }, expectedRevision: 2 });
    await expect(store.createVersion({ accountId: f.account.id, organizationId: f.org.id, agentId: f.agent.id, expectedRevision: 3 })).rejects.toMatchObject({ code: "SOURCE_REVISION_UNAVAILABLE" });
    await expect(store.listAgents(other.account.id, f.org.id)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });

  it("publishes only matching business versions and public knowledge; drafts cannot move live", async () => {
    const f = await fixture();
    const knowledge = await publishFixtureSource(pool,{ accountId: f.account.id, organizationId: f.org.id, title: "Internal", content: "Private.", visibility: "private" });
    await store.updateDraft({ accountId: f.account.id, organizationId: f.org.id, agentId: f.agent.id, configuration: { ...f.config, sourceRevisionIds: [knowledge.id] }, expectedRevision: 1 });
    const privateVersion = await store.createVersion({ accountId: f.account.id, organizationId: f.org.id, agentId: f.agent.id, expectedRevision: 2 });
    await expect(store.publishWebsite({ accountId: f.account.id, organizationId: f.org.id, agentId: f.agent.id, versionId: privateVersion.id, allowedOrigins: ["https://example.com"] })).rejects.toMatchObject({ code: "PRIVATE_KNOWLEDGE" });
    const deployed = await store.publishWebsite({ accountId: f.account.id, organizationId: f.org.id, agentId: f.agent.id, versionId: f.version.id, allowedOrigins: ["https://example.com"] });
    expect((await store.getWebsiteDeployment(deployed.id)).version_id).toBe(f.version.id);
    await expect(store.publishWebsite({ accountId: f.account.id, organizationId: f.org.id, agentId: randomUUID(), versionId: f.version.id, allowedOrigins: ["https://example.com"] })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(store.createWebsiteGrant({ deploymentId: deployed.id, origin: "https://other.example", sessionId: randomUUID() })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });

  it("deduplicates simultaneous admission with one task, reservation, event and outbox row", async () => {
    const f = await fixture();
    const [a, b] = await Promise.all([store.admitTask(f.request), store.admitTask(f.request)]);
    expect(a.task.id).toBe(b.task.id);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    for (const table of ["tasks", "usage_reservations"]) {
      expect(Number((await pool.query(`SELECT count(*) FROM agents_platform.${table} WHERE organization_id=$1`, [f.org.id])).rows[0].count)).toBe(1);
    }
    for (const table of ["task_outbox", "task_events"]) {
      expect(Number((await pool.query(`SELECT count(*) FROM agents_platform.${table} WHERE task_id=$1`, [a.task.id])).rows[0].count)).toBe(1);
    }
    const tokens = (await pool.query("SELECT reserved_tokens FROM agents_platform.usage_accounts WHERE organization_id=$1", [f.org.id])).rows[0].reserved_tokens;
    expect(tokens).toBe(32000);
    await expect(store.admitTask({ ...f.request, input: "Different question" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("serializes three concurrent admissions to the two-task limit without partial rows", async () => {
    const f = await fixture();
    const results = await Promise.allSettled([1, 2, 3].map((n) => store.admitTask({ ...f.request, requestKey: `request-${n}` })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((r) => r.status === "rejected")).toMatchObject([{ reason: { code: "CONCURRENCY_LIMIT" } }]);
    expect(Number((await pool.query("SELECT count(*) FROM agents_platform.tasks WHERE organization_id=$1", [f.org.id])).rows[0].count)).toBe(2);
    expect(Number((await pool.query("SELECT count(*) FROM agents_platform.usage_reservations WHERE organization_id=$1", [f.org.id])).rows[0].count)).toBe(2);
  });

  it("rolls back quota reservations and conversations on daily limit or invalid conversation", async () => {
    const f = await fixture();
    await expect(store.admitTask({ ...f.request, conversationId: randomUUID() })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    expect(Number((await pool.query("SELECT count(*) FROM agents_platform.usage_accounts WHERE organization_id=$1", [f.org.id])).rows[0].count)).toBe(0);
    await pool.query("INSERT INTO agents_platform.usage_accounts(organization_id,day,token_allowance) VALUES($1,(now() AT TIME ZONE 'UTC')::date,1)", [f.org.id]);
    await expect(store.admitTask(f.request)).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    expect(Number((await pool.query("SELECT count(*) FROM agents_platform.tasks WHERE organization_id=$1", [f.org.id])).rows[0].count)).toBe(0);
  });

  it("checks persisted grant expiry, revocation, caller, principal and current membership", async () => {
    const f = await fixture();
    await expect(store.admitTask({ ...f.request, authority: { ...f.authority, resourceId: randomUUID() } })).rejects.toMatchObject({ code: "GRANT_SCOPE_DENIED" });
    const task = await store.admitTask(f.request);
    await store.revokeGrant(f.account.id, f.org.id, f.grant.id);
    await expect(store.admitTask(f.request)).rejects.toMatchObject({ code: "GRANT_INACTIVE" });
    await expect(store.getTask({ ...f.authority, principal: { kind: "human", issuer: f.account.issuer, subject: randomUUID() } }, task.task.id)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await pool.query("UPDATE agents_platform.memberships SET revoked_at=now() WHERE organization_id=$1 AND account_id=$2", [f.org.id, f.account.id]);
    await expect(store.getTask(f.authority, task.task.id)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    const expired = await fixture();
    await pool.query("UPDATE agents_platform.execution_grants SET expires_at=now()-interval '1 second',created_at=now()-interval '1 hour' WHERE id=$1", [expired.grant.id]);
    await expect(store.admitTask(expired.request)).rejects.toMatchObject({ code: "GRANT_INACTIVE" });
  });

  it("rejects workspace execution before creating a task or outbox", async () => {
    const f = await fixture("workspace");
    await expect(store.admitTask(f.request)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(Number((await pool.query("SELECT count(*) FROM agents_platform.tasks WHERE organization_id=$1", [f.org.id])).rows[0].count)).toBe(0);
  });

  it("keeps website conversations bound to the deployment and visitor principal", async () => {
    const f = await fixture();
    const deployment = await store.publishWebsite({ accountId: f.account.id, organizationId: f.org.id, agentId: f.agent.id, versionId: f.version.id, allowedOrigins: ["https://example.com"] });
    const grant = await store.createWebsiteGrant({ deploymentId: deployment.id, origin: "https://example.com", sessionId: randomUUID() });
    const authority: AdmissionAuthority = { product: grant.product, organizationId: grant.organizationId, resourceId: grant.resourceId, callerClientId: grant.callerClientId, principal: grant.principal };
    const task = await store.admitTask({ authority, versionId: grant.versionId, grantId: grant.id, requestKey: "visitor-1", input: "Hello" });
    expect((await store.getConversation(authority, task.task.conversation_id))[0]?.id).toBe(task.task.id);
    expect((await store.listTaskEvents(authority, task.task.id))[0]?.kind).toBe("accepted");
    expect(await store.listTaskEvents(authority, task.task.id, "9223372036854775807")).toEqual([]);
    const anotherGrant = await store.createWebsiteGrant({ deploymentId: deployment.id, origin: "https://example.com", sessionId: randomUUID() });
    const anotherAuthority = { ...authority, principal: anotherGrant.principal };
    await expect(store.getConversation(anotherAuthority, task.task.conversation_id)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(store.admitTask({ authority: anotherAuthority, versionId: grant.versionId, grantId: anotherGrant.id, requestKey: "visitor-2", input: "Hello", conversationId: task.task.conversation_id })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await pool.query("UPDATE agents_platform.website_deployments SET revoked_at=now() WHERE id=$1", [deployment.id]);
    await expect(store.getTask(authority, task.task.id)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });
});
