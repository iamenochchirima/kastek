import { skillPackageCodec } from "../src/capabilities/skills/package";
import { randomUUID,randomBytes,createHash } from "node:crypto";
import { Pool } from "pg";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { PlatformStore } from "../src/product/agents/store";
import { SkillPackageStore } from "../src/product/agents/skill-package-store";
import { registerSkillPackageRoutes } from "../src/product/agents/skill-package-routes";
import { defaultBusinessConfiguration, executionGrantSchema } from "../src/contracts/contracts";
import { activateSkillPackage, parseSkillPackage } from "../src/capabilities/skills/package";
import { dropClosedTestDatabase } from "./support/database-cleanup";
import { loadSkillRevisions } from "../src/execution/memory/skills";
import { MemoryStore } from "../src/execution/memory/memory";
import {assertCurrentSkillPolicy} from "../src/capabilities/skills/current-policy";
import type {Execution} from "../src/contracts/execution";
import { composeInbox } from "../src/composition/inbox";
import { customerConfiguration } from "../src/product/offerings/offerings";
import { assertPublicSkillPolicy } from "../src/capabilities/skills/public-policy";
import { executeSkillTool } from "../src/capabilities/skills/runtime";
import { contextGrantCeiling } from "../src/execution/models/settings";
import { skillContext } from "../src/execution/context/skills";
import { assertCurrentAuthority,beginOperation,finishOperation,loadExecution } from "../src/execution/lifecycle/execution";
import { connectFixtureModel } from "./model-fixture";
import { curatedSkillPackage } from "../src/capabilities/skills/curated";
import { EvidenceStore } from "../src/execution/context/evidence";

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
    await connectFixtureModel(pool, account.id, organization.id);
    const agent = await platform.createAgent({ accountId: account.id, organizationId: organization.id, name: "Helper", configuration: defaultBusinessConfiguration() });
    return { accountId: account.id, organizationId: organization.id, agentId: agent.id };
  }
  const input = (reference = "Use source evidence.") => ({ files: [
    { path: "SKILL.md", content: "---\nname: report-helper\ndescription: Build reports when requested.\n---\nRead references/guide.md." },
    { path: "references/guide.md", content: reference },
    { path: "scripts/run.py", content: "raise Exception('never execute during import')" },
  ] });
  async function skillVersion(scope:Awaited<ReturnType<typeof fixture>>,skillId:string) {
    const configuration={...customerConfiguration("faq"),skillIds:[skillId]};
    const agent=await platform.getAgent(scope.accountId,scope.organizationId,scope.agentId);
    const draft=await platform.updateDraft({...scope,configuration,expectedRevision:agent.draft_revision});
    return platform.createVersion({...scope,expectedRevision:draft.draft_revision});
  }
  async function publicSkillTask(scope:Awaited<ReturnType<typeof fixture>>,skillId:string) {
    const origin="https://public-skills.fixture.test",version=await skillVersion(scope,skillId);
    const deployment=await platform.publishWebsite({...scope,versionId:version.id,allowedOrigins:[origin]});
    const visitor={deploymentId:deployment.id,sessionId:randomUUID()},token=randomBytes(32).toString("base64url");
    await pool.query("INSERT INTO agents_platform.website_sessions(id,deployment_id,token_hash,origin) VALUES($1,$2,$3,$4)",[visitor.sessionId,deployment.id,createHash("sha256").update(token).digest("hex"),origin]);
    const inbox=composeInbox(pool,{publicOrigin:origin,async assertServices(){}}),conversation=await inbox.open(visitor);
    const admitted=await inbox.ingress(visitor,conversation.id,{requestKey:randomUUID(),body:"Answer using the approved public instructions."});
    expect(admitted.message.task_id).toBeTruthy();return {version,deployment,taskId:admitted.message.task_id!};
  }
  it("publishes reviewed curated instructions and activates them under a real website visitor grant",async()=>{
    const scope=await fixture(),installed=await store.installCurated(scope,"grounded-answers",randomUUID());
    const published=await publicSkillTask(scope,installed.id),execution=await loadExecution(pool,published.taskId);
    await assertCurrentAuthority(pool,execution);
    expect(execution.task.principal).toMatchObject({kind:"visitor",deploymentId:published.deployment.id});
    const grant=(await pool.query("SELECT operations FROM agents_platform.execution_grants WHERE id=$1",[execution.task.grant_id])).rows[0];expect(grant.operations).toContain("skill.read");
    const revisions=await loadSkillRevisions(pool,scope.organizationId,scope.agentId,[installed.id], skillPackageCodec);
    expect((await skillContext(pool,published.taskId,revisions)).sources).toEqual([]);
    const operationId=`tool:${published.taskId}:public-curated`;
    await beginOperation(pool,published.taskId,{id:operationId,kind:"tool",name:"skills.activate",request:{skillId:installed.id},reservedTokens:0,reservedMs:30000,retrySafe:true});
    const loaded=await executeSkillTool(pool,published.taskId,"skills.activate",{skillId:installed.id});
    expect(loaded.content).toBe(curatedSkillPackage("grounded-answers").body);expect(loaded.evidence.packageDigest).toBe(installed.contentDigest);
    await finishOperation(pool,published.taskId,operationId,"completed",loaded,null,0);
    const restored=await skillContext(pool,published.taskId,revisions);expect(restored.catalog).toMatchObject([{id:installed.id,packageDigest:installed.contentDigest}]);expect(restored.sources).toHaveLength(1);expect(JSON.parse(restored.sources[0]!.content).instructions).toBe(loaded.content);expect(restored.sources[0]!.skillFile).toEqual(loaded.evidence);
  });
  it.each(["private","repository"] as const)("refuses a reviewed %s copy of the exact curated bytes at website publication",async kind=>{
    const scope=await fixture(),current=curatedSkillPackage("grounded-answers");
    const imported=await store.import(scope,randomUUID(),current,undefined,kind==="repository"?{repository:"fixture/instructions",commit:"a".repeat(40),path:"skills/grounded-answers",tree:"b".repeat(40)}:undefined);
    await store.review(scope,imported.id,imported.contentDigest);expect(imported.contentDigest).toBe(current.contentDigest);
    const version=await skillVersion(scope,imported.id);
    await expect(platform.publishWebsite({...scope,versionId:version.id,allowedOrigins:["https://public-skills.fixture.test"]})).rejects.toMatchObject({code:"PUBLIC_SKILL_POLICY_REQUIRED"});
    expect((await pool.query("SELECT 1 FROM agents_platform.website_deployments WHERE version_id=$1",[version.id])).rowCount).toBe(0);
  });
  it("requires exact review even for server-curated packages installed by a member",async()=>{
    const scope=await fixture(),member=await fixture();await pool.query("INSERT INTO agents_platform.memberships(organization_id,account_id,role) VALUES($1,$2,'member')",[scope.organizationId,member.accountId]);
    const pending=await store.installCurated({...scope,accountId:member.accountId},"grounded-answers",randomUUID());expect(pending.reviewState).toBe("pending");
    await expect(assertPublicSkillPolicy(pool,scope.organizationId,scope.agentId,[pending.id])).rejects.toMatchObject({code:"PUBLIC_SKILL_POLICY_REQUIRED"});
    await expect(skillVersion(scope,pending.id)).rejects.toMatchObject({code:"SKILL_REVIEW_REQUIRED"});
  });
  it("withdraws already-published visitor skill authority when the installation is disabled or removed",async()=>{
    const scope=await fixture(),installed=await store.installCurated(scope,"grounded-answers",randomUUID()),published=await publicSkillTask(scope,installed.id);
    await assertCurrentAuthority(pool,await loadExecution(pool,published.taskId));
    for(const [index,state]of (["disabled","removed"] as const).entries()){
      await store.setState(scope,installed.id,{operationId:randomUUID(),expectedGeneration:index+1,state});
      await expect(assertCurrentAuthority(pool,await loadExecution(pool,published.taskId))).rejects.toMatchObject({code:"PUBLIC_SKILL_POLICY_REQUIRED"});
      await expect(executeSkillTool(pool,published.taskId,"skills.activate",{skillId:installed.id})).rejects.toMatchObject({code:"PUBLIC_SKILL_POLICY_REQUIRED"});
      await expect(platform.publishWebsite({...scope,versionId:published.version.id,allowedOrigins:["https://public-skills.fixture.test"]})).rejects.toMatchObject({code:"PUBLIC_SKILL_POLICY_REQUIRED"});
    }
  });
  it("rejects curated installation IDs from another agent or tenant",async()=>{
    const scope=await fixture(),other=await fixture(),installed=await store.installCurated(scope,"grounded-answers",randomUUID());
    await expect(assertPublicSkillPolicy(pool,other.organizationId,scope.agentId,[installed.id])).rejects.toMatchObject({code:"PUBLIC_SKILL_POLICY_REQUIRED"});
    const sibling=await platform.createAgent({accountId:scope.accountId,organizationId:scope.organizationId,name:"Sibling"});
    await expect(assertPublicSkillPolicy(pool,scope.organizationId,sibling.id,[installed.id])).rejects.toMatchObject({code:"PUBLIC_SKILL_POLICY_REQUIRED"});
  });
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
  it("isolates update families and enforces reversible disable followed by terminal removal",async()=>{
    const scope=await fixture(),first=await store.import(scope,randomUUID(),parseSkillPackage(input()));
    const next=await store.import(scope,randomUUID(),parseSkillPackage(input("Changed reference")));
    expect(first.familyId).toBe(next.familyId);
    const comparison=await store.compare(scope,first.id,next.id);expect(comparison.files).toMatchObject([{path:"references/guide.md",change:"changed"}]);
    const foreign=await store.import(scope,randomUUID(),parseSkillPackage(input()),undefined,{repository:"publisher/procedures",commit:"a".repeat(40),path:"skills/report-helper",tree:"b".repeat(40)});
    expect(foreign.familyId).not.toBe(first.familyId);await expect(store.compare(scope,first.id,foreign.id)).rejects.toMatchObject({code:"SKILL_UPDATE_MISMATCH"});
    await store.review(scope,first.id,first.contentDigest);await store.review(scope,next.id,next.contentDigest);
    await expect(loadSkillRevisions(pool,scope.organizationId,scope.agentId,[first.id,next.id], skillPackageCodec)).rejects.toMatchObject({code:"SKILL_FAMILY_CONFLICT"});
    const mutation={operationId:randomUUID(),expectedGeneration:1,state:"disabled"};
    const disabled=await store.setState(scope,first.id,mutation);expect(disabled.state).toBe("disabled");expect(disabled.generation).toBe(2);
    expect(await store.setState(scope,first.id,mutation)).toEqual(disabled);
    await expect(loadSkillRevisions(pool,scope.organizationId,scope.agentId,[first.id], skillPackageCodec)).rejects.toMatchObject({code:"SKILL_DISABLED"});
    await expect(store.setState(scope,first.id,{...mutation,operationId:randomUUID()})).rejects.toMatchObject({code:"SKILL_STATE_CONFLICT"});
    await store.setState(scope,first.id,{operationId:randomUUID(),expectedGeneration:2,state:"enabled"});
    expect(await loadSkillRevisions(pool,scope.organizationId,scope.agentId,[first.id], skillPackageCodec)).toHaveLength(1);
    await store.setState(scope,first.id,{operationId:randomUUID(),expectedGeneration:3,state:"removed"});
    expect((await store.list(scope)).some(pkg=>pkg.id===first.id)).toBe(false);
    await expect(store.setState(scope,first.id,{operationId:randomUUID(),expectedGeneration:4,state:"enabled"})).rejects.toMatchObject({code:"SKILL_STATE_CONFLICT"});
    await expect(store.review(scope,first.id,first.contentDigest)).rejects.toMatchObject({code:"SKILL_STATE_CONFLICT"});
  });
  it("fences current authority against disabled packages and missing actual grant requirements",async()=>{
    const scope=await fixture();
    const pkg=parseSkillPackage({files:[{path:"SKILL.md",content:`---\nname: requirements-helper\ndescription: Apply when connected evidence is needed.\nmetadata:\n  kasitek.requirements: '{"permissions":["connected.read"]}'\n---\nRead verified connected evidence.`}]});
    const revision=await store.import(scope,randomUUID(),pkg);await store.review(scope,revision.id,revision.contentDigest);
    const draft=await platform.updateDraft({...scope,configuration:{...defaultBusinessConfiguration(),skillIds:[revision.id]},expectedRevision:1});
    await expect(platform.createVersion({...scope,expectedRevision:draft.draft_revision})).rejects.toMatchObject({code:"SKILL_REQUIREMENTS_UNAVAILABLE"});
    const execution={configuration:{...defaultBusinessConfiguration(),skillIds:[revision.id]},task:{organization_id:scope.organizationId},agentId:scope.agentId,connectedBindings:[]} as unknown as Execution;
    await expect(assertCurrentSkillPolicy(pool,execution,[])).rejects.toMatchObject({code:"SKILL_REQUIREMENTS_UNAVAILABLE"});
    await assertCurrentSkillPolicy(pool,execution,["connected.read"]);
    const db=await pool.connect();try{
      await db.query("BEGIN");await assertCurrentSkillPolicy(db,execution,["connected.read"]);
      let settled=false;const disabling=store.setState(scope,revision.id,{operationId:randomUUID(),expectedGeneration:1,state:"disabled"}).finally(()=>{settled=true;});
      await db.query("SELECT pg_sleep(0.03)");expect(settled).toBe(false);await db.query("COMMIT");await disabling;
    }finally{await db.query("ROLLBACK");db.release();}
    await expect(assertCurrentSkillPolicy(pool,execution,["connected.read"])).rejects.toMatchObject({code:"SKILL_DISABLED"});
  });
  it("requires an active exact connection policy for declared profile dependencies",async()=>{
    const scope=await fixture(),connectionId=randomUUID();
    await pool.query("INSERT INTO agents_platform.connections(id,organization_id,account_id,name,target_id,resource,profile_id) VALUES($1,$2,$3,'Profile requirement','provider:custom-api','https://example.test','custom-api-v1')",[connectionId,scope.organizationId,scope.accountId]);
    const pkg=parseSkillPackage({files:[{path:"SKILL.md",content:`---\nname: connected-helper\ndescription: Apply to connected API questions.\nmetadata:\n  kasitek.requirements: '{"connectionProfiles":["custom-api-v1"]}'\n---\nUse approved connection evidence.`}]});
    const revision=await store.import(scope,randomUUID(),pkg);await store.review(scope,revision.id,revision.contentDigest);
    const execution={configuration:{...defaultBusinessConfiguration(),skillIds:[revision.id]},task:{organization_id:scope.organizationId},agentId:scope.agentId,connectedBindings:[{connection:{id:connectionId,profileId:"custom-api-v1",policyRevision:1}}]} as unknown as Execution;
    await assertCurrentSkillPolicy(pool,execution,[]);
    await pool.query("UPDATE agents_platform.connections SET policy_revision=2 WHERE id=$1",[connectionId]);
    await expect(assertCurrentSkillPolicy(pool,execution,[])).rejects.toMatchObject({code:"SKILL_REQUIREMENTS_UNAVAILABLE"});
    (execution.connectedBindings[0].connection!).policyRevision=2;await assertCurrentSkillPolicy(pool,execution,[]);
    await pool.query("UPDATE agents_platform.connections SET state='revoked' WHERE id=$1",[connectionId]);
    await expect(assertCurrentSkillPolicy(pool,execution,[])).rejects.toMatchObject({code:"SKILL_REQUIREMENTS_UNAVAILABLE"});
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
    const memory = new MemoryStore(pool, skillPackageCodec), account = (await pool.query("SELECT issuer,subject FROM agents_platform.accounts WHERE id=$1", [scope.accountId])).rows[0];
    const humanScope = { organizationId: scope.organizationId, agentId: scope.agentId, principal: { kind: "human" as const, issuer: account.issuer, subject: account.subject } };
    const configuration = { ...defaultBusinessConfiguration(), skillIds: [revision.id] };
    const draft = await platform.updateDraft({ ...scope, configuration, expectedRevision: 1 });
    await expect(platform.createVersion({ ...scope, expectedRevision: draft.draft_revision })).rejects.toMatchObject({ code: "SKILL_REVIEW_REQUIRED" });
    await expect(loadSkillRevisions(pool, scope.organizationId, scope.agentId, [revision.id], skillPackageCodec)).rejects.toMatchObject({ code: "SKILL_REVIEW_REQUIRED" });
    await expect(memory.readSkills(humanScope, [revision.id])).rejects.toMatchObject({ code: "SKILL_REVIEW_REQUIRED" });
    expect((await memory.listSkills(scope.accountId, scope.organizationId, scope.agentId))[0]?.reviewState).toBe("pending");
    await store.review(scope, revision.id, revision.contentDigest);
    const published = await platform.createVersion({ ...scope, expectedRevision: draft.draft_revision });
    expect(published.configuration.skillIds).toEqual([revision.id]);
    const loaded = (await memory.readSkills(humanScope, [revision.id]))[0]!;
    expect(loaded.body).toBe(pkg.body); expect(loaded.contentDigest).toBe(pkg.contentDigest); expect(loaded.package?.files).toHaveLength(3);
    expect(loaded.reviewedDigest).toBe(pkg.contentDigest);
    const changed = await store.import(scope, randomUUID(), parseSkillPackage(input("Changed reference instructions.")));
    await expect(loadSkillRevisions(pool, scope.organizationId, scope.agentId, [changed.id], skillPackageCodec)).rejects.toMatchObject({ code: "SKILL_REVIEW_REQUIRED" });
    expect((await loadSkillRevisions(pool, scope.organizationId, scope.agentId, [revision.id], skillPackageCodec))[0]?.contentDigest).toBe(pkg.contentDigest);
  });
  it("persists long complete procedures and exact resource pages under current reviewed authority", async () => {
    const scope = await fixture(), files = input("😀 decisive source data\n".repeat(600));
    files.files[0]!.content += "\nCheck each approved source before writing. ".repeat(180);
    const pkg = parseSkillPackage(files), installed = await store.import(scope, randomUUID(), pkg);
    await store.review(scope, installed.id, installed.contentDigest);
    const configuration = { ...defaultBusinessConfiguration(), skillIds: [installed.id] };
    const draft = await platform.updateDraft({ ...scope, configuration, expectedRevision: 1 });
    const version = await platform.createVersion({ ...scope, expectedRevision: draft.draft_revision });
    const account = (await pool.query("SELECT issuer,subject FROM agents_platform.accounts WHERE id=$1", [scope.accountId])).rows[0];
    const authority = { product: "agents" as const, organizationId: scope.organizationId, resourceId: scope.agentId,
      callerClientId: "agents-execution", principal: { kind: "human" as const, issuer: account.issuer, subject: account.subject } };
    const grant = executionGrantSchema.parse({ ...authority, id: randomUUID(), versionId: version.id,
      operations: ["model.reply", "knowledge.read", "skill.read"], maxInputBytes: 16384, maxOutputTokens: configuration.model.maxOutputTokens,
      maxContextTokens: contextGrantCeiling(configuration),
      expiresAt: new Date(Date.now() + 600000).toISOString(), revokedAt: null });
    await platform.createGrant({ accountId: scope.accountId, grant });
    const { task } = await platform.admitTask({ authority, grantId: grant.id, versionId: version.id, requestKey: randomUUID(), input: "Prepare the report" });
    const activate = randomUUID();
    await beginOperation(pool, task.id, { id: activate, kind: "tool", name: "skills.activate", request: {}, reservedTokens: 0, reservedMs: 30000 });
    const instructions = await executeSkillTool(pool, task.id, "skills.activate", { skillId: installed.id }, 20000);
    expect(Buffer.byteLength(instructions.content)).toBeGreaterThan(4096);
    await expect(executeSkillTool(pool, task.id, "skills.activate", { skillId: installed.id }, 6144, undefined, "1"))
      .rejects.toMatchObject({ code: "SKILL_CONTEXT_LIMIT" });
    await finishOperation(pool, task.id, activate, "completed", instructions, null, 0);
    const legacy = await executeSkillTool(pool, task.id, "skills.read", { skillId: installed.id, path: "scripts/run.py" }, 6144, undefined, "1");
    expect(legacy.content).toContain("never execute during import"); expect(legacy.range).toBeUndefined();
    await expect(executeSkillTool(pool, task.id, "skills.read", { skillId: installed.id, path: "references/guide.md", offset: 0 }, 6144, undefined, "1"))
      .rejects.toMatchObject({ code: "TOOL_ARGUMENTS_INVALID" });
    await expect(executeSkillTool(pool, task.id, "skills.read", { skillId: installed.id, path: "references/guide.md" }, 6144, undefined, "1"))
      .rejects.toMatchObject({ code: "SKILL_CONTEXT_LIMIT" });
    let offset = 0;
    for (let index = 0; index < 2; index++) {
      const id = randomUUID();
      await beginOperation(pool, task.id, { id, kind: "tool", name: "skills.read", request: { offset }, reservedTokens: 0, reservedMs: 30000 });
      const page = await executeSkillTool(pool, task.id, "skills.read", { skillId: installed.id, path: "references/guide.md", offset }, 1200);
      expect(page.range?.start).toBe(offset); expect(page.content).not.toContain("�");
      expect(page.range?.nextOffset).toBeGreaterThan(offset);
      await finishOperation(pool, task.id, id, "completed", page, null, 0);
      offset = page.range!.nextOffset!;
    }
    const revisions = await loadSkillRevisions(pool, scope.organizationId, scope.agentId, [installed.id], skillPackageCodec);
    const restored = await skillContext(pool, task.id, revisions);
    expect(restored.sources).toHaveLength(3);
    expect(restored.sources.filter(source => source.skillFile?.path === "references/guide.md").map(source => source.skillRange?.start)).toEqual([0, expect.any(Number)]);
    expect(JSON.parse(restored.sources.find(source => source.skillFile?.path === "SKILL.md")!.content).instructions).toBe(pkg.body);
    const receiptEvidence = new EvidenceStore(pool);
    await expect(receiptEvidence.validateOperation(task.id, activate)).resolves.toBeUndefined();
    await store.setState(scope, installed.id, { operationId: randomUUID(), expectedGeneration: 1, state: "disabled" });
    await expect(receiptEvidence.retainOperation(task.id, activate)).rejects.toMatchObject({ code: "SKILL_DISABLED" });
    await expect(executeSkillTool(pool, task.id, "skills.read", { skillId: installed.id, path: "references/guide.md", offset })).rejects.toMatchObject({ code: "SKILL_DISABLED" });
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
    await expect(loadSkillRevisions(pool, scope.organizationId, scope.agentId, [pending.id], skillPackageCodec)).rejects.toMatchObject({ code: "SKILL_REVIEW_REQUIRED" });
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
