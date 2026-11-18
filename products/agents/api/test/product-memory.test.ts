import { skillPackageCodec } from "../src/capabilities/skills/package";
import { contextGrantCeiling } from "../src/execution/models/settings";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { PlatformStore } from "../src/product/agents/store";
import { MemoryStore, type ProductMemoryManagementScope } from "../src/execution/memory/memory";
import { executeMemoryTool } from "../src/capabilities/memory-tools";
import { EvidenceStore, assertCurrentEvidence, taskEvidenceManifest } from "../src/execution/context/evidence";
import { beginOperation, finishOperation, loadExecution, settleTask } from "../src/execution/lifecycle/execution";
import { defaultBusinessConfiguration, executionGrantSchema, requestDigest } from "../src/contracts/contracts";
import { connectFixtureModel } from "./model-fixture";
import { dropClosedTestDatabase } from "./support/database-cleanup";
import { registerProductAdapter, createProductBindings } from "../src/capabilities/products/product-capabilities";
import { ProductRuntime } from "../src/execution/products/product-runtime";
import { currentProductInformation, assertProductInformationForModel, selectedProductContextText } from "../src/execution/products/product-information";
import type { ProductCapabilityInvocation } from "@kasitek-labs/contracts";
import { createDependencyManifest } from "../src/contracts/source-contracts";

