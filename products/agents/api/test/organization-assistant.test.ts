import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { transaction } from "../src/infrastructure/database";
import { OrganizationAssistantStore, ensureOrganizationAssistantInTransaction } from "../src/product/agents/organization-assistant";
import { PlatformStore } from "../src/product/agents/store";
import { dropClosedTestDatabase } from "./support/database-cleanup";
import { connectFixtureModel } from "./model-fixture";
import { specialistCatalogue } from "../src/product/assistant/specialists";
import { agentConfigurationSchema, defaultBusinessConfiguration } from "../src/contracts/contracts";
import { publishFixtureSource } from "./knowledge-fixture";

const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("organization assistant provisioning", () => {
  let admin: Pool, pool: Pool, store: PlatformStore, assistants: OrganizationAssistantStore;
  const databaseName = `agents_assistant_test_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${databaseName}`;
    pool = new Pool({ connectionString: url.href, max: 10 });
    await setupPlatformSchema(pool);
    store = new PlatformStore(pool);
    assistants = new OrganizationAssistantStore(pool);
  });
  afterAll(async () => {
    await pool?.end();
    if (admin) { await dropClosedTestDatabase(admin, databaseName); await admin.end(); }
  });
  const account = () => store.ensureAccount({ issuer: "https://assistant.fixture.test", subject: randomUUID(), email: "owner@example.test", displayName: "Owner" });
  async function fixture() {
    const owner = await account();
    const organization = await store.createOrganization(owner.id, "Assistant fixture");
    return { owner, organization };
  }

  it("creates an ordinary draft atomically for explicit and initial organizations", async () => {
    const { owner, organization } = await fixture();
    const assistant = await assistants.getOrganizationAssistant(owner.id, organization.id);
    expect(assistant).toMatchObject({ state: "draft", version: null, agent: { name: "Assistant", created_by: owner.id,
      offering: null, draft: { executionKind: "business", model: { selection: { kind: "organization_default" } }, tools: ["tasks.inspect", "tasks.cancel"],
        sourceRevisionIds: [], connectedToolBindingIds: [], memory: { enabled: false }, capabilities: { delegation: { enabled: false } } } } });
    expect(await store.listAgents(owner.id, organization.id)).toHaveLength(1);
    const initial = await account();
    await Promise.all(Array.from({ length: 6 }, () => store.ensureInitialWorkspace(initial.id)));
    const organizations = await store.listOrganizations(initial.id);
    expect(organizations).toHaveLength(1);
    expect((await assistants.getOrganizationAssistant(initial.id, organizations[0]!.id)).state).toBe("draft");
    expect(await store.listAgents(initial.id, organizations[0]!.id)).toHaveLength(1);
  });

  it("serializes concurrent repair and preserves customized instructions and names", async () => {
    const { owner, organization } = await fixture();
    const original = (await assistants.getOrganizationAssistant(owner.id, organization.id)).agent!;
    const updated = await store.updateDraft({ accountId: owner.id, organizationId: organization.id, agentId: original.id,
      expectedRevision: original.draft_revision, name: "Operations", configuration: { ...original.draft, instructions: "Keep my customized instructions." } });
    const results = await Promise.all(Array.from({ length: 6 }, () => assistants.repairOrganizationAssistant(owner.id, organization.id)));
    for (const result of results) expect(result.agent).toMatchObject({ id: original.id, name: "Operations", draft_revision: updated.draft_revision,
      draft: { instructions: "Keep my customized instructions." } });
    expect(await store.listAgents(owner.id, organization.id)).toHaveLength(1);
    const lifecycle = (await pool.query("SELECT envelope FROM analytics_outbox WHERE scope_external_id=$1 AND contract_name='agent.assistant.lifecycle@1'", [organization.id])).rows;
    expect(lifecycle).toHaveLength(1);
    expect(lifecycle[0].envelope.data).toMatchObject({ action: "provisioned", channel_type: "app" });
  });

  it("keeps deletion as a tombstone until explicit owner restoration", async () => {
    const { owner, organization } = await fixture();
    const original = (await assistants.getOrganizationAssistant(owner.id, organization.id)).agent!;
    await store.deleteAgent(owner.id, organization.id, original.id);
    await store.ensureInitialWorkspace(owner.id);
    const result = await transaction(pool, db => ensureOrganizationAssistantInTransaction(db, { accountId: owner.id, organizationId: organization.id }));
    expect(result).toEqual({ state: "deleted", agentId: original.id, agent: null, version: null });
    expect(await store.listAgents(owner.id, organization.id)).toEqual([]);
    const restored = await assistants.repairOrganizationAssistant(owner.id, organization.id);
    expect(restored).toMatchObject({ state: "draft", agent: { id: original.id, draft_revision: original.draft_revision, draft: original.draft } });
  });

  it("requires current membership to inspect and current owner access to repair", async () => {
    const { owner, organization } = await fixture();
    const member = await account(), outsider = await account();
    await pool.query("INSERT INTO agents_platform.memberships(organization_id,account_id,role) VALUES($1,$2,'member')", [organization.id, member.id]);
    expect((await assistants.getOrganizationAssistant(member.id, organization.id)).state).toBe("draft");
    await expect(assistants.repairOrganizationAssistant(member.id, organization.id)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(assistants.getOrganizationAssistant(outsider.id, organization.id)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await expect(assistants.repairOrganizationAssistant(outsider.id, organization.id)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await pool.query("UPDATE agents_platform.memberships SET revoked_at=now() WHERE organization_id=$1 AND account_id=$2", [organization.id, owner.id]);
    await expect(assistants.repairOrganizationAssistant(owner.id, organization.id)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });

  it("restores configuration without reviving a deleted agent's execution grants", async () => {
    const { owner, organization } = await fixture();
    const assistant = (await assistants.getOrganizationAssistant(owner.id, organization.id)).agent!;
    await connectFixtureModel(pool, owner.id, organization.id);
    const version = await store.createVersion({ accountId: owner.id, organizationId: organization.id, agentId: assistant.id, expectedRevision: assistant.draft_revision });
    const grant = await store.createGrant({ accountId: owner.id, grant: {
      id: randomUUID(), product: "agents", organizationId: organization.id, resourceId: assistant.id, callerClientId: "agents-execution",
      principal: { kind: "human", issuer: owner.issuer, subject: owner.subject }, versionId: version.id, operations: ["model.reply", "tasks.read", "tasks.cancel"],
      maxInputBytes: assistant.draft.model.maxInputBytes, maxOutputTokens: assistant.draft.model.maxOutputTokens,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), revokedAt: null,
    } });
    await store.deleteAgent(owner.id, organization.id, assistant.id);
    const revoked = (await pool.query("SELECT revoked_at FROM agents_platform.execution_grants WHERE id=$1", [grant.id])).rows[0].revoked_at;
    expect(revoked).toBeInstanceOf(Date);
    const restored = await assistants.repairOrganizationAssistant(owner.id, organization.id);
    expect(restored).toMatchObject({ state: "configured", version: { id: version.id } });
    expect((await pool.query("SELECT revoked_at FROM agents_platform.execution_grants WHERE id=$1", [grant.id])).rows[0].revoked_at).toEqual(revoked);
  });

  it("leaves existing organizations unchanged until an owner explicitly repairs setup", async () => {
    const owner = await account(), organizationId = randomUUID();
    await pool.query("INSERT INTO agents_platform.organizations(id,name) VALUES($1,'Existing fixture')", [organizationId]);
    await pool.query("INSERT INTO agents_platform.memberships(organization_id,account_id,role) VALUES($1,$2,'owner')", [organizationId, owner.id]);
    await store.ensureInitialWorkspace(owner.id);
    expect((await assistants.getOrganizationAssistant(owner.id, organizationId)).state).toBe("absent");
    const unrelated = await store.createAgent({ accountId: owner.id, organizationId, name: "Assistant" });
    const results = await Promise.all(Array.from({ length: 6 }, () => assistants.repairOrganizationAssistant(owner.id, organizationId)));
    expect(new Set(results.map(result => result.agentId)).size).toBe(1);
    expect(results[0]!.agentId).not.toBe(unrelated.id);
    expect(await store.listAgents(owner.id, organizationId)).toHaveLength(2);
  });

  it("rolls back organization, membership and agent together when setup fails", async () => {
    const owner = await account();
    await pool.query(`CREATE FUNCTION agents_platform.reject_assistant_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Injected assistant setup failure'; END $$`);
    await pool.query(`CREATE TRIGGER reject_assistant_fixture BEFORE INSERT ON agents_platform.organization_assistants
      FOR EACH ROW EXECUTE FUNCTION agents_platform.reject_assistant_fixture()`);
    try {
      await expect(store.createOrganization(owner.id, "Failed setup")).rejects.toThrow("Injected assistant setup failure");
      await expect(store.ensureInitialWorkspace(owner.id)).rejects.toThrow("Injected assistant setup failure");
      expect(await store.listOrganizations(owner.id)).toEqual([]);
      expect((await pool.query("SELECT id FROM agents_platform.agents WHERE created_by=$1", [owner.id])).rowCount).toBe(0);
    } finally {
      await pool.query("DROP TRIGGER reject_assistant_fixture ON agents_platform.organization_assistants");
      await pool.query("DROP FUNCTION agents_platform.reject_assistant_fixture()");
    }
    await store.ensureInitialWorkspace(owner.id);
    expect(await store.listOrganizations(owner.id)).toHaveLength(1);
  });

  it("catalogues actual specialist readiness and retains an older pinned version within the organization", async () => {
    const { owner, organization } = await fixture(), foreign = await fixture();
    const scope = { accountId: owner.id, organizationId: organization.id };
    const parent = (await assistants.getOrganizationAssistant(owner.id, organization.id)).agent!;
    const model = await connectFixtureModel(pool, owner.id, organization.id);
    const content = await store.createAgent({ ...scope, name: "Content", configuration: { ...parent.draft, instructions: "Original Content instructions" } });
    const old = await store.createVersion({ ...scope, agentId: content.id, expectedRevision: 1 });
    const updated = await store.updateDraft({ ...scope, agentId: content.id, expectedRevision: 1, configuration: { ...content.draft, instructions: "Current Content instructions" } });
    const current = await store.createVersion({ ...scope, agentId: content.id, expectedRevision: updated.draft_revision });
    const privateSpecialist = await store.createAgent({ accountId: foreign.owner.id, organizationId: foreign.organization.id, name: "Foreign private specialist", configuration: parent.draft });
    await store.createVersion({ accountId: foreign.owner.id, organizationId: foreign.organization.id, agentId: privateSpecialist.id, expectedRevision: 1 });
    await store.updateDraft({ ...scope, agentId: parent.id, expectedRevision: parent.draft_revision, configuration: { ...parent.draft, tools: ["agents.delegate"],
      capabilities: { ...parent.draft.capabilities, delegation: { enabled: true, maxDepth: 1, maxChildren: 2,
        bindings: [{ id: "content", versionId: old.id, tools: [], sourceRevisionIds: [], connectedToolBindingIds: [], maxTokens: 8000, maxActiveMs: 120000 }] } } } });
    const available = await specialistCatalogue(pool, scope, parent.id);
    expect(available.specialists).toEqual([
      expect.objectContaining({ agentId: content.id, versionId: current.id, versionNumber: current.number, description: "Current Content instructions", ready: true, reasons: [] }),
      expect.objectContaining({ agentId: content.id, versionId: old.id, versionNumber: old.number, description: "Original Content instructions", ready: true, reasons: [] }),
    ]);
    await expect(specialistCatalogue(pool, { accountId: foreign.owner.id, organizationId: foreign.organization.id }, parent.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(specialistCatalogue(pool, { ...scope, accountId: foreign.owner.id }, parent.id)).rejects.toMatchObject({ code: "ACCESS_DENIED" });
    await pool.query("UPDATE agents_platform.model_provider_connections SET state='revoked' WHERE id=$1", [model.connection.id]);
    const unavailable = await specialistCatalogue(pool, scope, parent.id);
    expect(unavailable.specialists).toHaveLength(2);
    expect(unavailable.specialists.every(item => !item.ready && item.reasons.length > 0)).toBe(true);
  });

  it("previews the same narrowed recursive specialist scope used at admission",async()=>{
    const {owner,organization}=await fixture(),scope={accountId:owner.id,organizationId:organization.id};
    await connectFixtureModel(pool,owner.id,organization.id);
    const source=await publishFixtureSource(pool,{...scope,title:"Commissioned research",content:"Exact private research fact",visibility:"private"});
    const leaf=await store.createAgent({...scope,name:"Leaf",configuration:defaultBusinessConfiguration()});
    const leafVersion=await store.createVersion({...scope,agentId:leaf.id,expectedRevision:1});
    const child=await store.createAgent({...scope,name:"Research coordinator",configuration:agentConfigurationSchema.parse({
      ...defaultBusinessConfiguration(),program:{id:"tool-directed",version:"4"},memory:{enabled:true},sourceRevisionIds:[source.id],
      tools:["knowledge.read","agents.delegate","agents.start","agents.discover","memory.search","memory.read"],capabilities:{...defaultBusinessConfiguration().capabilities,
        delegation:{enabled:true,maxChildren:2,maxDepth:null,bindings:[{id:"leaf",versionId:leafVersion.id,tools:[],sourceRevisionIds:[],connectedToolBindingIds:[],maxTokens:null,maxActiveMs:null}]}}
    })});
    const childVersion=await store.createVersion({...scope,agentId:child.id,expectedRevision:1});
    const parent=(await assistants.getOrganizationAssistant(owner.id,organization.id)).agent!;
    expect(parent.draft.sourceRevisionIds).toEqual([]);
    expect((await specialistCatalogue(pool,scope,parent.id)).specialists.find(row=>row.versionId===childVersion.id)).toMatchObject({ready:true,sourceRevisionIds:[source.id]});
    const configuration=agentConfigurationSchema.parse({...parent.draft,program:{id:"tool-directed",version:"4"},tools:["agents.delegate","agents.start","agents.discover"],
      capabilities:{...parent.draft.capabilities,delegation:{enabled:true,maxChildren:2,maxDepth:null,bindings:[{id:"research",versionId:childVersion.id,
        tools:["knowledge.read","agents.start","agents.discover"],sourceRevisionIds:[source.id],connectedToolBindingIds:[],maxTokens:null,maxActiveMs:null}]}}});
    const saved=await store.updateDraft({...scope,agentId:parent.id,expectedRevision:parent.draft_revision,configuration});
    await store.createVersion({...scope,agentId:parent.id,expectedRevision:saved.draft_revision});
    const recursive=(await specialistCatalogue(pool,scope,parent.id)).specialists.find(row=>row.versionId===childVersion.id)!;
    expect(recursive).toMatchObject({ready:true,reasons:[],tools:expect.arrayContaining(["agents.start","agents.discover"])});
    expect(recursive.tools.some(name=>name.startsWith("memory."))).toBe(false);
    await store.updateDraft({...scope,agentId:parent.id,expectedRevision:saved.draft_revision,configuration:{...configuration,capabilities:{...configuration.capabilities,
      delegation:{...configuration.capabilities.delegation,maxDepth:1}}}});
    const finite=(await specialistCatalogue(pool,scope,parent.id)).specialists.find(row=>row.versionId===childVersion.id)!;
    expect(finite).toMatchObject({ready:true,reasons:[]});expect(finite.tools).not.toContain("agents.start");
  });
});
