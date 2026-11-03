import { contextGrantCeiling } from "../src/execution/models/settings";
import { createHash, createPublicKey, randomBytes, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { generateKeyPair, exportPKCS8, exportSPKI } from "jose";
import { Pool } from "pg";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agencyCapabilityManifest } from "../../../agency/api/src/capabilities/manifest.js";
import { buildApp } from "../../../agency/api/src/app.js";
import { readConfig } from "../../../agency/api/src/config.js";
import { runMigrations } from "../../../agency/api/src/migrate.js";
import { registerProductCapabilityRoutes } from "../../../agency/api/src/controllers/product-capabilities.js";
import { registerAgentExecutionRoutes } from "../../../agency/api/src/controllers/agent-execution.js";
import { setupPlatformSchema } from "../src/composition/setup";
import { ProductRuntime } from "../src/execution/products/product-runtime";
import { registerAgencyProductCapabilities } from "../src/adapters/products/agency-capability-client";
import { createProductBindings } from "../src/capabilities/products/product-capabilities";
import { defaultBusinessConfiguration, PlatformError, requestDigest } from "../src/contracts/contracts";
import { PlatformStore } from "../src/product/agents/store";
import { beginOperation, finishOperation, settleTask } from "../src/execution/lifecycle/execution";
import { productPorts } from "../src/infrastructure/product-ports";
import { connectFixtureModel } from "./model-fixture";
import { dropClosedTestDatabase } from "./support/database-cleanup";
import { registerAgencyOriginAuthority } from "../src/execution/products/agency-runtime";
import { provisionProductModel } from "../src/product/integrations/growth-model-provisioning";
import { ModelCredentialVault } from "../src/infrastructure/model-credential-vault";
import { ConnectionVault } from "../src/infrastructure/vault";
import { buildPlatformApp } from "../src/composition/app";
import { loadPlatformConfig } from "../src/infrastructure/config";
import { AgencyExecutionService } from "../src/product/integrations/agency-execution";
import { TaskArtifactStore } from "../src/execution/artifacts/task-artifacts";
import { privateStoreFromEnvironment } from "../src/infrastructure/object-store";
import { publishedToolBindings } from "../src/capabilities/tool-definitions";
import { compilePublishedComposition } from "../src/execution/programs/publication";
import type { ProductCapabilityInvocation } from "@kasitek-labs/contracts";
import { ProductActionClient } from "../src/adapters/products/product-action-client";

