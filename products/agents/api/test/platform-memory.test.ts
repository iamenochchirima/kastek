import {dropClosedTestDatabase} from "./support/database-cleanup";
import { connectFixtureModel } from "./model-fixture";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryStore } from "../src/execution/memory/memory";
import { registerMemoryRoutes } from "../src/product/agents/memory-routes";
import { defaultBusinessConfiguration } from "../src/contracts/contracts";
import { PlatformStore } from "../src/product/agents/store";

const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
suite("scoped PostgreSQL memory and immutable skills", () => {
  let admin: Pool, pool: Pool, platform: PlatformStore, memory: MemoryStore;
  const database = `agents_memory_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${database}`; pool = new Pool({ connectionString: url.href });
    for (const file of (await readdir(resolve(__dirname, "../schema"))).filter(file => file.endsWith(".sql")).sort()) await pool.query(await readFile(resolve(__dirname, "../schema", file), "utf8"));
    platform = new PlatformStore(pool); memory = new MemoryStore(pool);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await dropClosedTestDatabase(admin,database); await admin.end(); } });
  async function fixture() {
    const account = await platform.ensureAccount({ issuer: "http://localhost:8080/realms/memory", subject: randomUUID(), email: "memory@example.test", displayName: "Owner" });
    const organization = await platform.createOrganization(account.id, "Memory test");
    await connectFixtureModel(pool, account.id, organization.id);
    const agent = await platform.createAgent({ accountId: account.id, organizationId: organization.id, name: "Assistant", configuration: defaultBusinessConfiguration() });
    return { account, organization, agent, management: { accountId: account.id, organizationId: organization.id, agentId: agent.id },
      scope: { organizationId: organization.id, agentId: agent.id, principal: { kind: "human" as const, issuer: account.issuer, subject: account.subject } } };
  }
  it("requires explicit management acceptance; follows scoped full-text retrieval across conversations", async () => {
    const f = await fixture();
    const initial = await memory.read(f.scope); expect(initial.generation).toBe(0); expect(initial.memories).toEqual([]);
    const candidate = await memory.propose(f.scope, { operationId: randomUUID(), kind: "semantic", content: "I prefer short research reports." });
    expect(candidate.status).toBe("candidate"); expect((await memory.read(f.scope)).memories).toEqual([]);
    const accepted = await memory.mutate(f.management, candidate.id, { action: "accept", operationId: randomUUID(), expectedRevision: 1 });
    expect(accepted.revision).toBe(2);
    const found = await memory.read({ ...f.scope }, "research"); expect(found.memories.map(row => row.id)).toEqual([candidate.id]); expect(found.generation).toBe(1);
    expect((await memory.read(f.scope, "unmatched")).memories).toEqual([]);
    const other = await fixture(); expect((await memory.read(other.scope)).memories).toEqual([]);
    await expect(memory.read({ ...f.scope, principal: other.scope.principal })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(memory.read({ ...f.scope, principal: { kind: "visitor", deploymentId: randomUUID(), sessionId: randomUUID() } })).rejects.toMatchObject({ code: "MEMORY_SCOPE_DENIED" });
  });
  it("deduplicates proposals, detects request conflicts, prevents stale correction and forgotten-memory resurrection", async () => {
    const f = await fixture(), operationId = randomUUID();
    const input = { operationId, kind: "semantic" as const, content: "Always write Spanish responses." };
    const [first, duplicate] = await Promise.all([memory.propose(f.scope, input), memory.propose(f.scope, input)]);
    expect(duplicate.id).toBe(first.id); expect((await memory.read(f.scope)).generation).toBe(0);
    await expect(memory.propose(f.scope, { ...input, content: "Changed request" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await memory.mutate(f.management, first.id, { action: "accept", operationId: randomUUID(), expectedRevision: 1 });
    const corrected = await memory.mutate(f.management, first.id, { action: "correct", operationId: randomUUID(), expectedRevision: 2, content: "Always write English responses." });
    expect(corrected.revision).toBe(3);
    await expect(memory.mutate(f.management, first.id, { action: "correct", operationId: randomUUID(), expectedRevision: 2, content: "stale" })).rejects.toMatchObject({ code: "MEMORY_CONFLICT" });
    await memory.mutate(f.management, first.id, { action: "forget", operationId: randomUUID(), expectedRevision: 3 });
    expect((await memory.read(f.scope)).memories).toEqual([]);
    expect((await memory.propose(f.scope, input)).status).toBe("forgotten");
    for (const content of [input.content, corrected.content]) await expect(memory.propose(f.scope, { ...input, operationId: randomUUID(), content })).rejects.toMatchObject({ code: "MEMORY_SUPPRESSED" });
  });
  it("serializes namespace generation against dispatch and denies revoked membership", async () => {
    const f = await fixture(), reading = await memory.read(f.scope), db = await pool.connect();
    await db.query("BEGIN"); await db.query("SELECT id FROM agents_platform.memory_scopes WHERE id=$1 FOR SHARE", [reading.scope.id]);
    let completed = false;
    const writing = memory.propose(f.scope, { operationId: randomUUID(), kind: "semantic", content: "Wait behind dispatch claim." }).then(value => { completed = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 50)); expect(completed).toBe(false);
    await db.query("COMMIT"); db.release(); await writing;
    expect((await memory.read(f.scope)).generation).toBe(reading.generation);
    await pool.query("UPDATE agents_platform.memberships SET revoked_at=now() WHERE organization_id=$1 AND account_id=$2", [f.organization.id, f.account.id]);
    await expect(memory.read(f.scope)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });
  it("publishes immutable scoped skill revisions and rejects foreign bindings", async () => {
    const f = await fixture(), input = { operationId: randomUUID(), name: "research-report", description: "Write a research report", body: "Cite the original sources." };
    const one = await memory.publishSkill(f.management, input), replay = await memory.publishSkill(f.management, input);
    expect(replay.id).toBe(one.id); expect(one.revision).toBe(1);
    const two = await memory.publishSkill(f.management, { ...input, operationId: randomUUID(), body: "Cite sources and dates." }); expect(two.revision).toBe(2);
    expect((await memory.readSkills(f.scope, [one.id]))[0]?.body).toBe(input.body);
    await expect(pool.query("UPDATE agents_platform.skill_revisions SET body='changed' WHERE id=$1", [one.id])).rejects.toMatchObject({ code: "23514" });
    const other = await fixture(); await expect(memory.readSkills(other.scope, [one.id])).rejects.toMatchObject({ code: "SKILL_SCOPE_DENIED" });
    expect(await memory.listSkills(f.account.id, f.organization.id, f.agent.id)).toHaveLength(2);
  });
  it("deletes owned source history, cancels open tasks and suppresses linked memory without resurrection", async () => {
    const f = await fixture(), config=defaultBusinessConfiguration();
    const version=await platform.createVersion({accountId:f.account.id,organizationId:f.organization.id,agentId:f.agent.id,expectedRevision:1});
    const authority={product:"agents" as const,organizationId:f.organization.id,resourceId:f.agent.id,callerClientId:"agents-execution",principal:f.scope.principal};
    const grant={...authority,id:randomUUID(),versionId:version.id,operations:["model.reply" as const,"knowledge.read" as const],maxInputBytes:config.model.maxInputBytes,maxOutputTokens:config.model.maxOutputTokens,maxContextTokens:8192,rootTokenLimit:32000,expiresAt:new Date(Date.now()+60_000).toISOString(),revokedAt:null};
    await platform.createGrant({accountId:f.account.id,grant});
    const admitted=await platform.admitTask({authority,grantId:grant.id,versionId:version.id,requestKey:randomUUID(),input:"My preference is detailed reports."});
    const proposed=await memory.propose(f.scope,{operationId:randomUUID(),kind:"semantic",content:"Prefer detailed reports.",sourceTaskId:admitted.task.id});
    await memory.mutate(f.management,proposed.id,{operationId:randomUUID(),expectedRevision:1,action:"accept"});
    const other=await fixture();
    await expect(memory.deleteConversationSources(other.management,admitted.task.conversation_id)).rejects.toMatchObject({code:"NOT_FOUND"});
    const deleted=await memory.deleteConversationSources(f.management,admitted.task.conversation_id);
    expect(deleted.taskIds).toEqual([admitted.task.id]);
    expect((await memory.read(f.scope)).memories).toEqual([]);
    expect((await pool.query("SELECT state FROM agents_platform.tasks WHERE id=$1",[admitted.task.id])).rows[0].state).toBe("cancel_requested");
    await expect(memory.propose(f.scope,{operationId:randomUUID(),kind:"semantic",content:"Fresh inference",sourceTaskId:admitted.task.id})).rejects.toMatchObject({code:"MEMORY_SCOPE_DENIED"});
    const generation=(await memory.read(f.scope)).generation;
    await memory.deleteConversationSources(f.management,admitted.task.conversation_id);
    expect((await memory.read(f.scope)).generation).toBe(generation);
  });
  it("expires memory before retrieval and distinguishes backend failure from an empty result", async () => {
    const f = await fixture();
    const candidate = await memory.propose(f.scope, { operationId: randomUUID(), kind: "semantic", content: "Temporary preference", expiresAt: new Date(Date.now()+60_000).toISOString() });
    await memory.mutate(f.management,candidate.id,{action:"accept",operationId:randomUUID(),expectedRevision:1});
    expect((await memory.read(f.scope)).memories).toHaveLength(1);
    await pool.query("UPDATE agents_platform.memories SET expires_at=now()-interval '1 second' WHERE id=$1",[candidate.id]);
    const before = await pool.query("UPDATE agents_platform.memory_scopes SET next_expiry_at=now()-interval '1 second' WHERE organization_id=$1 RETURNING generation",[f.organization.id]);
    const expired = await memory.read(f.scope); expect(expired.memories).toEqual([]); expect(expired.generation).toBe(Number(before.rows[0].generation)+1);
    const unavailable = new MemoryStore(new Pool({ connectionString:"postgresql://invalid:invalid@127.0.0.1:1/postgres",connectionTimeoutMillis:100 }));
    try { await expect(unavailable.read(f.scope)).rejects.toBeDefined(); } finally { await unavailable.pool.end(); }
  });
  it("management HTTP routes preserve candidate/review/revision separation", async () => {
    const f = await fixture(), app = Fastify();
    registerMemoryRoutes(app, { pool, resolveScope: async () => f.management });
    const base = `/api/organizations/${f.organization.id}/agents/${f.agent.id}`;
    const proposal = await app.inject({ method: "POST", url: `${base}/memory`, payload: { operationId: randomUUID(), kind: "semantic", content: "Prefer concise reports." } });
    expect(proposal.statusCode).toBe(200); const value = proposal.json();
    let list = (await app.inject(`${base}/memory`)).json(); expect(list.items).toHaveLength(0); expect(list.candidates).toHaveLength(1);
    expect((await app.inject({ method: "POST", url: `${base}/memory/candidates/${value.id}/accept`, payload: { operationId: randomUUID(), expectedRevision: 1 } })).statusCode).toBe(200);
    list = (await app.inject(`${base}/memory`)).json(); expect(list.items).toHaveLength(1); expect(list.candidates).toHaveLength(0);
    await app.close();
  });
});
