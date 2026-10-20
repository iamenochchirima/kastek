import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { PlatformStore } from "../src/product/agents/store";
import { SkillPackageStore } from "../src/product/agents/skill-package-store";
import { registerSkillPackageRoutes } from "../src/product/agents/skill-package-routes";
import { defaultBusinessConfiguration } from "../src/contracts/contracts";
import { activateSkillPackage, parseSkillPackage } from "../src/capabilities/skills/package";
import { dropClosedTestDatabase } from "./support/database-cleanup";
import { loadSkillRevisions, MemoryStore } from "../src/execution/memory/memory";
import { curatedSkillPackage } from "../src/capabilities/skills/curated";

const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("reviewed skill package store on real PostgreSQL", () => {
  let admin: Pool, pool: Pool, platform: PlatformStore, store: SkillPackageStore;
  const database = `agents_skills_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${database}`; pool = new Pool({ connectionString: url.href });
    await setupPlatformSchema(pool); platform = new PlatformStore(pool); store = new SkillPackageStore(pool);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); } });
  async function fixture() {
    const account = await platform.ensureAccount({ issuer: "http://localhost:8080/realms/skills", subject: randomUUID(), email: "owner@example.test", displayName: "Owner" });
    const organization = await platform.createOrganization(account.id, "Package tests");
    const agent = await platform.createAgent({ accountId: account.id, organizationId: organization.id, name: "Helper", configuration: defaultBusinessConfiguration() });
    return { accountId: account.id, organizationId: organization.id, agentId: agent.id };
  }
  const input = (reference = "Use source evidence.") => ({ files: [
    { path: "SKILL.md", content: "---\nname: report-helper\ndescription: Build reports when requested.\n---\nRead references/guide.md." },
    { path: "references/guide.md", content: reference },
    { path: "scripts/run.py", content: "raise Exception('never execute during import')" },
  ] });
  it("imports complete immutable revisions atomically, replays requests, reviews exact digest and hides bodies from lists", async () => {
    const scope = await fixture(), operationId = randomUUID(), pkg = parseSkillPackage(input());
    const [first, replay] = await Promise.all([store.import(scope, operationId, pkg), store.import(scope, operationId, pkg)]);
    expect(first.id).toBe(replay.id); expect(first.reviewState).toBe("pending"); expect(first.revision).toBe(1);
    expect(first.files).toHaveLength(3); expect(first).not.toHaveProperty("body"); expect(first.files[0]).not.toHaveProperty("content");
    expect((await store.list(scope)).map(row => row.id)).toEqual([first.id]);
    expect((await store.get(scope, first.id)).body).toBe(pkg.body);
    await expect(store.import(scope, operationId, parseSkillPackage(input("Changed.")))).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(store.review(scope, first.id, "0".repeat(64))).rejects.toMatchObject({ code: "SKILL_REVIEW_REQUIRED" });
    expect((await store.review(scope, first.id, first.contentDigest)).reviewState).toBe("reviewed");
    expect((await store.review(scope, first.id, first.contentDigest)).reviewState).toBe("reviewed");
    const next = await store.import(scope, randomUUID(), parseSkillPackage(input("Changed.")));
    expect(next.revision).toBe(2); expect(next.reviewState).toBe("pending"); expect(next.contentDigest).not.toBe(first.contentDigest);
    expect((await store.file(scope, next.id, "references/guide.md")).content).toBe("Changed.");
    for (const table of ["skill_packages", "skill_package_reviews"]) {
      await expect(pool.query(`DELETE FROM agents_platform.${table} WHERE skill_revision_id=$1`, [first.id])).rejects.toThrow("immutable");
    }
    const persisted = (await pool.query("SELECT p.files,r.content_digest FROM agents_platform.skill_packages p JOIN agents_platform.skill_package_reviews r USING(skill_revision_id) WHERE p.skill_revision_id=$1", [first.id])).rows[0];
    expect(activateSkillPackage(parseSkillPackage({ files: persisted.files.map((file: any) => ({ path: file.path, content: file.content, encoding: file.encoding })) }), persisted.content_digest).body).toBe(pkg.body);
  });
  it("requires organization access for reads and an owner for package review", async () => {
    const owner = await fixture(), outsider = await fixture(), member = await fixture(), pkg = parseSkillPackage(input());
    const revision = await store.import(owner, randomUUID(), pkg);
    await expect(store.get(outsider, revision.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(store.list({ ...owner, accountId: outsider.accountId })).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await pool.query("INSERT INTO agents_platform.memberships(organization_id,account_id,role) VALUES($1,$2,'member')", [owner.organizationId, member.accountId]);
    const memberScope = { ...owner, accountId: member.accountId };
    expect((await store.get(memberScope, revision.id)).body).toBe(pkg.body);
    await expect(store.review(memberScope, revision.id, revision.contentDigest)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    const otherAgent = await platform.createAgent({ accountId: owner.accountId, organizationId: owner.organizationId, name: "Other", configuration: defaultBusinessConfiguration() });
    await expect(store.get({ ...owner, agentId: otherAgent.id }, revision.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(pool.query("INSERT INTO agents_platform.skill_package_reviews(skill_revision_id,organization_id,agent_id,content_digest,reviewed_by) VALUES($1,$2,$3,$4,$5)",
      [revision.id, owner.organizationId, otherAgent.id, revision.contentDigest, owner.accountId])).rejects.toThrow("foreign key");
  });
  it("serves package imports, previews and digest review through management routes", async () => {
    const scope = await fixture(), app = Fastify(), base = `/api/organizations/${scope.organizationId}/agents/${scope.agentId}/skills/packages`;
    registerSkillPackageRoutes(app, { pool, resolveScope: async () => scope });
    try {
      const imported = await app.inject({ method: "POST", url: base, payload: { operationId: randomUUID(), ...input() } });
      expect(imported.statusCode).toBe(200); const pkg = imported.json().package;
      const detail = await app.inject({ method: "GET", url: `${base}/${pkg.id}` }); expect(detail.json().body).toContain("Read references/");
      const file = await app.inject({ method: "GET", url: `${base}/${pkg.id}/files?path=references%2Fguide.md` });
      expect(file.json().content).toBe("Use source evidence."); expect(file.json().evidence.packageDigest).toBe(pkg.contentDigest);
      const review = await app.inject({ method: "POST", url: `${base}/${pkg.id}/review`, payload: { contentDigest: pkg.contentDigest } });
      expect(review.json().package.reviewState).toBe("reviewed");
      const list = await app.inject({ method: "GET", url: base }); expect(list.json().packages).toHaveLength(1);
    } finally { await app.close(); }
  });
  it("blocks pending packages at publication and execution, then loads reviewed exact package instructions", async () => {
    const scope = await fixture(), pkg = parseSkillPackage(input()), revision = await store.import(scope, randomUUID(), pkg);
    const memory = new MemoryStore(pool), account = (await pool.query("SELECT issuer,subject FROM agents_platform.accounts WHERE id=$1", [scope.accountId])).rows[0];
    const humanScope = { organizationId: scope.organizationId, agentId: scope.agentId, principal: { kind: "human" as const, issuer: account.issuer, subject: account.subject } };
    const configuration = { ...defaultBusinessConfiguration(), skillIds: [revision.id] };
    const draft = await platform.updateDraft({ ...scope, configuration, expectedRevision: 1 });
    await expect(platform.createVersion({ ...scope, expectedRevision: draft.draft_revision })).rejects.toMatchObject({ code: "SKILL_REVIEW_REQUIRED" });
    await expect(loadSkillRevisions(pool, scope.organizationId, scope.agentId, [revision.id])).rejects.toMatchObject({ code: "SKILL_REVIEW_REQUIRED" });
    await expect(memory.readSkills(humanScope, [revision.id])).rejects.toMatchObject({ code: "SKILL_REVIEW_REQUIRED" });
    expect((await memory.listSkills(scope.accountId, scope.organizationId, scope.agentId))[0]?.reviewState).toBe("pending");
    await store.review(scope, revision.id, revision.contentDigest);
    const published = await platform.createVersion({ ...scope, expectedRevision: draft.draft_revision });
    expect(published.configuration.skillIds).toEqual([revision.id]);
    const loaded = (await memory.readSkills(humanScope, [revision.id]))[0]!;
    expect(loaded.body).toBe(pkg.body); expect(loaded.contentDigest).toBe(pkg.contentDigest); expect(loaded.package?.files).toHaveLength(3);
    expect(loaded.reviewedDigest).toBe(pkg.contentDigest);
    const changed = await store.import(scope, randomUUID(), parseSkillPackage(input("Changed reference instructions.")));
    await expect(loadSkillRevisions(pool, scope.organizationId, scope.agentId, [changed.id])).rejects.toMatchObject({ code: "SKILL_REVIEW_REQUIRED" });
    expect((await loadSkillRevisions(pool, scope.organizationId, scope.agentId, [revision.id]))[0]?.contentDigest).toBe(pkg.contentDigest);
  });
  it("installs official skill packages with durable source identity and owner review without granting execution", async () => {
    const scope = await fixture(), member = await fixture(), operationId = randomUUID();
    const catalogue = await store.curated(scope);
    expect(catalogue.map(skill => skill.slug)).toEqual(["grounded-answers", "customer-handoff"]);
    expect(catalogue.every(skill => skill.publisher.verified)).toBe(true); expect(catalogue[0]).not.toHaveProperty("body");
    const installed = await store.installCurated(scope, "grounded-answers", operationId);
    expect(installed.reviewState).toBe("reviewed"); expect(installed.publisher).toEqual({ id: "kasitek", name: "KasiTek", verified: true });
    expect(installed.source).toEqual({ kind: "curated", slug: "grounded-answers" });
    expect((await store.installCurated(scope, "grounded-answers", operationId)).id).toBe(installed.id);
    expect((await platform.getAgent(scope.accountId, scope.organizationId, scope.agentId)).draft.skillIds).toEqual([]);
    const privateCopy = await store.import(scope, randomUUID(), curatedSkillPackage("grounded-answers"));
    expect(privateCopy.publisher.verified).toBe(false); expect(privateCopy.source.kind).toBe("private");
    await expect(store.import(scope, randomUUID(), parseSkillPackage(input()), "grounded-answers")).rejects.toMatchObject({ code: "SKILL_PACKAGE_INVALID" });
    await pool.query("INSERT INTO agents_platform.memberships(organization_id,account_id,role) VALUES($1,$2,'member')", [scope.organizationId, member.accountId]);
    const pending = await store.installCurated({ ...scope, accountId: member.accountId }, "customer-handoff", randomUUID());
    expect(pending.reviewState).toBe("pending"); expect(pending.publisher.verified).toBe(true);
    await expect(loadSkillRevisions(pool, scope.organizationId, scope.agentId, [pending.id])).rejects.toMatchObject({ code: "SKILL_REVIEW_REQUIRED" });
    const app = Fastify(), base = `/api/organizations/${scope.organizationId}/agents/${scope.agentId}/skills/curated`;
    registerSkillPackageRoutes(app, { pool, resolveScope: async () => scope });
    try {
      expect((await app.inject({ method: "GET", url: base })).json().skills).toHaveLength(2);
      expect((await app.inject({ method: "GET", url: `${base}/customer-handoff` })).json().body).toContain("Do not invent a support address");
      const response = await app.inject({ method: "POST", url: `${base}/customer-handoff/install`, payload: { operationId: randomUUID() } });
      expect(response.statusCode).toBe(200); expect(response.json().package.reviewState).toBe("reviewed");
    } finally { await app.close(); }
  });
});