const adminUrl = process.env.AGENTS_TEST_ADMIN_URL;
(adminUrl ? describe : describe.skip)("shared product runtime to authoritative Agency HTTP and database", () => {
  const agentsDatabase = "agents_agency_port_" + randomUUID().replaceAll("-", "");
  const agencyDatabase = "agents_agency_destination_" + randomUUID().replaceAll("-", "");
  const originTenantId = randomUUID(), workspaceId = "agency-workspace", mappedActor = { issuer: "https://growth.test/identity", subject: "growth-owner" };
  let admin: Pool, pool: Pool, agency: Pool, app: Awaited<ReturnType<typeof buildApp>>, runtime: ProductRuntime;
  let env: NodeJS.ProcessEnv;
  let agencyConfig:ReturnType<typeof readConfig>,native:ReturnType<typeof Fastify>|undefined;
  let agencyOrigin:string,browser:any,page:any,browserPortal:import("node:http").Server|undefined,objectServer:Server|undefined;
  let originEnabled = true;
  const installOriginFixture = (target: ProductRuntime) => target.registerOriginAuthorizer("growth", async (taskId, db) => {
    // Controlled origin authority fixture. The destination grant cannot supply this decision.
    const row = (await db.query(`SELECT 1 FROM agents_platform.tasks t
      JOIN agents_platform.execution_grants g ON g.id=t.grant_id
      JOIN agents_platform.product_task_contexts p ON p.task_id=t.root_task_id
      WHERE t.id=$1 AND t.product='growth' AND p.tenant_id=$2 AND g.revoked_at IS NULL AND g.expires_at>NOW()
        AND t.principal->>'issuer'=$3 AND t.principal->>'subject'=$4`, [taskId, originTenantId, mappedActor.issuer, mappedActor.subject])).rows[0];
    if (!originEnabled || !row) throw new PlatformError("ORIGIN_FIXTURE_DENIED", 403, "Origin access revoked");
  });

  beforeAll(async () => {
    const url = new URL(adminUrl!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw Error("Agency acceptance requires a local disposable database administrator");
    url.pathname = "/postgres"; admin = new Pool({ connectionString: url.href });
    await admin.query(`CREATE DATABASE "${agentsDatabase}"`);
    await admin.query(`CREATE DATABASE "${agencyDatabase}"`);
    url.pathname = "/" + agentsDatabase; pool = new Pool({ connectionString: url.href });
    url.pathname = "/" + agencyDatabase; agency = new Pool({ connectionString: url.href });
    await setupPlatformSchema(pool); await runMigrations(agency);
    const keys = await generateKeyPair("RS256", { extractable: true });
    const config = agencyConfig = readConfig({ TENANT_DATABASE_URL: url.href, LOG_LEVEL: "silent", AGENTS_PRODUCT_ACTION_ISSUER: "https://agents.test",
      AGENTS_PRODUCT_ACTION_PUBLIC_KEY: await exportSPKI(keys.publicKey) });
    app = await buildApp({ pool: agency, config }, [registerProductCapabilityRoutes,registerAgentExecutionRoutes]);
    const origin = agencyOrigin = await app.listen({ host: "127.0.0.1", port: 0 });
    env = { NODE_ENV: "test", AGENCY_PRODUCT_API_URL: origin, AGENTS_PRODUCT_ACTION_ISSUER: "https://agents.test",
      AGENTS_PRODUCT_ACTION_PRIVATE_KEY: await exportPKCS8(keys.privateKey) };
    runtime = new ProductRuntime(pool);
    installOriginFixture(runtime);
    expect(registerAgencyProductCapabilities(runtime, {})).toBe(false);
    expect(registerAgencyProductCapabilities(runtime, env)).toBe(true);
    expect(registerAgencyProductCapabilities(runtime, env)).toBe(true);
    await agency.query(`INSERT INTO workspaces(id,slug,display_name) VALUES('agency-workspace','agency','Agency'),('foreign-workspace','foreign','Foreign');
      INSERT INTO tenant_users(id,workspace_id,email,password_hash) VALUES('agency-user','agency-workspace','owner@example.test','unused');
      INSERT INTO tenant_user_roles(tenant_user_id,role) VALUES('agency-user','support');
      INSERT INTO workspace_agents(id,workspace_id,name,status,config) VALUES('agent-one','agency-workspace','Support','active','{"secret":"configuration-is-private"}'),
      ('agent-foreign','foreign-workspace','Foreign','active','{}')`);
    await agency.query(`INSERT INTO product_capability_mappings(id,origin_product,origin_tenant_id,actor_issuer,actor_subject,workspace_id,tenant_user_id,expires_at)
      VALUES('destination-map','growth',$1,$2,$3,'agency-workspace','agency-user',NOW()+INTERVAL '1 hour')`, [originTenantId, mappedActor.issuer, mappedActor.subject]);
  }, 30000);
  afterAll(async () => {
    await page?.close({runBeforeUnload:false}).catch(()=>{});
    await browser?.close();if(browserPortal){browserPortal.closeAllConnections();await new Promise<void>(resolve=>browserPortal!.close(()=>resolve()));}
    if(objectServer){objectServer.closeAllConnections();await new Promise<void>(resolve=>objectServer!.close(()=>resolve()));}
    await native?.close();await app?.close(); await pool?.end(); await agency?.end();
    if (admin) { await dropClosedTestDatabase(admin, agentsDatabase); await dropClosedTestDatabase(admin, agencyDatabase); await admin.end(); }
    vi.unstubAllEnvs();
  },30000);

  it("reports missing and revoked model credentials from saved Agency readiness",async()=>{
    const tenantId=`agency-readiness-${randomUUID()}`,actor={issuer:"https://agency.test/identity",subject:randomUUID()};
    const service=new AgencyExecutionService(pool,"https://agency.test",runtime);
    const setup={version:"1" as const,requestId:randomUUID(),tenantId,clientId:"client",actor,operation:"tenant.ensure" as const,input:{mappingRef:`mapping-${randomUUID()}`,manifest:agencyCapabilityManifest}};
    await service.ensure(setup);
    const readiness={...setup,operation:"readiness.get" as const,input:{}};
    expect(await service.readiness(readiness)).toMatchObject({ready:false,code:"MODEL_DEFAULT_REQUIRED"});
    const vault=new ModelCredentialVault(new ConnectionVault("fixture",{fixture:randomBytes(32).toString("base64")}));
    const model=await provisionProductModel(pool,vault,"agencies",{tenantId,providerId:"openrouter",modelId:"fixture/readiness",apiKey:"fixture-only-key"},
      {discoveryFetch:async()=>({status:200,body:JSON.stringify({data:[{id:"fixture/readiness",name:"Fixture model",context_length:262144,top_provider:{max_completion_tokens:32768},supported_parameters:["tools"],architecture:{input_modalities:["text"],output_modalities:["text"]},pricing:{prompt:"0",completion:"0"}}]})})});
    expect(await service.readiness(readiness)).toMatchObject({ready:true});
    const saved=(await pool.query("SELECT * FROM agents_platform.model_provider_credentials WHERE organization_id=$1 AND connection_id=$2",[model.organizationId,model.connectionId])).rows[0];
    await pool.query("UPDATE agents_platform.model_provider_credentials SET state='revoked',envelope=NULL WHERE organization_id=$1 AND connection_id=$2 AND revision=$3",[saved.organization_id,saved.connection_id,saved.revision]);
    expect(await service.readiness(readiness)).toMatchObject({ready:false,code:"MODEL_CREDENTIAL_REVOKED"});
    await pool.query("UPDATE agents_platform.model_provider_credentials SET state='active',envelope=$4 WHERE organization_id=$1 AND connection_id=$2 AND revision=$3",[saved.organization_id,saved.connection_id,saved.revision,saved.envelope]);
    expect(await service.readiness(readiness)).toMatchObject({ready:true});
    await pool.query("DELETE FROM agents_platform.model_provider_credentials WHERE organization_id=$1 AND connection_id=$2 AND revision=$3",[saved.organization_id,saved.connection_id,saved.revision]);
    expect(await service.readiness(readiness)).toMatchObject({ready:false,code:"MODEL_CREDENTIAL_UNAVAILABLE"});
  },30000);

  it("upgrades only the unchanged managed client definition, once",async()=>{
    const tenantId=`agency-artifact-rollout-${randomUUID()}`,actor={issuer:"https://agency.test/identity",subject:randomUUID()};
    const service=new AgencyExecutionService(pool,"https://agency.test",runtime);
    const setup={version:"1" as const,requestId:randomUUID(),tenantId,clientId:"client",actor,operation:"tenant.ensure" as const,input:{mappingRef:`mapping-${randomUUID()}`,manifest:agencyCapabilityManifest}};
    const provisioned=await service.ensure(setup),featureId=provisioned.featureId;
    const publish=async(client:string,change:(configuration:any)=>void,resetMarker:boolean)=>{
      const feature=(await pool.query(`SELECT f.*,v.configuration,a.draft_revision FROM agents_platform.product_execution_features f
        JOIN agents_platform.agent_versions v ON v.id=f.version_id JOIN agents_platform.agents a ON a.id=f.agent_id
        WHERE f.product='agencies' AND f.tenant_id=$1 AND f.feature_id=$2`,[tenantId,client])).rows[0];
      const configuration=structuredClone(feature.configuration);change(configuration);
      const id=randomUUID(),revision=feature.draft_revision+1,serviceOwner={product:"agencies",clientId:"agency-api",issuer:"https://agency.test"};
      await pool.query("UPDATE agents_platform.agents SET draft=$2,draft_revision=$3 WHERE id=$1",[feature.agent_id,configuration,revision]);
      await pool.query(`INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,draft_revision,execution_kind,configuration,created_by_service,tool_bindings,effective_composition)
        VALUES($1,$2,$3,$4,$4,'business',$5,$6,$7,$8)`,[id,feature.organization_id,feature.agent_id,revision,configuration,serviceOwner,JSON.stringify(publishedToolBindings(configuration)),compilePublishedComposition(configuration,[])]);
      await pool.query("UPDATE agents_platform.product_execution_features SET version_id=$3,revision=$4,artifact_rollout_revision=$5 WHERE product='agencies' AND tenant_id=$1 AND feature_id=$2",[tenantId,client,id,revision,resetMarker?0:1]);
      return id;
    };
    const legacyVersion=await publish(featureId,configuration=>{configuration.memory={enabled:true};configuration.tools=["memory.search","memory.propose"];},true);
    await service.ensure({...setup,requestId:randomUUID()});
    const upgraded=(await pool.query(`SELECT f.version_id,f.artifact_rollout_revision,v.configuration FROM agents_platform.product_execution_features f
      JOIN agents_platform.agent_versions v ON v.id=f.version_id WHERE f.product='agencies' AND f.tenant_id=$1 AND f.feature_id=$2`,[tenantId,featureId])).rows[0];
    expect(upgraded.version_id).not.toBe(legacyVersion);expect(upgraded.artifact_rollout_revision).toBe(1);
    expect(upgraded.configuration.memory.enabled).toBe(true);expect(upgraded.configuration.tools).toEqual(["memory.search","memory.propose","artifact.create"]);
    expect((await pool.query("SELECT configuration FROM agents_platform.agent_versions WHERE id=$1",[legacyVersion])).rows[0].configuration.tools).not.toContain("artifact.create");
    const removedVersion=await publish(featureId,configuration=>{configuration.tools=configuration.tools.filter((tool:string)=>tool!=="artifact.create");},false);
    await service.ensure({...setup,requestId:randomUUID()});
    expect((await pool.query("SELECT version_id FROM agents_platform.product_execution_features WHERE product='agencies' AND tenant_id=$1 AND feature_id=$2",[tenantId,featureId])).rows[0].version_id).toBe(removedVersion);
    const customized={...setup,clientId:"custom",requestId:randomUUID(),input:{...setup.input,mappingRef:`mapping-${randomUUID()}`}};
    const customFeature=(await service.ensure(customized)).featureId;
    const customVersion=await publish(customFeature,configuration=>{configuration.tools=[];configuration.instructions="A custom client instruction.";},true);
    await service.ensure({...customized,requestId:randomUUID()});
    expect((await pool.query("SELECT version_id,artifact_rollout_revision FROM agents_platform.product_execution_features WHERE product='agencies' AND tenant_id=$1 AND feature_id=$2",[tenantId,customFeature])).rows[0]).toMatchObject({version_id:customVersion,artifact_rollout_revision:1});
  },30000);

  it("normalizes the unchanged legacy Agency context cap and preserves selected models and edits",async()=>{
    const tenantId=`agency-context-rollout-${randomUUID()}`,actor={issuer:"https://agency.test/identity",subject:randomUUID()};
    const service=new AgencyExecutionService(pool,"https://agency.test",runtime);
    const setup={version:"1" as const,requestId:randomUUID(),tenantId,clientId:"default",actor,operation:"tenant.ensure" as const,input:{mappingRef:`mapping-${randomUUID()}`,manifest:agencyCapabilityManifest}};
    const provisioned=await service.ensure(setup),featureId=provisioned.featureId;
    const publish=async(client:string,change:(configuration:any)=>void,leaveDraft?:boolean)=>{
      const row=(await pool.query(`SELECT f.*,v.configuration,v.created_by_service AS version_owner,a.draft_revision,a.created_by_service AS agent_owner
        FROM agents_platform.product_execution_features f JOIN agents_platform.agent_versions v ON v.id=f.version_id
        JOIN agents_platform.agents a ON a.id=f.agent_id
        WHERE f.product='agencies' AND f.tenant_id=$1 AND f.feature_id=$2`,[tenantId,client])).rows[0];
      const configuration=structuredClone(row.configuration);change(configuration);
      const versionId=randomUUID(),draftRevision=Number(row.draft_revision)+1;
      await pool.query("UPDATE agents_platform.agents SET draft=$2,draft_revision=$3 WHERE id=$1",[row.agent_id,configuration,draftRevision]);
      await pool.query(`INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,draft_revision,execution_kind,configuration,created_by_service,tool_bindings,effective_composition)
        VALUES($1,$2,$3,(SELECT coalesce(max(number),0)+1 FROM agents_platform.agent_versions WHERE agent_id=$3),$4,'business',$5,$6,$7,$8)`,
      [versionId,row.organization_id,row.agent_id,draftRevision,configuration,row.version_owner,JSON.stringify(publishedToolBindings(configuration)),compilePublishedComposition(configuration,[])]);
      await pool.query("UPDATE agents_platform.product_execution_features SET version_id=$3,revision=revision+1,artifact_rollout_revision=1 WHERE product='agencies' AND tenant_id=$1 AND feature_id=$2",[tenantId,client,versionId]);
      if(leaveDraft){
        const draft=structuredClone(configuration);draft.instructions="An unpublished Agency draft change.";
        await pool.query("UPDATE agents_platform.agents SET draft=$2,draft_revision=draft_revision+1 WHERE id=$1",[row.agent_id,draft]);
      }
      return {versionId,configuration};
    };
    const selectedModel={kind:"connection" as const,connectionId:randomUUID(),modelId:"openrouter/nvidia/nemotron-3-ultra-550b-a55b:free"};
    const legacyContext={maxInputTokens:8192,compactAtTokens:6144};
    const legacy=await publish(featureId,configuration=>{
      configuration.context=legacyContext;configuration.model.selection=selectedModel;
      configuration.memory={enabled:true};configuration.tools=["memory.search","memory.propose"];
    });
    await service.ensure({...setup,requestId:randomUUID()});
    let saved=(await pool.query(`SELECT f.version_id,f.revision,f.artifact_rollout_revision,v.configuration,a.draft,a.draft_revision,v.draft_revision AS version_draft_revision
      FROM agents_platform.product_execution_features f JOIN agents_platform.agent_versions v ON v.id=f.version_id JOIN agents_platform.agents a ON a.id=f.agent_id
      WHERE f.product='agencies' AND f.tenant_id=$1 AND f.feature_id=$2`,[tenantId,featureId])).rows[0];
    expect(saved.version_id).not.toBe(legacy.versionId);expect(saved.revision).toBe(3);expect(saved.artifact_rollout_revision).toBe(1);
    expect(saved.configuration.context).toEqual({mode:"automatic"});expect(saved.configuration.model.selection).toEqual(selectedModel);
    expect(saved.configuration.memory).toEqual({enabled:true});expect(saved.configuration.tools).toEqual(["memory.search","memory.propose"]);
    expect(saved.draft).toEqual(saved.configuration);expect(saved.draft_revision).toBe(saved.version_draft_revision);
    expect((await pool.query("SELECT configuration FROM agents_platform.agent_versions WHERE id=$1",[legacy.versionId])).rows[0].configuration.context).toEqual(legacyContext);
    const migratedVersion=saved.version_id;
    await service.ensure({...setup,requestId:randomUUID()});
    expect((await pool.query("SELECT version_id FROM agents_platform.product_execution_features WHERE product='agencies' AND tenant_id=$1 AND feature_id=$2",[tenantId,featureId])).rows[0].version_id).toBe(migratedVersion);

    const custom={...setup,clientId:"custom",requestId:randomUUID(),input:{...setup.input,mappingRef:`mapping-${randomUUID()}`}};
    const customFeature=(await service.ensure(custom)).featureId;
    const customLegacy=await publish(customFeature,configuration=>{configuration.context=legacyContext;configuration.instructions="Custom client instructions.";});
    await service.ensure({...custom,requestId:randomUUID()});
    saved=(await pool.query(`SELECT f.version_id,v.configuration FROM agents_platform.product_execution_features f JOIN agents_platform.agent_versions v ON v.id=f.version_id
      WHERE f.product='agencies' AND f.tenant_id=$1 AND f.feature_id=$2`,[tenantId,customFeature])).rows[0];
    expect(saved.version_id).toBe(customLegacy.versionId);expect(saved.configuration.context).toEqual(legacyContext);

    const draftSetup={...setup,clientId:"draft",requestId:randomUUID(),input:{...setup.input,mappingRef:`mapping-${randomUUID()}`}};
    const draftFeature=(await service.ensure(draftSetup)).featureId;
    const pending=await publish(draftFeature,configuration=>{configuration.context=legacyContext;},true);
    await service.ensure({...draftSetup,requestId:randomUUID()});
    saved=(await pool.query(`SELECT f.version_id,v.configuration,a.draft FROM agents_platform.product_execution_features f JOIN agents_platform.agent_versions v ON v.id=f.version_id
      JOIN agents_platform.agents a ON a.id=f.agent_id WHERE f.product='agencies' AND f.tenant_id=$1 AND f.feature_id=$2`,[tenantId,draftFeature])).rows[0];
    expect(saved.version_id).toBe(pending.versionId);expect(saved.configuration.context).toEqual(legacyContext);
    expect(saved.draft.instructions).toBe("An unpublished Agency draft change.");
  },30000);

  it("publishes an inline binding and invokes the generic port without inferred Agency membership", async () => {
    const store = new PlatformStore(pool);
    const creator = await store.ensureAccount({ issuer: "https://fixture.test", subject: randomUUID(), email: "builder@example.test", displayName: "Builder" });
    const org = await store.createOrganization(creator.id, "Explicit destination tools"), scope = { accountId: creator.id, organizationId: org.id };
    const model = await connectFixtureModel(pool, creator.id, org.id);
    const bindings = createProductBindings(agencyCapabilityManifest, org.id, { originProduct: "growth", originTenantId, tenantId: workspaceId,
      mappingRef: "destination-map", policyRevision: "metadata-policy-1" }, ["agency.workspace_agents.read"]);
    const binding = bindings[0]!;
    const configuration = defaultBusinessConfiguration();
    configuration.program = { id: "tool-directed", version: "3" };
    configuration.instructions = "Use the permitted Agency metadata tool when needed.";
    configuration.productBindings = bindings;
    configuration.model.selection = { kind: "connection", connectionId: model.connection.id, modelId: model.modelId };
    const agent = await store.createAgent({ ...scope, name: "Shared port", configuration });
    await model.store.grant(scope, { connectionId: model.connection.id, consumer: { kind: "agent", agentId: agent.id }, roles: ["primary", "compaction", "delegated"], modelIds: [model.modelId] });
    const version = await store.createVersion({ ...scope, agentId: agent.id, expectedRevision: 1 });
    await pool.query("INSERT INTO agents_platform.product_execution_tenants(product,tenant_id,organization_id,client_id,issuer) VALUES('growth',$1,$2,'growth-api',$3)", [originTenantId, org.id, mappedActor.issuer]);
    await pool.query("INSERT INTO agents_platform.product_execution_features(product,tenant_id,feature_id,organization_id,agent_id,version_id) VALUES('growth',$1,'assistant',$2,$3,$4)", [originTenantId, org.id, agent.id, version.id]);
    const grantId = randomUUID(), principal = { kind: "human" as const, ...mappedActor };
    await pool.query(`INSERT INTO agents_platform.execution_grants(id,product,organization_id,resource_id,caller_client_id,principal,version_id,operations,max_input_bytes,max_output_tokens,max_context_tokens,root_token_limit,expires_at)
      VALUES($1,'growth',$2,'assistant','growth-api',$3,$4,$5,$6,$7,$8,32000,now()+interval '5 minutes')`,
    [grantId, org.id, principal, version.id, JSON.stringify(["model.reply", "product.read"]), configuration.model.maxInputBytes, configuration.model.maxOutputTokens, contextGrantCeiling(configuration)]);
    await pool.query("INSERT INTO agents_platform.product_execution_authorities(grant_id,product,organization_id,client_id,issuer,assertion_digest) VALUES($1,'growth',$2,'growth-api',$3,$4)", [grantId, org.id, mappedActor.issuer, "a".repeat(64)]);
    const authority = { product: "growth" as const, organizationId: org.id, resourceId: "assistant", callerClientId: "growth-api", principal };
    const { task } = await store.admitTask({ authority, grantId, versionId: version.id, requestKey: randomUUID(), input: "Read Agency agent metadata" });
    await pool.query("INSERT INTO agents_platform.product_conversations(conversation_id,product,tenant_id,feature_id,title) VALUES($1,'growth',$2,'assistant','Metadata')", [task.conversation_id, originTenantId]);
    await pool.query("INSERT INTO agents_platform.product_task_contexts(task_id,product,tenant_id,feature_id,conversation_id,command_digest) VALUES($1,'growth',$2,'assistant',$3,$4)", [task.id, originTenantId, task.conversation_id, "a".repeat(64)]);
    expect(await runtime.availableBindings(task.id)).toEqual([]);
    await agency.query(`INSERT INTO product_capability_grants(mapping_id,operation,manifest_digest,descriptor_digest,handler_ref,policy_revision,binding_id,binding_digest,agent_ids,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,'["agent-one","agent-foreign"]',NOW()+INTERVAL '1 hour')`,
    [binding.authority!.mappingRef, binding.definition.providerOperation, binding.authority!.manifestDigest, binding.authority!.descriptorDigest,
      binding.authority!.handlerRef, binding.authority!.policyRevision, binding.id, binding.digest]);
    expect(await runtime.availableBindings(task.id)).toHaveLength(1);
    const otherPool = new Pool({ connectionString: pool.options.connectionString });
    try {
      const isolated = new ProductRuntime(otherPool);
      installOriginFixture(isolated);
      registerAgencyProductCapabilities(isolated, { ...env, AGENTS_PRODUCT_ACTION_ISSUER: "https://untrusted-agents.test" });
      await expect(isolated.availableBindings(task.id)).rejects.toMatchObject({ statusCode: 401 });
      expect(await runtime.availableBindings(task.id)).toHaveLength(1);
    } finally { await otherPool.end(); }
    const operationId = `tool:${task.id}:0:0`;
    await beginOperation(pool, task.id, { id: operationId, kind: "tool", name: binding.alias, request: {}, reservedTokens: 0, reservedMs: 1000, retrySafe: true });
    const result = await runtime.invoke(task.id, operationId, binding, {});
    expect(JSON.stringify(result)).toContain("Support");
    expect(JSON.stringify(result)).not.toContain("configuration-is-private");
    expect(JSON.stringify(result)).not.toContain("agent-foreign");
    const evidence = (await runtime.evidence.operationEvidenceIds(task.id, operationId))[0]!;
    expect(evidence).toBeTruthy();
    const row = (await pool.query("SELECT manifest FROM agents_platform.evidence_references WHERE id=$1", [evidence])).rows[0];
    const dependency = row.manifest.dependencies[0];
    await productPorts(pool).assertCurrentEvidence(pool, { consumerTaskId: task.id, dependency });
    await agency.query("UPDATE workspace_agents SET updated_at=NOW()+INTERVAL '1 second' WHERE id='agent-one'");
    await expect(productPorts(pool).assertCurrentEvidence(pool, { consumerTaskId: task.id, dependency })).rejects.toMatchObject({ statusCode: 403 });
    originEnabled = false;
    await expect(runtime.availableBindings(task.id)).rejects.toMatchObject({ code: "ORIGIN_FIXTURE_DENIED" });
    originEnabled = true;
    await agency.query("DELETE FROM tenant_user_roles WHERE tenant_user_id='agency-user'");
    expect(await runtime.availableBindings(task.id)).toEqual([]);
    expect((await pool.query("SELECT count(*) FROM agents_platform.accounts WHERE issuer=$1 AND subject=$2", [mappedActor.issuer, mappedActor.subject])).rows[0].count).toBe("0");
  }, 30000);

  it("admits actual Agency staff commands with client isolation, current authority and native metadata receipts",async()=>{
    await agency.query(`INSERT INTO tenant_user_roles(tenant_user_id,role) VALUES('agency-user','support') ON CONFLICT DO NOTHING;
      INSERT INTO tenant_clients(id,workspace_id,name,slug) VALUES('client-one','agency-workspace','Same name','one'),('client-two','agency-workspace','Same name','two');
      INSERT INTO tenant_client_assignments(id,workspace_id,tenant_client_id,tenant_user_id) VALUES('assign-one','agency-workspace','client-one','agency-user'),('assign-two','agency-workspace','client-two','agency-user');
      UPDATE workspace_agents SET tenant_client_id='client-one' WHERE id='agent-one';
      INSERT INTO workspace_agents(id,workspace_id,tenant_client_id,name,status) VALUES('other-client-agent','agency-workspace','client-two','Hidden other client','active')`);
    const session="fixture-agency-staff-"+randomUUID();
    await agency.query("INSERT INTO tenant_sessions(id,workspace_id,tenant_user_id,token_hash,expires_at) VALUES($1,'agency-workspace','agency-user',$2,now()+interval '1 hour')",[randomUUID(),createHash('sha256').update(session).digest('hex')]);
    const headers={cookie:`${agencyConfig.session_cookie_name}=${session}`,"x-kasitek-tenant-slug":"agency"};
    const privateKey=env.AGENTS_PRODUCT_ACTION_PRIVATE_KEY!,publicKey=createPublicKey(privateKey).export({type:"spki",format:"pem"}).toString();
    // Service signatures and owning-product sessions are real; the model-discovery boundary is controlled.
    for(const [key,value] of Object.entries(env))vi.stubEnv(key,value);
    vi.stubEnv("GROWTH_PRODUCT_API_URL",undefined);
    vi.stubEnv("AGENCY_AGENTS_ISSUER","https://agency.test");
    vi.stubEnv("AGENCY_IDENTITY_ISSUER","https://agency.kasitek.co.za/identity");
    vi.stubEnv("AGENCY_AGENTS_PUBLIC_KEYS_JSON",JSON.stringify({"agency-v1":publicKey}));
    const objects=new Map<string,Buffer>();
    objectServer=createServer((req,res)=>{
      const key=req.url!;
      if(req.method==="PUT"){
        const chunks:Buffer[]=[];req.on("data",chunk=>chunks.push(Buffer.from(chunk)));
        req.on("end",()=>{objects.set(key,Buffer.concat(chunks));res.writeHead(200).end();});return;
      }
      if(req.method==="GET"){const content=objects.get(key);if(content)res.writeHead(200).end(content);else res.writeHead(404).end();return;}
      if(req.method==="DELETE"){objects.delete(key);res.writeHead(204).end();return;}
      res.writeHead(405).end();
    });
    await new Promise<void>(resolve=>objectServer!.listen(0,"127.0.0.1",resolve));
    vi.stubEnv("AGENTS_S3_ENDPOINT",`http://127.0.0.1:${(objectServer.address() as {port:number}).port}`);
    vi.stubEnv("AGENTS_S3_REGION","test");vi.stubEnv("AGENTS_S3_BUCKET","agency-artifacts-test");
    vi.stubEnv("AGENTS_S3_ACCESS_KEY_ID","fixture");vi.stubEnv("AGENTS_S3_SECRET_ACCESS_KEY","fixture-secret");
    native=await buildPlatformApp({pool,logging:false,config:loadPlatformConfig({NODE_ENV:"test",AGENTS_DATABASE_URL:pool.options.connectionString,
      AGENTS_PUBLIC_URL:"http://localhost:3100",AGENTS_OIDC_CLIENT_SECRET:"isolated-agency-service-route-secret"})});
    const nativeUrl=await native.listen({host:"127.0.0.1",port:0});
    Object.assign(agencyConfig.env,{AGENTS_EXECUTION_URL:nativeUrl,AGENCY_AGENTS_ISSUER:"https://agency.test",AGENCY_AGENTS_KEY_ID:"agency-v1",AGENCY_AGENTS_PRIVATE_KEY:privateKey});
    registerAgencyOriginAuthority(runtime,env);
    const call=(client:string,operation:string,input:unknown={},requestId=randomUUID())=>app.inject({method:"POST",url:`/api/clients/${client}/agent/commands`,headers,payload:{operation,input,requestId}});
    const initial=await app.inject({method:"GET",url:"/api/clients/client-one/agent",headers});
    expect(initial.statusCode,initial.body).toBe(200);expect(initial.json()).toMatchObject({ready:false,code:"MODEL_DEFAULT_REQUIRED",memoryEnabled:false});
    const grant=(await agency.query(`SELECT g.mapping_id,g.binding_id,g.binding_digest FROM product_capability_grants g
      JOIN shared_agent_client_setups s ON s.mapping_id=g.mapping_id
      WHERE s.workspace_id='agency-workspace' AND s.tenant_client_id='client-one' AND s.tenant_user_id='agency-user'`)).rows[0];
    expect(grant).toBeDefined();
    await agency.query("UPDATE product_capability_grants SET binding_digest=$3 WHERE mapping_id=$1 AND binding_id=$2",[grant.mapping_id,grant.binding_id,"f".repeat(64)]);
    expect((await app.inject({method:"GET",url:"/api/clients/client-one/agent",headers})).statusCode).toBe(403);
    await agency.query("UPDATE product_capability_grants SET binding_digest=$3 WHERE mapping_id=$1 AND binding_id=$2",[grant.mapping_id,grant.binding_id,grant.binding_digest]);
    const modelId="fixture/agency-model";
    const vault=new ModelCredentialVault(new ConnectionVault("agency-fixture",{"agency-fixture":randomBytes(32).toString("base64")}));
    const profile={tenantId:workspaceId,providerId:"openrouter",modelId,apiKey:"fixture-agency-key"},identity={id:randomUUID(),digest:requestDigest(profile)};
    const configured=await provisionProductModel(pool,vault,"agencies",profile,{replaceExisting:true,requestIdentity:identity,discoveryFetch:async()=>({status:200,body:JSON.stringify({data:[{id:modelId,name:"Agency fixture model",context_length:262144,top_provider:{max_completion_tokens:32768},supported_parameters:["tools"],architecture:{input_modalities:["text"],output_modalities:["text"]},pricing:{prompt:"0",completion:"0"}}]})})});
    expect(await provisionProductModel(pool,vault,"agencies",profile,{replaceExisting:true,requestIdentity:identity,discoveryFetch:async()=>{throw Error("Recorded model setup must not rediscover");}})).toEqual(configured);
    await expect(provisionProductModel(pool,vault,"agencies",{...profile,modelId:"different"},{requestIdentity:{...identity,digest:"f".repeat(64)}})).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});
    expect(JSON.stringify((await pool.query("SELECT response FROM agents_platform.product_command_receipts WHERE request_id=$1",[identity.id])).rows)).not.toContain(profile.apiKey);
    const created=await call("client-one","conversations.create");expect(created.statusCode,created.body).toBe(200);const conversationId=created.json().conversation.id;
    const empty=await call("client-one","conversations.get",{conversationId});expect(empty.statusCode,empty.body).toBe(200);expect(empty.json().tasks).toEqual([]);
    const requestId=randomUUID(),submitted=await call("client-one","turns.submit",{conversationId,text:"Which agents are active for this client?"},requestId);
    expect(submitted.statusCode,submitted.body).toBe(200);const task=submitted.json().task;
    expect((await call("client-one","turns.submit",{conversationId,text:"Which agents are active for this client?"},requestId)).json().task.id).toBe(task.id);
    expect((await call("client-one","turns.submit",{conversationId,text:"Changed input"},requestId)).statusCode).toBe(409);
    expect((await call("client-two","conversations.get",{conversationId})).statusCode).toBe(404);
    expect((await call("client-two","tasks.observe",{taskId:task.id})).statusCode).toBe(404);
    const steered=await call("client-one","tasks.instructions",{taskId:task.id,instruction:"Use short paragraphs."});
    expect(steered.statusCode,steered.body).toBe(200);expect(steered.json().message.text).toBe("Use short paragraphs.");
    const deniedModel=await app.inject({method:"POST",url:"/api/clients/client-one/agent/model",headers,payload:{requestId:randomUUID(),providerId:"openrouter",modelId,apiKey:"fixture-key"}});
    expect(deniedModel.statusCode).toBe(403);
    const binding=(await runtime.availableBindings(task.id))[0]!;
    const actionClient=new ProductActionClient({origin:agencyOrigin,privateKey,issuer:"https://agents.test",keyId:"agents-v1",environment:"test"});
    const metadataAuthorization:ProductCapabilityInvocation={version:"1",requestId:randomUUID(),operationId:`authority:${task.id}`,
      taskId:task.id,conversationId,actor:{issuer:"https://agency.kasitek.co.za/identity",subject:"agency-user"},authority:binding.authority!,
      bindingId:binding.id,bindingDigest:binding.digest,operation:binding.definition.providerOperation,input:{},control:"authorize"};
    await expect(actionClient.invoke(metadataAuthorization)).resolves.toMatchObject({value:{authorized:true}});
    const metadataRead:ProductCapabilityInvocation={...metadataAuthorization,requestId:randomUUID(),operationId:`read:${task.id}`,control:"invoke"};
    const metadataResult=await actionClient.invoke(metadataRead);
    expect(metadataResult.value).toMatchObject({agents:expect.arrayContaining([expect.objectContaining({id:"agent-one"})])});
    expect(JSON.stringify(metadataResult)).not.toContain("Hidden other client");
    const acceptedReceipt=(await pool.query("SELECT request_digest,response FROM agents_platform.product_command_receipts WHERE product='agencies' AND tenant_id=$1 AND request_id=$2",[workspaceId,requestId])).rows[0];
    expect(acceptedReceipt).toBeDefined();
    await agency.query("UPDATE shared_agent_client_setups SET enabled=false,updated_at=now() WHERE workspace_id=$1 AND tenant_client_id=$2 AND tenant_user_id=$3",[workspaceId,"client-one","agency-user"]);
    await expect(runtime.authorizeTask(task.id)).rejects.toMatchObject({statusCode:403});
    await expect(actionClient.invoke({...metadataAuthorization,requestId:randomUUID(),operationId:`disabled:${task.id}`})).rejects.toMatchObject({statusCode:403});
    await expect(actionClient.invoke({...metadataRead,requestId:randomUUID(),operationId:`disabled-read:${task.id}`})).rejects.toMatchObject({statusCode:403});
    expect((await agency.query(`SELECT s.enabled,m.revoked_at AS mapping_revoked,g.revoked_at AS grant_revoked,
        w.status AS workspace_status,u.status AS user_status,a.status AS assignment_status
      FROM shared_agent_client_setups s JOIN product_capability_mappings m ON m.id=s.mapping_id
      JOIN product_capability_grants g ON g.mapping_id=m.id JOIN workspaces w ON w.id=s.workspace_id
      JOIN tenant_users u ON u.id=s.tenant_user_id JOIN tenant_client_assignments a
        ON a.workspace_id=s.workspace_id AND a.tenant_client_id=s.tenant_client_id AND a.tenant_user_id=s.tenant_user_id
      WHERE s.workspace_id=$1 AND s.tenant_client_id=$2 AND s.tenant_user_id=$3`,[workspaceId,"client-one","agency-user"])).rows[0])
      .toMatchObject({enabled:false,mapping_revoked:null,grant_revoked:null,workspace_status:"active",user_status:"active",assignment_status:"active"});
    expect((await pool.query("SELECT request_digest,response FROM agents_platform.product_command_receipts WHERE product='agencies' AND tenant_id=$1 AND request_id=$2",[workspaceId,requestId])).rows[0]).toEqual(acceptedReceipt);
    await agency.query("UPDATE shared_agent_client_setups SET enabled=true,updated_at=now() WHERE workspace_id=$1 AND tenant_client_id=$2 AND tenant_user_id=$3",[workspaceId,"client-one","agency-user"]);
    await expect(runtime.authorizeTask(task.id)).resolves.toBeUndefined();
    const operationId=`tool:${task.id}:0:0`;
    const admitted=await beginOperation(pool,task.id,{id:operationId,kind:"tool",name:binding.alias,request:{},reservedTokens:0,reservedMs:5000,retrySafe:true});
    const result=await runtime.invoke(task.id,operationId,binding,{});
    expect(JSON.stringify(result)).toContain("Support");expect(JSON.stringify(result)).not.toContain("Hidden other client");
    expect(JSON.stringify(result)).not.toContain("credentialRevision");
    await finishOperation(pool,task.id,operationId,"completed",result,null,0,admitted.operation.attempt_id);
    await settleTask(pool,task.id,{state:"completed",output:"Support is active."});
    const observed=await call("client-one","tasks.observe",{taskId:task.id});expect(observed.statusCode,observed.body).toBe(200);
    expect(observed.json().task).toMatchObject({state:"completed",output:"Support is active."});expect(observed.json().operations).toHaveLength(1);
    expect(observed.json().operations[0]).toMatchObject({label:"Read permitted Agency workspace agents' names, status and update times."});
    expect((await pool.query("SELECT count(*) FROM agents_platform.accounts WHERE issuer='https://agency.kasitek.co.za/identity' AND subject='agency-user'")).rows[0].count).toBe("0");
    const memoryConfigured=await call("client-one","memory.configure",{enabled:true,expectedRevision:initial.json().revision});
    expect(memoryConfigured.statusCode,memoryConfigured.body).toBe(200);
    const proposed=await call("client-one","memory.propose",{kind:"semantic",content:"A hypothetical launch could use a Friday briefing."});
    expect(proposed.statusCode,proposed.body).toBe(200);const candidate=proposed.json();
    const acceptance={memoryId:candidate.id,expectedRevision:candidate.revision,action:"accept",assertion:{context:"hypothetical",conflict:"reported"}};
    const acceptanceId=randomUUID(),accepted=await call("client-one","memory.mutate",acceptance,acceptanceId);
    expect(accepted.statusCode,accepted.body).toBe(200);
    expect(accepted.json()).toMatchObject({status:"accepted",revision:2,assertion:{context:"hypothetical",conflict:"reported"},verified:false});
    expect((await call("client-one","memory.mutate",acceptance,acceptanceId)).json().revision).toBe(2);
    expect((await call("client-two","memory.mutate",{memoryId:candidate.id,expectedRevision:2,action:"forget"})).statusCode).toBe(404);
    const corrected=await call("client-one","memory.mutate",{memoryId:candidate.id,expectedRevision:2,action:"correct",content:"The owner confirmed the Tuesday briefing.",assertion:{context:"current",conflict:"resolved"}});
    expect(corrected.statusCode,corrected.body).toBe(200);
    expect(corrected.json()).toMatchObject({revision:3,content:"The owner confirmed the Tuesday briefing.",assertion:{context:"current",conflict:"resolved"},verified:false});
    expect((await call("client-one","memory.mutate",{memoryId:candidate.id,expectedRevision:3,action:"forget",assertion:{context:"current",conflict:"resolved"}})).statusCode).toBe(400);
    const forgotten=await call("client-one","memory.mutate",{memoryId:candidate.id,expectedRevision:3,action:"forget"});
    expect(forgotten.statusCode,forgotten.body).toBe(200);expect(forgotten.json()).toMatchObject({status:"forgotten",revision:4,content:""});
    expect((await call("client-one","memory.list")).json().memories).toEqual([]);
    const artifactTurn=await call("client-one","turns.submit",{conversationId,text:"Please save the project notes as a text file."});
    expect(artifactTurn.statusCode,artifactTurn.body).toBe(200);const artifactTask=artifactTurn.json().task;
    const artifactOperation=`file:${artifactTask.id}`,content=Buffer.from("Project notes\n"+"A useful detail.\n".repeat(5000));
    const creation=await beginOperation(pool,artifactTask.id,{id:artifactOperation,kind:"tool",name:"artifact.create",request:{name:"project-notes.txt"},reservedTokens:0,reservedMs:5000,retrySafe:true});
    const artifact=await new TaskArtifactStore(pool,privateStoreFromEnvironment()).put(artifactTask.id,artifactOperation,{name:"project-notes.txt",contentType:"text/plain",content});
    await finishOperation(pool,artifactTask.id,artifactOperation,"completed",{artifactId:artifact.id,name:artifact.name},null,0,creation.operation.attempt_id);
    await settleTask(pool,artifactTask.id,{state:"completed",output:"The project notes are ready."});
    const listed=await call("client-one","artifacts.list",{taskId:artifactTask.id});
    expect(listed.statusCode,listed.body).toBe(200);expect(listed.json().artifacts).toMatchObject([{id:artifact.id,title:"project-notes.txt"}]);
    const taskWithResult=await call("client-one","tasks.get",{taskId:artifactTask.id});
    expect(taskWithResult.statusCode,taskWithResult.body).toBe(200);expect(taskWithResult.json().task.results).toMatchObject([{artifactId:artifact.id,title:"project-notes.txt"}]);
    const downloadUrl=`/api/clients/client-one/agent/tasks/${artifactTask.id}/artifacts/${artifact.id}/download`;
    const download=await app.inject({method:"GET",url:downloadUrl,headers});
    expect(download.statusCode,download.body).toBe(200);expect(download.rawPayload.equals(content)).toBe(true);
    expect(download.headers["content-disposition"]).toContain("project-notes.txt");
    expect((await call("client-two","artifacts.get",{taskId:artifactTask.id,artifactId:artifact.id,offset:0})).statusCode).toBe(404);
    // Exercise the ordinary client paging contract with accepted records only. The generated
    // turns are settled through lifecycle helpers; no model provider calls run.
    const olderConversationIds:string[]=[];
    for(let index=1;index<=20;index++){
      const createdOlder=await call("client-one","conversations.create",{title:index===1?"Older page conversation":`Conversation page ${index}`});
      expect(createdOlder.statusCode,createdOlder.body).toBe(200);
      olderConversationIds.push(createdOlder.json().conversation.id);
      await pool.query("UPDATE agents_platform.product_conversations SET updated_at=now()-($2::int * interval '1 second') WHERE conversation_id=$1",[olderConversationIds.at(-1),21-index]);
    }
    const firstConversationPage=await call("client-one","conversations.list",{limit:20});
    expect(firstConversationPage.statusCode,firstConversationPage.body).toBe(200);
    expect(firstConversationPage.json().conversations).toHaveLength(20);
    expect(firstConversationPage.json().nextCursor).toEqual(expect.any(String));
    const secondConversationPage=await call("client-one","conversations.list",{limit:20,cursor:firstConversationPage.json().nextCursor});
    expect(secondConversationPage.statusCode,secondConversationPage.body).toBe(200);
    expect(secondConversationPage.json().conversations.map((item:any)=>item.id)).toEqual([olderConversationIds[0]]);
    for(let index=3;index<=21;index++){
      const next=await call("client-one","turns.submit",{conversationId,text:`History page turn ${index}`});
      expect(next.statusCode,next.body).toBe(200);
      const historyTask=next.json().task,historyOperation=`cursor-fixture:${historyTask.id}`;
      const started=await beginOperation(pool,historyTask.id,{id:historyOperation,kind:"tool",name:"cursor fixture",request:{},reservedTokens:0,reservedMs:1000,retrySafe:true});
      await finishOperation(pool,historyTask.id,historyOperation,"completed",{fixture:true},null,0,started.operation.attempt_id);
      await settleTask(pool,historyTask.id,{state:"completed",output:`History page response ${index}`});
    }
    const firstHistoryPage=await call("client-one","conversations.get",{conversationId,limit:20});
    expect(firstHistoryPage.statusCode,firstHistoryPage.body).toBe(200);
    expect(firstHistoryPage.json().tasks).toHaveLength(20);
    expect(firstHistoryPage.json().nextCursor).toEqual(expect.any(String));
    const secondHistoryPage=await call("client-one","conversations.get",{conversationId,limit:20,cursor:firstHistoryPage.json().nextCursor});
    expect(secondHistoryPage.statusCode,secondHistoryPage.body).toBe(200);
    expect(secondHistoryPage.json().tasks).toMatchObject([{id:task.id,output:"Support is active."}]);
    expect(firstHistoryPage.json().tasks.some((item:any)=>item.id===task.id)).toBe(false);
    let browserExpect:any;
    if(process.env.AGENTS_AGENCY_BROWSER==="1"){
      const assets=process.env.AGENCY_BROWSER_ASSET_ROOT;if(!assets)throw Error("AGENCY_BROWSER_ASSET_ROOT must identify the built Agency frontend");
      const {createPortalServer}=await import("../../../agency/web/scripts/serve.mjs");
      browserPortal=createPortalServer({directory:resolve(assets),target:new URL(agencyOrigin)});
      await new Promise<void>(resolve=>browserPortal!.listen(0,"127.0.0.1",resolve));
      const browserOrigin="http://127.0.0.1:"+(browserPortal.address() as {port:number}).port;
      const playwright=createRequire(__filename)("../../web/node_modules/@playwright/test");browserExpect=playwright.expect;
      browser=await playwright.chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000}});
      await context.addCookies([{name:agencyConfig.session_cookie_name,value:session,url:browserOrigin,httpOnly:true,sameSite:"Lax"}]);
      page=await context.newPage();page.setDefaultTimeout(7000);await page.addInitScript(()=>localStorage.setItem("kasitek.agency.selected-workspace-slug","agency"));
      // Identity and the displayed child are controlled browser fixtures. Parent tasks and page
      // reads still use signed product ingress and current native Agency authorization. This
      // checks modal behavior; the separate live-user run covers real delegation.
      await page.route("**/api/tenant/api/auth/session",(route:any)=>route.fulfill({json:{audience:"tenant",user:{id:"agency-user",workspaceId,workspaceSlug:"agency",email:"owner@example.test",roles:["support"],agencyPartner:false}}}));
      const childId=randomUUID(),child={id:childId,name:"Research",state:"completed",assignment:"Controlled inspection assignment"};
      let observedRootId=task.id;
      let rejectMemoryList=false,rootState:string|null="waiting_authority";
      const continuationRequests:string[]=[],operationPages:string[]=[];
      const operation=(id:string,label:string)=>({id,taskId:observedRootId,kind:"tool",label,state:"completed",startedAt:new Date().toISOString(),durationMs:10,errorCode:null});
      await page.route("**/api/tenant/api/clients/client-one/agent/commands",async(route:any)=>{
        try{
          const body=route.request().postDataJSON(),childRead=body.operation==="tasks.observe"&&body.input.childTaskId===childId;
          if(body.operation==="tasks.continue"){
            continuationRequests.push(body.requestId);
            if(continuationRequests.length===1)return await route.fulfill({status:503,json:{error:"Temporary continuation failure"}});
            rootState="working";return await route.fulfill({json:{accepted:true,taskId:observedRootId}});
          }
          if(rejectMemoryList&&body.operation==="memory.list")return await route.fulfill({status:403,json:{message:"Memory unavailable"}});
          const operationCursor=body.operation==="tasks.observe"?body.input.operationCursor:undefined;
          if(operationCursor)operationPages.push(operationCursor);
          const response=await route.fetch(childRead||operationCursor?{postData:JSON.stringify({...body,input:{taskId:childRead?observedRootId:body.input.taskId}})}:undefined);
          if(!response.ok())return await route.fulfill({response});
          const value=await response.json();
          if(body.operation==="tasks.observe"){
            const prefix=childRead?"child":"root";
            value.operations=operationCursor?[operation(prefix+"-old",`Earlier ${prefix} operation`),operation(prefix+"-new",`Recent ${prefix} operation`)]:[operation(prefix+"-new",`Recent ${prefix} operation`)];
            value.nextOperationCursor=operationCursor?null:`older-${prefix}`;
            if(childRead)return await route.fulfill({response,json:{...value,agentName:"Research",task:{...value.task,id:childId,input:child.assignment,output:"Controlled child finding.",children:[]}}});
            if(rootState)value.task={...value.task,state:rootState,canSteer:rootState==="working",canContinue:rootState==="waiting_authority"};
            observedRootId=value.task.id;
            value.task.children=[child];
          }
          if(body.operation==="conversations.get"){
            value.tasks=value.tasks.map((item:any)=>({...item,children:[child]}));
          }
          return await route.fulfill({response,json:value});
        }catch{
          try{await route.abort("failed");}catch{}
        }
      });
      const second=await call("client-one","memory.propose",{kind:"semantic",content:"Controlled briefing preference."});expect(second.statusCode,second.body).toBe(200);
      await page.goto(`${browserOrigin}/clients/client-one/agent?conversation=${conversationId}`);
      await browserExpect(page.getByText("History page response 21",{exact:true})).toBeVisible();
      const composer=page.getByRole("textbox",{name:"Message",exact:true});
      await browserExpect(page.getByRole("button",{name:"Continue",exact:true})).toBeVisible();
      await browserExpect(composer).toBeDisabled();
      await page.getByRole("button",{name:"Continue",exact:true}).click();
      await browserExpect(page.getByRole("alert").filter({hasText:"Temporary continuation failure"})).toBeVisible();
      await page.getByRole("button",{name:"Continue",exact:true}).click();
      await browserExpect(page.getByRole("textbox",{name:"Update instructions",exact:true})).toBeEnabled();
      expect(continuationRequests).toHaveLength(2);expect(continuationRequests[0]).toBe(continuationRequests[1]);
      rootState="cancel_requested";
      await browserExpect(page.getByRole("button",{name:"Stopping…",exact:true})).toBeVisible();
      await browserExpect(composer).toBeDisabled();
      rootState=null;
      await browserExpect(page.getByRole("button",{name:"Stopping…",exact:true})).toHaveCount(0);
      const rootActivity=page.locator(`[data-task-id="${observedRootId}"]`);
      await rootActivity.getByRole("button",{name:/Activity/}).click();
      await rootActivity.getByRole("button",{name:"Earlier activity",exact:true}).click();
      await browserExpect(rootActivity.getByText("Earlier root operation",{exact:true})).toBeVisible();
      await browserExpect(rootActivity.getByText("Recent root operation",{exact:true})).toHaveCount(1);
      expect(operationPages).toContain("older-root");
      await browserExpect(page.getByRole("button",{name:"Earlier messages",exact:true})).toBeVisible();
      await page.getByRole("button",{name:"Earlier messages",exact:true}).click();
      await browserExpect(page.getByRole("button",{name:"Refresh history",exact:true})).toBeVisible();
      await browserExpect(page.locator('article[data-role="user"]').filter({hasText:"Which agents are active for this client?"})).toBeVisible();
      await browserExpect(page.getByRole("button",{name:"Older conversations",exact:true})).toBeVisible();
      await page.getByRole("button",{name:"Older conversations",exact:true}).click();
      await browserExpect(page.getByRole("button",{name:"Older page conversation",exact:true})).toBeVisible();
      await page.getByRole("button",{name:"Memory",exact:true}).click();
      await page.getByRole("button",{name:"Review",exact:true}).click();
      await page.getByRole("combobox",{name:"Applies to"}).click();await page.getByRole("option",{name:"Hypothetical scenario",exact:true}).click();
      await page.getByRole("combobox",{name:"Conflicts",exact:true}).click();await page.getByRole("option",{name:"Conflict reported",exact:true}).click();
      await page.getByRole("button",{name:"Accept",exact:true}).click();
      await browserExpect(page.getByText("Memory accepted",{exact:true})).toBeVisible();
      const acceptedThroughUi=(await call("client-one","memory.list")).json().memories.find((item:any)=>item.id===second.json().id);
      expect(acceptedThroughUi).toMatchObject({revision:2,assertion:{context:"hypothetical",conflict:"reported"},verified:false});
      await page.getByRole("button",{name:"Correct",exact:true}).click();
      await browserExpect(page.getByRole("textbox",{name:"Memory",exact:true})).toHaveValue("Controlled briefing preference.");
      rejectMemoryList=true;
      await browserExpect(page.getByRole("textbox",{name:"Memory",exact:true})).toHaveCount(0,{timeout:9000});
      await browserExpect(page.getByText("Controlled briefing preference.",{exact:true})).toHaveCount(0);
      await browserExpect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
      rejectMemoryList=false;
      await browserExpect(page.getByRole("button",{name:"Correct",exact:true})).toBeVisible({timeout:9000});
      await page.getByRole("button",{name:"Correct",exact:true}).click();
      expect((await call("client-one","memory.mutate",{memoryId:second.json().id,expectedRevision:2,action:"forget"})).statusCode).toBe(200);
      await browserExpect(page.getByRole("textbox",{name:"Memory",exact:true})).toHaveCount(0,{timeout:9000});
      await browserExpect(page.getByText("Controlled briefing preference.",{exact:true})).toHaveCount(0);
      await browserExpect(page.getByText("No memories yet",{exact:true})).toBeVisible();
      await page.keyboard.press("Escape");
      await browserExpect(page.getByRole("dialog")).toHaveCount(0);
      if(await rootActivity.getByRole("button",{name:/^Activity/}).getAttribute("aria-expanded")!=="true")await rootActivity.getByRole("button",{name:/^Activity/}).click();
      await rootActivity.getByRole("button",{name:/Research/}).click();
      await browserExpect(page.getByRole("dialog").getByText("Controlled child finding.",{exact:true})).toBeVisible();
      await page.getByRole("dialog").getByRole("button",{name:/Activity/}).click();
      await page.getByRole("dialog").getByRole("button",{name:"Earlier activity",exact:true}).click();
      await browserExpect(page.getByRole("dialog").getByText("Earlier child operation",{exact:true})).toBeVisible();
      await browserExpect(page.getByRole("dialog").getByText("Recent child operation",{exact:true})).toHaveCount(1);
      expect(operationPages).toContain("older-child");
      await page.setViewportSize({width:390,height:844});
      await mkdir(resolve("../../../.audit/shared-agent-ui/agency-authority"),{recursive:true});
      await page.screenshot({path:resolve("../../../.audit/shared-agent-ui/agency-authority/before-revocation.png")});
    }
    await agency.query("UPDATE tenant_client_assignments SET status='revoked',revoked_at=now() WHERE id='assign-one'");
    expect((await call("client-one","tasks.observe",{taskId:task.id})).statusCode).toBe(403);
    expect((await app.inject({method:"GET",url:downloadUrl,headers})).statusCode).toBe(403);
    if(page){
      await browserExpect(page.getByText("History page response 21",{exact:true})).toHaveCount(0,{timeout:9000});
      await browserExpect(page.getByText("Controlled child finding.",{exact:true})).toHaveCount(0);
      await browserExpect(page.getByText("Earlier root operation",{exact:true})).toHaveCount(0);
      await browserExpect(page.getByText("Earlier child operation",{exact:true})).toHaveCount(0);
      await browserExpect(page.getByRole("dialog")).toBeVisible();
      await page.screenshot({path:resolve("../../../.audit/shared-agent-ui/agency-authority/after-revocation.png")});
      await agency.query("UPDATE tenant_client_assignments SET status='active',revoked_at=NULL WHERE id='assign-one'");
      await browserExpect(page.getByRole("dialog").getByText("Controlled child finding.",{exact:true})).toBeVisible({timeout:15000});
      await browserExpect(page.getByText("History page response 21",{exact:true})).toHaveCount(1);
    }
    expect((await call("client-two","readiness.get")).statusCode).toBe(200);
  },process.env.AGENTS_AGENCY_BROWSER==="1"?60000:30000);
});
