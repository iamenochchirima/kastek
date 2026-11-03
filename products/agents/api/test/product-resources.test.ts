import { randomBytes, randomUUID } from "node:crypto";
import { generateKeyPair, exportPKCS8 } from "jose";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseGrowthAgentCommand, type GrowthAgentCommand, type GrowthAgentCommandInputs, type GrowthAgentCommandOperation, type GrowthAgentResourceInventory, type GrowthAgentPublication } from "@kasitek-labs/contracts";
import { setupPlatformSchema } from "../src/composition/setup";
import { GrowthExecutionService } from "../src/product/integrations/growth-execution";
import { GrowthProductRuntime } from "../src/execution/products/growth-runtime";
import { growthInstalledAdapterManifest } from "../src/adapters/products/growth-capability-manifests";
import { GrowthActionClient } from "../src/adapters/products/growth-action-client";
import { provisionGrowthModel } from "../src/product/integrations/growth-model-provisioning";
import { ConnectionVault } from "../src/infrastructure/vault";
import { ModelCredentialVault } from "../src/infrastructure/model-credential-vault";
import { requestDigest } from "../src/contracts/contracts";
import { createDependencyManifest } from "../src/contracts/source-contracts";
import { assertProductInformationForModel, selectedProductContextText } from "../src/execution/products/product-information";
import { EvidenceStore, assertCurrentEvidence, taskEvidenceManifest } from "../src/execution/context/evidence";
import { KnowledgeRuntime } from "../src/capabilities/knowledge/knowledge-runtime";
import { executeSkillTool } from "../src/capabilities/skills/runtime";
import { loadExecution, beginOperation, finishOperation, settleTask } from "../src/execution/lifecycle/execution";
import { assertProductNativeTaskAccess } from "../src/capabilities/products/resource-scope";
import { compilePublishedComposition } from "../src/execution/programs/publication";
import { publishedToolBindings } from "../src/capabilities/tool-definitions";
import { SHARED_HARNESS_RELEASE } from "../src/contracts/execution";
import { startSpecialist } from "../src/execution/delegation/adaptive";
import { executeMemoryTool } from "../src/capabilities/memory-tools";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("native product-owned knowledge and skills", () => {
  const database = `agents_product_resources_${randomUUID().replaceAll("-", "")}`, issuer = "https://growth.resources.fixture.test";
  let admin: Pool, pool: Pool, service: GrowthExecutionService, runtime:GrowthProductRuntime;
  const actor = { issuer: issuer + "/identity", subject: randomUUID() };
  let selectedContextRevision="a".repeat(64),selectedContextData:unknown={title:"A selected post",content:"A real selected post."};
  const vault = new ModelCredentialVault(new ConnectionVault("fixture", { fixture: randomBytes(32).toString("base64") }));
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${database}`; pool = new Pool({ connectionString: url.href }); await setupPlatformSchema(pool);
    const keys = await generateKeyPair("RS256", { extractable: true });
    runtime = new GrowthProductRuntime(pool, new GrowthActionClient({ origin: "https://growth.resources.fixture.test", issuer: "https://agents.resources.fixture.test", keyId: "fixture", privateKey: await exportPKCS8(keys.privateKey),
      fetch: (async (_url, request) => { const action = JSON.parse(String(request?.body)); return Response.json(action.operation === "context.read" ? { context: action.context, revision: selectedContextRevision, data: selectedContextData, sources: [] } : { authorized: true }); }) as typeof fetch }));
    service = new GrowthExecutionService(pool, { issuer, actorIssuer: actor.issuer, keys: {} }, runtime);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); } });
  function publication(revision = "9"): GrowthAgentPublication {
    const manifest = { schemaVersion: 1 as const, product: "growth", revision,
      adapter: { id: growthInstalledAdapterManifest.id, release: growthInstalledAdapterManifest.release, manifestDigest: requestDigest(growthInstalledAdapterManifest) },
      operations: [{ operation: "workspace.read", revision: "1", description: "Read permitted business information", inputSchema: { type: "object", properties: {}, additionalProperties: false }, outputSchema: null,
        handlerRef: "growth.workspace.read@1", requiredAuthority: ["feature.agents.manage"], evidence: "versioned_sources" as const,
        policy: { effect: "read" as const, disclosure: "approved_resource_identifiers" as const, retry: "safe_read" as const, approval: "none" as const, cancel: "stop_admission" as const }, limits: { timeoutMs: 10000, maxPhysicalAttempts: 1, maxResponseBytes: 131072, maxModelResultBytes: 8192 } }] };
    return { manifest: { ...manifest, digest: requestDigest(manifest) }, presets: (["assistant", "research", "content", "campaigns"] as const).map(id => ({ id, name: id, description: "Resource fixture", instructions: "Use permitted business sources and skills.", operations: ["workspace.read"] })),
      policy: { revision, optionalCapabilities: { knowledge: true, skills: true, memory: true, delegation: true, sandbox: false, workflows: false, connections: false } } };
  }
  async function fixture() {
    const tenantId = randomUUID(); await service.ensureTenant({ tenantId, publication: publication(), defaultsRevision: "9", upgradeDefaults: true });
    await provisionGrowthModel(pool, vault, { tenantId, providerId: "openrouter", modelId: "fixture/resources", apiKey: "fixture-only-key" }, { discoveryFetch: async () => ({ status: 200, body: JSON.stringify({ data: [{ id: "fixture/resources", name: "Fixture model", context_length: 262144, top_provider: { max_completion_tokens: 32768 }, supported_parameters: ["tools", "max_tokens"], architecture: { input_modalities: ["text"], output_modalities: ["text"] }, pricing: { prompt: "0", completion: "0" } }] }) }) });
    function command<K extends GrowthAgentCommandOperation>(operation: K, input: GrowthAgentCommandInputs[K], requestId = randomUUID()) {
      return parseGrowthAgentCommand({ version: "1", requestId, tenantId, actor, operation, input });
    }
    const inventory = (featureId: "research" | "content" = "research") => service.execute(command("resources.list", { featureId })) as Promise<GrowthAgentResourceInventory>;
    return { tenantId, command, inventory };
  }
  async function candidate(f: Awaited<ReturnType<typeof fixture>>) {
    const sourceCommand = f.command("sources.import", { featureId: "research", title: "Business facts", text: "Wheelhouse repairs bicycles in Pretoria. The call-out fee is R150. No launch discount is offered." });
    const first = await service.execute(sourceCommand) as GrowthAgentResourceInventory;
    expect((await service.execute(sourceCommand) as GrowthAgentResourceInventory).sources).toEqual(first.sources);
    const imported = await service.execute(f.command("skills.import", { featureId: "research", package: { source: "files", files: [{ path: "SKILL.md", content: "---\nname: fact-checking\ndescription: Check business facts before drafting offers.\n---\nRead the selected business knowledge. Keep supplied prices and explicitly flag unknown claims." }] } })) as GrowthAgentResourceInventory;
    return { source: imported.sources[0]!, skill: imported.skills[0]! };
  }
  it("reports configured and disabled specialists without blocking the assistant",async()=>{
    const f=await fixture();
    const read=async()=>(await service.execute(f.command("features.list",{})) as {features:Array<{id:string;ready:boolean;revision:number;memory:{enabled:boolean};specialists?:Array<{id:string;state:string;memory:{enabled:boolean;availableToAssistant:boolean}}>}>}).features;
    const before=(await read()).find(feature=>feature.id==="assistant")!;
    expect(before.ready).toBe(true);expect(before.specialists).toHaveLength(3);
    expect(before.specialists).toContainEqual(expect.objectContaining({id:"research",state:"configured"}));
    expect(before.specialists).toContainEqual(expect.objectContaining({id:"research",memory:{enabled:false,availableToAssistant:false}}));
    await pool.query("UPDATE agents_platform.product_execution_features SET enabled=false WHERE product='growth' AND tenant_id=$1 AND feature_id='research'",[f.tenantId]);
    const after=await read(),assistant=after.find(feature=>feature.id==="assistant")!;
    expect(assistant.ready).toBe(true);
    expect(assistant.specialists).toContainEqual(expect.objectContaining({id:"research",state:"disabled"}));
    expect(after.find(feature=>feature.id==="research")!.ready).toBe(false);
    await pool.query(`UPDATE agents_platform.agents SET deleted_at=now() WHERE id=(SELECT agent_id FROM agents_platform.product_execution_features
      WHERE product='growth' AND tenant_id=$1 AND feature_id='campaigns')`,[f.tenantId]);
    const removed=await read();
    expect(removed.find(feature=>feature.id==="assistant")!.specialists).toContainEqual(expect.objectContaining({id:"campaigns",state:"unavailable"}));
    expect(removed.find(feature=>feature.id==="campaigns")!.ready).toBe(false);
    await expect(service.execute(f.command("conversations.create",{featureId:"campaigns",context:null}))).rejects.toMatchObject({code:"FEATURE_DISABLED"});
  },30000);
  it("reports specialist memory only when both the specialist and assistant can use it",async()=>{
    const f=await fixture(),read=async()=>(await service.execute(f.command("features.list",{})) as {features:Array<{id:string;revision:number;memory:{enabled:boolean};specialists?:Array<{id:string;memory:{enabled:boolean;availableToAssistant:boolean}}>}>}).features;
    let features=await read(),assistant=features.find(feature=>feature.id==="assistant")!,research=features.find(feature=>feature.id==="research")!;
    await service.execute(f.command("memory.configure",{featureId:"research",expectedRevision:research.revision,enabled:true}));
    assistant=(await read()).find(feature=>feature.id==="assistant")!;
    expect(assistant.specialists).toContainEqual(expect.objectContaining({id:"research",memory:{enabled:true,availableToAssistant:false}}));
    await service.execute(f.command("memory.configure",{featureId:"assistant",expectedRevision:assistant.revision,enabled:true}));
    assistant=(await read()).find(feature=>feature.id==="assistant")!;
    expect(assistant.memory.enabled).toBe(true);
    expect(assistant.specialists).toContainEqual(expect.objectContaining({id:"research",memory:{enabled:true,availableToAssistant:true}}));
    await service.execute(f.command("memory.configure",{featureId:"assistant",expectedRevision:assistant.revision,enabled:false}));
    assistant=(await read()).find(feature=>feature.id==="assistant")!;
    expect(assistant.specialists).toContainEqual(expect.objectContaining({id:"research",memory:{enabled:true,availableToAssistant:false}}));
  },30000);
  it("reports revoked or missing model credentials without calling the provider",async()=>{
    const f=await fixture();
    const read=async()=>(await service.execute(f.command("features.list",{})) as {features:Array<{id:string;ready:boolean;reasons:Array<{code:string;message:string}>}>}).features;
    const before=await read();
    expect(before.map(feature=>feature.id).sort()).toEqual(["assistant","campaigns","content","research"]);
    expect(before.every(feature=>feature.ready)).toBe(true);
    const saved=(await pool.query(`SELECT c.* FROM agents_platform.model_provider_credentials c
      JOIN agents_platform.product_model_defaults d ON d.organization_id=c.organization_id AND d.connection_id=c.connection_id
      WHERE d.product='growth' AND d.organization_id=(SELECT organization_id FROM agents_platform.product_execution_tenants WHERE product='growth' AND tenant_id=$1)
      AND c.state='active'`,[f.tenantId])).rows[0];
    expect(saved).toBeDefined();
    await pool.query("UPDATE agents_platform.model_provider_credentials SET state='revoked',envelope=NULL WHERE organization_id=$1 AND connection_id=$2 AND revision=$3",[saved.organization_id,saved.connection_id,saved.revision]);
    expect((await read()).every(feature=>!feature.ready&&feature.reasons.some(reason=>reason.code==="MODEL_CREDENTIAL_REVOKED"&&reason.message==="Model credentials revoked"))).toBe(true);
    await pool.query("UPDATE agents_platform.model_provider_credentials SET state='active',envelope=$4 WHERE organization_id=$1 AND connection_id=$2 AND revision=$3",[saved.organization_id,saved.connection_id,saved.revision,saved.envelope]);
    expect((await read()).every(feature=>feature.ready)).toBe(true);
    await pool.query("DELETE FROM agents_platform.model_provider_credentials WHERE organization_id=$1 AND connection_id=$2 AND revision=$3",[saved.organization_id,saved.connection_id,saved.revision]);
    expect((await read()).every(feature=>!feature.ready&&feature.reasons.some(reason=>reason.code==="MODEL_CREDENTIAL_UNAVAILABLE"&&reason.message==="Model credentials unavailable"))).toBe(true);
  },30000);
  it("distinguishes unavailable knowledge from a disabled selected skill",async()=>{
    const f=await fixture(),{source,skill}=await candidate(f),revisionId=source.revisions[0]!.id;
    await service.execute(f.command("sources.review",{featureId:"research",sourceId:source.id,revisionId,expectedGeneration:source.generation}));
    await service.execute(f.command("skills.review",{featureId:"research",skillId:skill.id,contentDigest:skill.contentDigest}));
    await service.execute(f.command("resources.select",{featureId:"research",expectedRevision:1,sourceRevisionIds:[revisionId],skillIds:[skill.id]}));
    const selected=await f.inventory(),installed=selected.skills.find(item=>item.id===skill.id)!;
    await service.execute(f.command("skills.state",{featureId:"research",skillId:skill.id,expectedGeneration:installed.generation,state:"disabled"}));
    const read=async()=>(await service.execute(f.command("features.list",{})) as {features:Array<{id:string;ready:boolean;reasons:Array<{code:string;message:string}>}>}).features.find(feature=>feature.id==="research")!;
    expect(await read()).toMatchObject({ready:false,reasons:[{code:"SKILL_DISABLED",message:"Skill disabled"}]});
    const current=(await f.inventory()).sources.find(item=>item.id===source.id)!;
    await service.execute(f.command("sources.state",{featureId:"research",sourceId:source.id,expectedGeneration:current.generation,state:"withdrawn"}));
    expect(await read()).toMatchObject({ready:false,reasons:[{code:"SOURCE_SCOPE_DENIED",message:"Knowledge unavailable"}]});
    const saved=await f.inventory();expect(saved.sourceRevisionIds).toEqual([revisionId]);expect(saved.skillIds).toEqual([skill.id]);
  },30000);
  it("imports, explicitly reviews, selects and uses native resources without creating standalone accounts", async () => {
    const f = await fixture(), { source, skill } = await candidate(f), revisionId = source.revisions[0]!.id;
    expect(skill.reviewState).toBe("pending"); expect(source.revisions[0]!.state).toBe("candidate");
    await expect(service.execute(f.command("resources.select", { featureId: "research", expectedRevision: 1, sourceRevisionIds: [revisionId], skillIds: [skill.id] }))).rejects.toMatchObject({ code: "SOURCE_SCOPE_DENIED" });
    await service.execute(f.command("sources.review", { featureId: "research", sourceId: source.id, revisionId, expectedGeneration: source.generation }));
    await expect(service.execute(f.command("skills.review", { featureId: "research", skillId: skill.id, contentDigest: "0".repeat(64) }))).rejects.toBeDefined();
    await service.execute(f.command("skills.review", { featureId: "research", skillId: skill.id, contentDigest: skill.contentDigest }));
    const selection = f.command("resources.select", { featureId: "research", expectedRevision: 1, sourceRevisionIds: [revisionId], skillIds: [skill.id] });
    const selected = await service.execute(selection) as GrowthAgentResourceInventory;
    expect(selected).toMatchObject({ revision: 2, sourceRevisionIds: [revisionId], skillIds: [skill.id] });
    expect(await service.execute(selection)).toEqual(selected);
    await pool.query("UPDATE agents_platform.product_execution_features SET managed_defaults_revision='8' WHERE product='growth' AND tenant_id=$1 AND feature_id='research'", [f.tenantId]);
    await service.ensureTenant({ tenantId: f.tenantId, publication: publication(), defaultsRevision: "9", upgradeDefaults: true });
    expect(await f.inventory()).toMatchObject({ sourceRevisionIds: [revisionId], skillIds: [skill.id] });
    const parent = await service.feature(pool, f.command("features.list", {}), "assistant");
    const specialist = await service.feature(pool, f.command("features.list", {}), "research");
    expect(parent.configuration.capabilities.delegation.bindings.find((binding: { id: string }) => binding.id === "research")).toMatchObject({ versionId: specialist.version_id, sourceRevisionIds: [revisionId], tools: ["artifact.create", "knowledge.search", "knowledge.read"], maxTokens: null, maxActiveMs: null });
    expect(parent.configuration.capabilities.delegation).toMatchObject({ maxDepth: null, policy: { maxTasks: null } });
    expect((await pool.query("SELECT revision_id FROM agents_platform.version_sources WHERE version_id=$1", [parent.version_id])).rows.map(row => row.revision_id)).toContain(revisionId);
    expect(parent.configuration.sourceRevisionIds).toEqual([]);
    const created = await service.execute(f.command("conversations.create", { featureId: "research", context: null })) as { conversation: { id: string } };
    const submitted = await service.execute(f.command("turns.submit", { conversationId: created.conversation.id, text: "What is the call-out fee?" })) as { task: { id: string } };
    const evidence = new EvidenceStore(pool), knowledge = new KnowledgeRuntime(pool, evidence);
    await beginOperation(pool, submitted.task.id, { id: "knowledge:fixture", kind: "tool", name: "knowledge.search", request: { query: "call-out fee" }, reservedTokens: 0, reservedMs: 30000 });
    const found = await knowledge.search(submitted.task.id, "knowledge:fixture", "call-out fee");
    expect(found.passages.map(passage => passage.text).join(" ")).toContain("R150");
    await finishOperation(pool, submitted.task.id, "knowledge:fixture", "completed", found, null, 0);
    const payload = { messages: [{ role: "user", content: JSON.stringify(found) }] }, snapshot = `context:${submitted.task.id}:0`;
    await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,0,$3,$4,0)", [snapshot, submitted.task.id, requestDigest(payload), payload]);
    await evidence.supplyContext(submitted.task.id, snapshot, found.passages.map(passage => passage.evidenceId));
    expect((await executeSkillTool(pool, submitted.task.id, "skills.activate", { skillId: skill.id })).content).toContain("Keep supplied prices");
    const manifest = await taskEvidenceManifest(pool, submitted.task.id);
    await service.execute(f.command("sources.state", { featureId: "research", sourceId: source.id, expectedGeneration: (await f.inventory()).sources[0]!.generation, state: "withdrawn" }));
    await expect(assertCurrentEvidence(pool, submitted.task.id, manifest)).rejects.toBeDefined();
    expect(Number((await pool.query("SELECT count(*) FROM agents_platform.accounts")).rows[0].count)).toBe(0);
    expect((await pool.query("SELECT importer_account_id,importer_service FROM agents_platform.sources WHERE id=$1", [source.id])).rows[0]).toMatchObject({ importer_account_id: null, importer_service: { product: "growth", tenantId: f.tenantId, agentId: specialist.agent_id, actor } });
  }, 30000);
  it("rejects foreign-feature resource handles and fences accepted work after a selected skill is removed", async () => {
    const f = await fixture(), { source, skill } = await candidate(f);
    await expect(service.execute(f.command("resources.preview", { featureId: "content", kind: "skill", skillId: skill.id }))).rejects.toBeDefined();
    await expect(service.execute(f.command("sources.review", { featureId: "content", sourceId: source.id, revisionId: source.revisions[0]!.id, expectedGeneration: source.generation }))).rejects.toBeDefined();
    await service.execute(f.command("skills.review", { featureId: "research", skillId: skill.id, contentDigest: skill.contentDigest }));
    await service.execute(f.command("resources.select", { featureId: "research", expectedRevision: 1, sourceRevisionIds: [], skillIds: [skill.id] }));
    const created = await service.execute(f.command("conversations.create", { featureId: "research", context: null })) as { conversation: { id: string } };
    const submitted = await service.execute(f.command("turns.submit", { conversationId: created.conversation.id, text: "Check our business facts" })) as { task: { id: string } };
    const accepted = await loadExecution(pool, submitted.task.id); await expect(assertProductNativeTaskAccess(pool, accepted)).resolves.toBeUndefined();
    await service.execute(f.command("resources.select", { featureId: "research", expectedRevision: 2, sourceRevisionIds: [], skillIds: [] }));
    await expect(assertProductNativeTaskAccess(pool, accepted)).rejects.toMatchObject({ code: "PRODUCT_RESOURCE_REVOKED" });
    await expect(executeSkillTool(pool, submitted.task.id, "skills.activate", { skillId: skill.id })).rejects.toMatchObject({ code: "PRODUCT_RESOURCE_REVOKED" });
  }, 30000);
  it("publishes an equivalent current-runtime version for custom defaults while preserving disablement, draft and source pins", async () => {
    const f = await fixture(), { source, skill } = await candidate(f), revisionId = source.revisions[0]!.id;
    await service.execute(f.command("sources.review", { featureId: "research", sourceId: source.id, revisionId, expectedGeneration: source.generation }));
    await service.execute(f.command("skills.review", { featureId: "research", skillId: skill.id, contentDigest: skill.contentDigest }));
    await service.execute(f.command("resources.select", { featureId: "research", expectedRevision: 1, sourceRevisionIds: [revisionId], skillIds: [skill.id] }));
    const prior = await service.feature(pool, f.command("features.list", {}), "research"), configuration = structuredClone(prior.configuration);
    configuration.instructions = "Keep this custom research purpose.";
    const oldVersion = randomUUID(), number = prior.revision + 1, composition = compilePublishedComposition(configuration, [], { release: "product-capabilities-v14", workflow: "AgentsBusinessRunV24" });
    await pool.query(`INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,draft_revision,execution_kind,configuration,created_by_service,tool_bindings,effective_composition)
      VALUES($1,$2,$3,$4,$4,'business',$5,$6,$7,$8)`, [oldVersion, prior.organization_id, prior.agent_id, number, configuration, { product: "growth", issuer, clientId: "growth-control" }, JSON.stringify(publishedToolBindings(configuration)), composition]);
    await pool.query("INSERT INTO agents_platform.version_sources(organization_id,version_id,source_id,revision_id) SELECT organization_id,$2,source_id,revision_id FROM agents_platform.version_sources WHERE version_id=$1", [prior.version_id, oldVersion]);
    const draft = { ...configuration, instructions: "An unpublished custom edit." };
    await pool.query("UPDATE agents_platform.agents SET draft=$2,draft_revision=$3 WHERE id=$1", [prior.agent_id, draft, number + 1]);
    await pool.query("UPDATE agents_platform.product_execution_features SET version_id=$2,revision=$3,enabled=false WHERE product='growth' AND tenant_id=$1 AND feature_id='research'", [f.tenantId, oldVersion, number]);
    await service.ensureTenant({ tenantId: f.tenantId, publication: publication(), defaultsRevision: "9", upgradeDefaults: true });
    const repaired = await service.feature(pool, f.command("features.list", {}), "research");
    expect(repaired.configuration).toEqual(configuration); expect(repaired.enabled).toBe(false); expect(repaired.version_id).not.toBe(oldVersion);
    expect((await pool.query("SELECT effective_composition FROM agents_platform.agent_versions WHERE id=$1", [repaired.version_id])).rows[0].effective_composition.runtime.release).toBe(SHARED_HARNESS_RELEASE);
    expect((await pool.query("SELECT effective_composition FROM agents_platform.agent_versions WHERE id=$1", [oldVersion])).rows[0].effective_composition).toEqual(composition);
    expect((await pool.query("SELECT draft,draft_revision FROM agents_platform.agents WHERE id=$1", [prior.agent_id])).rows[0]).toEqual({ draft, draft_revision: number + 1 });
    expect((await pool.query("SELECT revision_id FROM agents_platform.version_sources WHERE version_id=$1", [repaired.version_id])).rows.map(row => row.revision_id)).toEqual([revisionId]);
    await service.execute(f.command("memory.configure", { featureId: "research", expectedRevision: repaired.revision, enabled: true }));
    expect((await pool.query("SELECT draft,draft_revision FROM agents_platform.agents WHERE id=$1", [prior.agent_id])).rows[0]).toEqual({ draft, draft_revision: number + 1 });
  }, 30000);
  it("upgrades the specialist handoff contract without changing customized Growth settings", async () => {
    const f=await fixture(),prior=await service.feature(pool,f.command("features.list",{}),"assistant");
    const configuration=structuredClone(prior.configuration);configuration.instructions="Keep this custom assistant purpose.";
    const oldVersion=randomUUID(),number=prior.revision+1,bindings=publishedToolBindings(configuration,false,new Map([["agents.start","1"],["agents.followup","1"]]));
    const composition=compilePublishedComposition(configuration,[],undefined,bindings);
    await pool.query(`INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,draft_revision,execution_kind,configuration,created_by_service,tool_bindings,effective_composition)
      VALUES($1,$2,$3,$4,$4,'business',$5,$6,$7,$8)`,[oldVersion,prior.organization_id,prior.agent_id,number,configuration,{product:"growth",issuer,clientId:"growth-control"},JSON.stringify(bindings),composition]);
    const draft={...configuration,instructions:"An unpublished assistant edit."};
    await pool.query("UPDATE agents_platform.agents SET draft=$2,draft_revision=$3 WHERE id=$1",[prior.agent_id,draft,number+1]);
    await pool.query("UPDATE agents_platform.product_execution_features SET version_id=$2,revision=$3,enabled=false WHERE product='growth' AND tenant_id=$1 AND feature_id='assistant'",[f.tenantId,oldVersion,number]);
    await service.ensureTenant({tenantId:f.tenantId,publication:publication(),upgradeRuntime:true});
    const repaired=await service.feature(pool,f.command("features.list",{}),"assistant");
    expect(repaired.configuration).toEqual(configuration);expect(repaired.enabled).toBe(false);expect(repaired.version_id).not.toBe(oldVersion);
    const current=(await pool.query("SELECT tool_bindings FROM agents_platform.agent_versions WHERE id=$1",[repaired.version_id])).rows[0];
    expect(current.tool_bindings).toContainEqual(expect.objectContaining({name:"agents.start",version:"4"}));
    expect(current.tool_bindings).toContainEqual(expect.objectContaining({name:"agents.followup",version:"4"}));
    expect((await pool.query("SELECT draft,draft_revision FROM agents_platform.agents WHERE id=$1",[prior.agent_id])).rows[0]).toEqual({draft,draft_revision:number+1});
    await service.ensureTenant({tenantId:f.tenantId,publication:publication(),upgradeRuntime:true});
    expect((await service.feature(pool,f.command("features.list",{}),"assistant")).version_id).toBe(repaired.version_id);
  },30000);
  it("passes selected Growth conversation material to an authorized specialist", async () => {
    const f=await fixture(),created=await service.execute(f.command("conversations.create",{featureId:"assistant",context:null})) as {conversation:{id:string}};
    const prior=await service.execute(f.command("turns.submit",{conversationId:created.conversation.id,text:"Make a plan."})) as {task:{id:string}};
    await pool.query("UPDATE agents_platform.tasks SET state='running' WHERE id=$1",[prior.task.id]);
    await settleTask(pool,prior.task.id,{state:"completed",output:"The original launch plan."});
    const current=await service.execute(f.command("turns.submit",{conversationId:created.conversation.id,text:"Please review it."})) as {task:{id:string}};
    const operation={id:"growth:history-handoff",kind:"delegation" as const,name:"agents.start",request:{},reservedTokens:0,reservedMs:1000};
    await beginOperation(pool,current.task.id,operation);
    const evidence=new EvidenceStore(pool),child=(await startSpecialist(pool,current.task.id,operation.id,{requests:[{bindingId:"research",brief:"Review the plan",historyReferences:[{taskId:prior.task.id,part:"output"}]}]},evidence)).children[0]!;
    expect((await loadExecution(pool,child.taskId)).task.input).toContain("The original launch plan.");
    await assertCurrentEvidence(pool,child.taskId,await taskEvidenceManifest(pool,child.taskId),{requireActiveTask:false});
    expect(Number((await pool.query("SELECT count(*) FROM agents_platform.accounts")).rows[0].count)).toBe(0);
  },30000);
  it("keeps the selected reference out of a child brief and enforces its inherited provider audience", async () => {
    const f=await fixture(),selection={kind:"content_post" as const,resourceId:"selected-record"};
    const created=await service.execute(f.command("conversations.create",{featureId:"assistant",context:selection})) as {conversation:{id:string}};
    const current=await service.execute(f.command("turns.submit",{conversationId:created.conversation.id,text:"Can you check this?"})) as {task:{id:string}};
    const selected=await runtime.selectedContextReference(current.task.id),evidence=new EvidenceStore(pool),snapshot=`context:${current.task.id}:0`;
    expect(selected?.reference).toMatchObject({...selection,revision:selectedContextRevision,data:selectedContextData});
    const payload={selectedProductContext:selected,messages:[{role:"user",content:`Can you check this?\n\n${selectedProductContextText(selected?.reference)}`}]};
    await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,0,$3,$4,0)",[snapshot,current.task.id,requestDigest(payload),payload]);
    await evidence.supplyContext(current.task.id,snapshot,[]);
    const operation={id:"growth:context-child",kind:"delegation" as const,name:"agents.start",request:{},reservedTokens:0,reservedMs:1000};
    await beginOperation(pool,current.task.id,operation);
    const child=(await startSpecialist(pool,current.task.id,operation.id,{requests:[{bindingId:"research",brief:"Check the reasoning."}]},evidence)).children[0]!;
    expect((await loadExecution(pool,child.taskId)).task.input).not.toContain("selected-record");
    const manifest=await taskEvidenceManifest(pool,child.taskId);
    await expect(assertProductInformationForModel(pool,child.taskId,manifest,"primary")).resolves.toBeUndefined();
    const row=(await pool.query("SELECT input_manifest FROM agents_platform.delegations WHERE child_task_id=$1",[child.taskId])).rows[0];
    const changed=structuredClone(row.input_manifest),dependency=changed.dependencies.find((item:any)=>item.kind==="product_context");
    expect(dependency).toBeDefined();
    const provider=dependency.information.providers[0],{destinationDigest:_digest,bindingDigest:_binding,...destination}=provider;
    destination.endpoint="https://other-provider.invalid/";provider.endpoint=destination.endpoint;provider.destinationDigest=requestDigest(destination);
    dependency.information.providers=[provider];
    const narrowed=createDependencyManifest(changed.dependencies);
    const inherited=createDependencyManifest([{kind:"delegation_input",referenceId:child.taskId,manifestDigest:narrowed.digest}]);
    const simulatedDb={query:async(sql:string,values?:unknown[])=>sql.startsWith("SELECT input_manifest FROM agents_platform.delegations")?
      {rows:[{input_manifest:narrowed}]}:pool.query(sql,values)} as unknown as Pool;
    await expect(assertProductInformationForModel(simulatedDb,child.taskId,inherited,"primary")).rejects.toMatchObject({code:"PRODUCT_INFORMATION_DENIED"});
    selectedContextData={title:"A selected post",content:"Changed after admission."};selectedContextRevision="b".repeat(64);
    await expect(assertCurrentEvidence(pool,child.taskId,manifest,{requireActiveTask:false})).rejects.toBeDefined();
    selectedContextData={title:"A selected post",content:"A real selected post."};selectedContextRevision="a".repeat(64);
  },30000);
  it("recalls explicitly accepted specialist memory in a new conversation without transferring the old brief", async () => {
    const f = await fixture();
    const assistant = await service.feature(pool, f.command("features.list", {}), "assistant");
    await service.execute(f.command("memory.configure", { featureId: "assistant", expectedRevision: assistant.revision, enabled: true }));
    await service.execute(f.command("memory.configure", { featureId: "research", expectedRevision: 1, enabled: true }));
    const created = await service.execute(f.command("conversations.create", { featureId: "assistant", context: null })) as { conversation: { id: string } };
    const submitted = await service.execute(f.command("turns.submit", { conversationId: created.conversation.id, text: "Help me plan the launch." })) as { task: { id: string } };
    const child = (await startSpecialist(pool, submitted.task.id, "memory:child", { requests: [{ bindingId: "research", brief: "OLD_PRIVATE_BRIEF: Check the supplied launch facts." }] })).children[0]!;
    const evidence = new EvidenceStore(pool), childPayload = { messages: [{ role: "user", content: "OLD_PRIVATE_BRIEF: Check the supplied launch facts." }] }, childSnapshot = `context:${child.taskId}:0`;
    await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,0,$3,$4,0)", [childSnapshot, child.taskId, requestDigest(childPayload), childPayload]);
    await evidence.supplyContext(child.taskId, childSnapshot, []);
    await beginOperation(pool, child.taskId, { id: "memory:proposal", kind: "tool", name: "memory.propose", request: { content: "Prefer concise launch briefs." }, reservedTokens: 0, reservedMs: 30000 });
    const candidate = await executeMemoryTool(pool, child.taskId, "memory:proposal", "memory.propose", { kind: "semantic", content: "Prefer concise launch briefs." }) as { candidateId: string };
    await finishOperation(pool, child.taskId, "memory:proposal", "completed", candidate, null, 0);
    await evidence.derive(child.taskId, "memory", candidate.candidateId);
    await service.execute(f.command("memory.mutate", { featureId: "research", memoryId: candidate.candidateId, expectedRevision: 1, action: "accept" }));
    expect(await service.execute(f.command("memory.list", { featureId: "assistant" }))).toMatchObject({ memories: [], candidates: [] });
    const next = await service.execute(f.command("conversations.create", { featureId: "research", context: null })) as { conversation: { id: string } };
    const current = await service.execute(f.command("turns.submit", { conversationId: next.conversation.id, text: "How do I like my launch briefs?" })) as { task: { id: string } };
    await beginOperation(pool, current.task.id, { id: "memory:read", kind: "tool", name: "memory.read", request: { memoryId: candidate.candidateId }, reservedTokens: 0, reservedMs: 30000 });
    const read = await executeMemoryTool(pool, current.task.id, "memory:read", "memory.read", { memoryId: candidate.candidateId }, evidence) as { memory: { content: string; evidence: { evidenceId: string } } };
    expect(read.memory.content).toBe("Prefer concise launch briefs."); expect(JSON.stringify(read)).not.toContain("OLD_PRIVATE_BRIEF");
    const passage = (await pool.query("SELECT manifest FROM agents_platform.evidence_references WHERE id=$1", [read.memory.evidence.evidenceId])).rows[0];
    expect(passage.manifest.dependencies).toContainEqual(expect.objectContaining({ kind: "delegation_input", referenceId: child.taskId, memoryTransition: { memoryId: candidate.candidateId, memoryRevision: 2 } }));
    await expect(assertCurrentEvidence(pool, current.task.id, passage.manifest)).resolves.toBeUndefined();
    await service.execute(f.command("memory.mutate", { featureId: "research", memoryId: candidate.candidateId, expectedRevision: 2, action: "forget" }));
    await expect(assertCurrentEvidence(pool, current.task.id, passage.manifest)).rejects.toBeDefined();
  }, 30000);
});