const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("explicit product actor memory namespaces", () => {
  let admin: Pool, pool: Pool, platform: PlatformStore, memory: MemoryStore;
  const database = `agents_product_memory_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${database}`;
    pool = new Pool({ connectionString: url.href }); await setupPlatformSchema(pool);
    platform = new PlatformStore(pool); memory = new MemoryStore(pool, skillPackageCodec);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); } });

  async function fixture(product: "growth" | "agencies" = "growth", withProductSource: boolean | "access" = false) {
    const account = await platform.ensureAccount({ issuer: "http://localhost/memory-fixture", subject: randomUUID(), email: "fixture@example.test", displayName: "Fixture operator" });
    const organization = await platform.createOrganization(account.id, "Namespace fixture");
    await connectFixtureModel(pool, account.id, organization.id);
    const tenantId = randomUUID(), featureId = "assistant", issuer = "http://localhost/product-service", client = `${product}-api`;
    const configuration = defaultBusinessConfiguration(); configuration.program = { id: "tool-directed", version: "3" }; configuration.memory = { enabled: true }; configuration.tools = ["memory.search", "memory.propose"];
    let sourceAllowed = true;
    const adapter = { schemaVersion: 1 as const, id: `memory-source-${randomUUID()}`, release: "1", executableDigest: "a".repeat(64), transports: ["native_http" as const], protocolVersions: [], boundedSchemaValidation: true as const };
    const executor = { handlers: ["facts.read@1"], ...(withProductSource==="access"?{accessReceiptHandlers:["facts.read@1"]}:{}),
      invoke: async (command:ProductCapabilityInvocation) => {
        if(withProductSource==="access"&&command.control==="invoke"){
          const value={finding:"A permitted business observation."};
          return {value,access:{version:"1" as const,reference:"receipt:one",scopeReference:"scope:one",resultDigest:requestDigest(value)}};
        }
        if(withProductSource==="access"&&command.control==="evidence")return {value:{authorized:sourceAllowed,scopeReference:(command.input as {source:{id:string}}).source.id}};
        return { value: { authorized: sourceAllowed, revision: "b".repeat(64) } };
      } };
    if (withProductSource) {
      const reference = registerProductAdapter(adapter, executor), content = { schemaVersion: 1 as const, product, revision: "1", adapter: reference, operations: [{
        operation: "facts.read", revision: "1", description: "Read a controlled authorized source", inputSchema: { type: "object", properties: {}, additionalProperties: false }, outputSchema: null,
        handlerRef: "facts.read@1", policy: { effect: "read" as const, disclosure: "approved_resource_identifiers" as const, retry: "safe_read" as const, approval: "none" as const, cancel: "stop_admission" as const },
        requiredAuthority: ["facts.read"], evidence: withProductSource==="access"?"none" as const:"versioned_sources" as const, limits: { timeoutMs: 30000, maxPhysicalAttempts: 1, maxResponseBytes: 32768, maxModelResultBytes: 8192 },
      }] };
      configuration.productBindings = createProductBindings({ ...content, digest: requestDigest(content) }, organization.id,
        { originProduct: product, originTenantId: tenantId, tenantId, mappingRef: `fixture:${tenantId}`, policyRevision: "1" }, ["facts.read"]);
    }
    const agent = await platform.createAgent({ accountId: account.id, organizationId: organization.id, name: "Helper", configuration });
    const management = { accountId: account.id, organizationId: organization.id, agentId: agent.id };
    const version = await platform.createVersion({ ...management, expectedRevision: 1 });
    await pool.query("INSERT INTO agents_platform.product_execution_tenants(product,tenant_id,organization_id,client_id,issuer) VALUES($1,$2,$3,$4,$5)", [product, tenantId, organization.id, client, issuer]);
    await pool.query("INSERT INTO agents_platform.product_execution_features(product,tenant_id,feature_id,organization_id,agent_id,version_id) VALUES($1,$2,$3,$4,$5,$6)", [product, tenantId, featureId, organization.id, agent.id, version.id]);
    const defaultModel = (await pool.query("SELECT * FROM agents_platform.model_provider_defaults WHERE organization_id=$1", [organization.id])).rows[0];
    const modelGrant = randomUUID();
    await pool.query(`INSERT INTO agents_platform.model_provider_use_grants(id,organization_id,connection_id,consumer,roles,model_ids)
      SELECT $1,organization_id,connection_id,$2,roles,model_ids FROM agents_platform.model_provider_use_grants WHERE id=$3`,
      [modelGrant, { kind: "service", serviceId: "product-default", product }, defaultModel.use_grant_id]);
    await pool.query("INSERT INTO agents_platform.product_model_defaults(product,organization_id,connection_id,model_id,use_grant_id) VALUES($1,$2,$3,$4,$5)", [product, organization.id, defaultModel.connection_id, defaultModel.model_id, modelGrant]);
    const actor = { issuer: "http://localhost/product-people", subject: randomUUID() };
    const scope: ProductMemoryManagementScope = { namespace: "product_actor", product, tenantId, organizationId: organization.id, agentId: agent.id, actor, clientId: product === "agencies" ? randomUUID() : null };
    async function task(selectedScope = scope) {
      const authority = { product, organizationId: organization.id, resourceId: featureId, callerClientId: client, principal: { kind: "human" as const, ...selectedScope.actor } };
      const grant = executionGrantSchema.parse({ ...authority, id: randomUUID(), versionId: version.id,
        operations: ["model.reply", "memory.read", "memory.propose", ...(withProductSource ? ["product.read"] : [])], maxInputBytes: configuration.model.maxInputBytes,
        maxOutputTokens: configuration.model.maxOutputTokens, maxContextTokens: contextGrantCeiling(configuration),
        expiresAt: new Date(Date.now() + 600000).toISOString(), revokedAt: null });
      await pool.query(`INSERT INTO agents_platform.execution_grants(id,product,organization_id,resource_id,caller_client_id,principal,version_id,operations,max_input_bytes,max_output_tokens,max_context_tokens,root_token_limit,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [grant.id, product, organization.id, featureId, client, grant.principal, version.id, JSON.stringify(grant.operations), grant.maxInputBytes, grant.maxOutputTokens, grant.maxContextTokens, grant.rootTokenLimit, grant.expiresAt]);
      await pool.query("INSERT INTO agents_platform.product_execution_authorities(grant_id,product,organization_id,client_id,issuer,assertion_digest) VALUES($1,$2,$3,$4,$5,$6)", [grant.id, product, organization.id, client, issuer, requestDigest(authority)]);
      const { task } = await platform.admitTask({ authority, versionId: version.id, grantId: grant.id, requestKey: randomUUID(), input: "Check my accepted preferences" });
      await pool.query("INSERT INTO agents_platform.product_conversations(conversation_id,product,tenant_id,feature_id,title,client_id) VALUES($1,$2,$3,$4,'Memory fixture',$5)", [task.conversation_id, product, tenantId, featureId, selectedScope.clientId]);
      await pool.query("INSERT INTO agents_platform.product_task_contexts(task_id,product,tenant_id,feature_id,conversation_id,command_digest,client_id) VALUES($1,$2,$3,$4,$5,$6,$7)", [task.id, product, tenantId, featureId, task.conversation_id, requestDigest(task.id), selectedScope.clientId]);
      return { task, runtimeScope: { organizationId: organization.id, agentId: agent.id, principal: authority.principal, taskId: task.id } };
    }
    return { account, organization, agent, configuration, management, version, scope, task, adapter, executor, revokeSource() { sourceAllowed = false; } };
  }
  async function accepted(scope: ProductMemoryManagementScope, content: string) {
    const candidate = await memory.proposeManaged(scope, { operationId: randomUUID(), kind: "semantic", content });
    return memory.mutate(scope, candidate.id, { operationId: randomUUID(), expectedRevision: 1, action: "accept" });
  }

  it("respects separate current read and proposal grants for task-scoped memory", async () => {
    const f = await fixture("agencies"), item = await accepted(f.scope, "Use concise briefings."), current = await f.task();
    await pool.query("UPDATE agents_platform.execution_grants SET operations=$2 WHERE id=$1", [current.task.grant_id, JSON.stringify(["model.reply", "memory.read"])]);
    expect((await memory.read(current.runtimeScope)).memories.map(row => row.id)).toContain(item.id);
    await expect(memory.propose(current.runtimeScope, { operationId: randomUUID(), kind: "semantic", content: "Unpermitted proposal." }))
      .rejects.toMatchObject({ code: "MEMORY_SCOPE_DENIED" });
    expect((await memory.list(f.scope)).candidates).toEqual([]);

    await pool.query("UPDATE agents_platform.execution_grants SET operations=$2 WHERE id=$1", [current.task.grant_id, JSON.stringify(["model.reply", "memory.propose"])]);
    await expect(memory.read(current.runtimeScope)).rejects.toMatchObject({ code: "MEMORY_SCOPE_DENIED" });
    const proposed = await memory.propose(current.runtimeScope, { operationId: randomUUID(), kind: "semantic",
      content: "Use an evening briefing.", sourceTaskId: current.task.id });
    expect(proposed.status).toBe("candidate");
    expect((await memory.list(f.scope)).candidates.map(row => row.id)).toContain(proposed.id);
  });

  it("isolates same-name actors and Agency clients without creating standalone accounts", async () => {
    const f = await fixture("agencies"), count = (await pool.query("SELECT count(*)::int AS n FROM agents_platform.accounts")).rows[0].n;
    const one = await accepted(f.scope, "Acme prefers concise briefs.");
    const otherActor = { ...f.scope, actor: { ...f.scope.actor, subject: randomUUID() } }, otherClient = { ...f.scope, clientId: randomUUID() };
    expect((await memory.list(otherActor)).memories).toEqual([]);
    expect((await memory.list(otherClient)).memories).toEqual([]);
    await expect(memory.mutate(otherClient, one.id, { operationId: randomUUID(), expectedRevision: 2, action: "forget" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(memory.list({ ...f.scope, clientId: null })).rejects.toMatchObject({ code: "MEMORY_SCOPE_DENIED" });
    const current = await f.task(); expect((await memory.read(current.runtimeScope)).memories.map(item => item.id)).toEqual([one.id]);
    await pool.query("UPDATE agents_platform.product_task_contexts SET client_id=NULL WHERE task_id=$1", [current.task.id]);
    await expect(memory.read(current.runtimeScope)).rejects.toMatchObject({ code: "MEMORY_SCOPE_DENIED" });
    expect((await pool.query("SELECT count(*)::int AS n FROM agents_platform.accounts")).rows[0].n).toBe(count);
  });

  it("recovers complete memory and fences exact corrections without invalidating unrelated additions", async () => {
    const f = await fixture(), content = "Preferred report details. ".repeat(40) + "Exact final instruction: write in Shona.", item = await accepted(f.scope, content), current = await f.task();
    const evidence = new EvidenceStore(pool), searchId = randomUUID();
    await beginOperation(pool, current.task.id, { id: searchId, kind: "tool", name: "memory.search", request: {}, reservedTokens: 0, reservedMs: 30000 });
    const search = await executeMemoryTool(pool, current.task.id, searchId, "memory.search", { query: "Shona" }, evidence) as any;
    expect(search.memories[0]).toMatchObject({ id: item.id, excerpt: true, totalBytes: Buffer.byteLength(content), verified: false });
    expect(search.memories[0].content).not.toContain("Exact final instruction");
    await finishOperation(pool, current.task.id, searchId, "completed", search, null, 0);
    const previewPayload = { messages: [{ role: "user", content: JSON.stringify(search) }] }, previewSnapshot = `context:${current.task.id}:0`;
    await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,0,$3,$4,0)", [previewSnapshot, current.task.id, requestDigest(previewPayload), previewPayload]);
    await evidence.supplyContext(current.task.id, previewSnapshot, [search.memories[0].evidence.evidenceId]);
    const readId = randomUUID();
    await beginOperation(pool, current.task.id, { id: readId, kind: "tool", name: "memory.read", request: {}, reservedTokens: 0, reservedMs: 30000 });
    const read = await executeMemoryTool(pool, current.task.id, readId, "memory.read", { memoryId: item.id }, evidence) as any;
    expect(read.memory.content).toBe(content); expect(read.memory.evidence.citation).toMatch(/^\[E/);
    await finishOperation(pool, current.task.id, readId, "completed", read, null, 0);
    const payload = { messages: [{ role: "user", content: JSON.stringify(read) }] }, snapshot = `context:${current.task.id}:1`;
    await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,1,$3,$4,0)", [snapshot, current.task.id, requestDigest(payload), payload]);
    await evidence.supplyContext(current.task.id, snapshot, [read.memory.evidence.evidenceId]);
    const manifest = await taskEvidenceManifest(pool, current.task.id);
    expect(manifest.dependencies).toContainEqual({ kind: "memory", referenceId: expect.any(String), generation: 2, memoryId: item.id, memoryRevision: 2 });
    await accepted(f.scope, "An unrelated accepted preference.");
    await expect(assertCurrentEvidence(pool, current.task.id, manifest)).resolves.toBeUndefined();
    await memory.mutate(f.scope, item.id, { operationId: randomUUID(), expectedRevision: 2, action: "correct", content: "Write in English." });
    await expect(assertCurrentEvidence(pool, current.task.id, manifest)).rejects.toMatchObject({ code: "EVIDENCE_UNAVAILABLE" });
    expect((await memory.readForContext(current.runtimeScope, "Please prepare a brief in English")).memories[0]?.id).toBe(item.id);
  });

  it("rejects pending resurrection after Forget and new acceptance after memory is disabled", async () => {
    const f = await fixture(), content = "Keep these reports short.", first = await accepted(f.scope, content);
    const pending = await memory.proposeManaged(f.scope, { operationId: randomUUID(), kind: "semantic", content });
    await memory.mutate(f.scope, first.id, { operationId: randomUUID(), expectedRevision: 2, action: "forget" });
    await expect(memory.mutate(f.scope, pending.id, { operationId: randomUUID(), expectedRevision: 1, action: "accept" })).rejects.toMatchObject({ code: "MEMORY_SUPPRESSED" });
    const candidate = await memory.proposeManaged(f.scope, { operationId: randomUUID(), kind: "semantic", content: "Use the current corrected details." }), current = await f.task();
    const disabled = { ...f.configuration, memory: { enabled: false }, tools: [] };
    await platform.updateDraft({ ...f.management, expectedRevision: 1, configuration: disabled });
    const version = await platform.createVersion({ ...f.management, expectedRevision: 2 });
    await pool.query("UPDATE agents_platform.product_execution_features SET version_id=$1 WHERE product=$2 AND tenant_id=$3 AND agent_id=$4", [version.id, f.scope.product, f.scope.tenantId, f.agent.id]);
    await expect(memory.read(current.runtimeScope)).rejects.toMatchObject({ code: "MEMORY_SCOPE_DENIED" });
    await expect(memory.mutate(f.scope, candidate.id, { operationId: randomUUID(), expectedRevision: 1, action: "accept" })).rejects.toMatchObject({ code: "MEMORY_SCOPE_DENIED" });
    expect((await memory.list(f.scope)).candidates.map(item => item.id)).toContain(candidate.id);
    await expect(memory.mutate(f.scope, candidate.id, { operationId: randomUUID(), expectedRevision: 1, action: "forget" })).resolves.toMatchObject({ status: "forgotten" });
  });

  it("recalls only exact reviewed product memory in a new conversation while retaining source and provider fences", async () => {
    const f = await fixture("growth", true), original = await f.task(), evidence = new EvidenceStore(pool);
    const runtime = new ProductRuntime(pool, evidence); runtime.registerAdapter(f.adapter, f.executor); runtime.registerOriginAuthorizer("growth", async () => {});
    const selected={kind:"content_post",resourceId:"selected-fixture"};let contextAllowed=true;
    runtime.registerContextReader("growth",async taskId=>taskId===original.task.id&&contextAllowed?selected:null);
    const binding = f.configuration.productBindings[0]!, operationId = randomUUID(), text = "The source contains a private campaign record. Its approved report preference is concise wording.";
    await beginOperation(pool, original.task.id, { id: operationId, kind: "tool", name: binding.alias, request: {}, reservedTokens: 0, reservedMs: 30000 });
    const information = await currentProductInformation(pool, await loadExecution(pool, original.task.id));
    const passage = await evidence.recordProduct(original.task.id, operationId, { product: "growth", tenantId: f.scope.tenantId,
      contextRevision: "b".repeat(64), bindingId: binding.id, bindingDigest: binding.digest, operationName: binding.alias,
      text, title: "Private source", acquiredAt: new Date().toISOString(), sources: [{ id: "campaign-private-one" }], information });
    await finishOperation(pool, original.task.id, operationId, "completed", {}, null, 0);
    const selectedProductContext={reference:selected,dependency:{kind:"product_context" as const,product:"growth",tenantId:f.scope.tenantId,
      taskId:original.task.id,referenceDigest:requestDigest(selected),information}};
    const originalPayload = { selectedProductContext, messages: [{ role: "user", content: `${text} [${passage.label}]\n${selectedProductContextText(selected)}` }] }, originalSnapshot = `context:${original.task.id}:0`;
    await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,0,$3,$4,0)", [originalSnapshot, original.task.id, requestDigest(originalPayload), originalPayload]);
    await evidence.supplyContext(original.task.id, originalSnapshot, [passage.reference.id]);
    const candidate = await memory.propose(original.runtimeScope, { operationId: randomUUID(), kind: "semantic", content: "Prefer concise report wording.", sourceTaskId: original.task.id });
    await evidence.derive(original.task.id, "memory", candidate.id);
    const accepted = await memory.mutate(f.scope, candidate.id, { operationId: randomUUID(), expectedRevision: 1, action: "accept" });
    await settleTask(pool, original.task.id, { state: "completed", output: "Preference proposed for review." });
    const current = await f.task(); expect(current.task.conversation_id).not.toBe(original.task.conversation_id);
    const readId = randomUUID(); await beginOperation(pool, current.task.id, { id: readId, kind: "tool", name: "memory.read", request: {}, reservedTokens: 0, reservedMs: 30000 });
    const read = await executeMemoryTool(pool, current.task.id, readId, "memory.read", { memoryId: accepted.id }, evidence) as any;
    expect(read.memory).toMatchObject({ content: "Prefer concise report wording.", origin: "model_candidate", verified: false });
    await finishOperation(pool, current.task.id, readId, "completed", read, null, 0);
    const payload = { messages: [{ role: "user", content: JSON.stringify(read) }] }, snapshot = `context:${current.task.id}:0`;
    await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,0,$3,$4,0)", [snapshot, current.task.id, requestDigest(payload), payload]);
    await evidence.supplyContext(current.task.id, snapshot, [read.memory.evidence.evidenceId]);
    const manifest = await taskEvidenceManifest(pool, current.task.id);
    expect(manifest.dependencies).toContainEqual(expect.objectContaining({ kind: "product", memoryTransition: { memoryId: accepted.id, memoryRevision: accepted.revision }, information }));
    expect(manifest.dependencies).toContainEqual(expect.objectContaining({ kind: "product_context", memoryTransition: { memoryId: accepted.id, memoryRevision: accepted.revision }, information }));
    await expect(assertCurrentEvidence(pool, current.task.id, manifest)).resolves.toBeUndefined();
    await expect(assertProductInformationForModel(pool, current.task.id, manifest, "primary")).resolves.toBeUndefined();
    await expect(evidence.readPassage(current.task.id, passage.reference.id)).rejects.toMatchObject({ code: "EVIDENCE_SCOPE_DENIED" });
    contextAllowed=false;
    await expect(assertCurrentEvidence(pool, current.task.id, manifest)).rejects.toMatchObject({ code: "EVIDENCE_UNAVAILABLE" });
    contextAllowed=true;f.revokeSource();
    await expect(assertCurrentEvidence(pool, current.task.id, manifest)).rejects.toMatchObject({ code: "EVIDENCE_UNAVAILABLE" });
  });

  it("retains read access and provider restrictions in reviewed memory across conversations",async()=>{
    const f=await fixture("growth","access"),original=await f.task(),evidence=new EvidenceStore(pool);
    const runtime=new ProductRuntime(pool,evidence);runtime.registerAdapter(f.adapter,f.executor);runtime.registerOriginAuthorizer("growth",async()=>{});
    const binding=f.configuration.productBindings[0]!,operationId=randomUUID();
    await beginOperation(pool,original.task.id,{id:operationId,kind:"tool",name:binding.alias,
      request:{productBindingId:binding.id,bindingDigest:binding.digest,product:"growth"},reservedTokens:0,reservedMs:30000,retrySafe:true});
    const result=await runtime.invoke(original.task.id,operationId,binding,{});
    expect(result).toMatchObject({value:{finding:"A permitted business observation."}});
    expect(result).not.toHaveProperty("access");expect(result).not.toHaveProperty("information");
    await finishOperation(pool,original.task.id,operationId,"completed",result,null,0);
    const retained=await evidence.retainOperation(original.task.id,operationId);
    expect(retained.manifest.dependencies).toContainEqual(expect.objectContaining({kind:"product_access",reference:"scope:one"}));
    const originalAccess=retained.manifest.dependencies.find(value=>value.kind==="product_access");
    if(!originalAccess||originalAccess.kind!=="product_access")throw Error("Missing product access dependency");
    const candidate=await memory.propose(original.runtimeScope,{operationId:randomUUID(),kind:"semantic",content:"Prefer concise reports.",sourceTaskId:original.task.id});
    await evidence.derive(original.task.id,"memory",candidate.id);
    const accepted=await memory.mutate(f.scope,candidate.id,{operationId:randomUUID(),expectedRevision:1,action:"accept"});
    await settleTask(pool,original.task.id,{state:"completed",output:"Preference proposed."});
    const current=await f.task(),readId=randomUUID();
    await beginOperation(pool,current.task.id,{id:readId,kind:"tool",name:"memory.read",request:{},reservedTokens:0,reservedMs:30000});
    const read=await executeMemoryTool(pool,current.task.id,readId,"memory.read",{memoryId:accepted.id},evidence) as any;
    await finishOperation(pool,current.task.id,readId,"completed",read,null,0);
    const payload={messages:[{role:"user",content:JSON.stringify(read)}]},snapshot=`context:${current.task.id}:0`;
    await pool.query("INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,history_cutoff) VALUES($1,$2,0,$3,$4,0)",[snapshot,current.task.id,requestDigest(payload),payload]);
    await evidence.supplyContext(current.task.id,snapshot,[read.memory.evidence.evidenceId]);
    const manifest=await taskEvidenceManifest(pool,current.task.id);
    expect(manifest.dependencies).toContainEqual(expect.objectContaining({kind:"product_access",reference:"scope:one",information:originalAccess.information,memoryTransition:{memoryId:accepted.id,memoryRevision:accepted.revision}}));
    await expect(assertProductInformationForModel(pool,current.task.id,manifest,"primary")).resolves.toBeUndefined();
    const unauthorized=structuredClone(originalAccess),provider=unauthorized.information.providers[0]!;
    const {destinationDigest:_digest,bindingDigest:_binding,...destination}=provider;
    destination.endpoint="https://unapproved.example/";provider.endpoint=destination.endpoint;provider.destinationDigest=requestDigest(destination);
    await expect(assertProductInformationForModel(pool,current.task.id,createDependencyManifest([{...unauthorized,memoryTransition:{memoryId:accepted.id,memoryRevision:accepted.revision}}]),"primary"))
      .rejects.toMatchObject({code:"PRODUCT_INFORMATION_DENIED"});
    await expect(assertCurrentEvidence(pool,current.task.id,manifest)).resolves.toBeUndefined();
    f.revokeSource();await expect(assertCurrentEvidence(pool,current.task.id,manifest)).rejects.toMatchObject({code:"EVIDENCE_UNAVAILABLE"});
  },15000);
});
