import { contextGrantCeiling } from "../src/execution/models/settings";
import {dropClosedTestDatabase} from "./support/database-cleanup";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { beforeAll,afterAll,describe,it,expect } from "vitest";
import { PlatformStore } from "../src/product/agents/store";
import { setupPlatformSchema } from "../src/composition/setup";
import { defaultBusinessConfiguration, requestDigest } from "../src/contracts/contracts";
import { resolveProgram } from "../src/execution/programs/composition";
import { compilePublishedComposition } from "../src/execution/programs/publication";
import { publishedToolBindings } from "../src/capabilities/tool-definitions";
const databaseUrl=process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip)("configuration saves with real PostgreSQL",()=>{
 const database=`agents_configuration_${randomUUID().replaceAll("-","")}`;let admin:Pool,pool:Pool,store:PlatformStore;
 beforeAll(async()=>{admin=new Pool({connectionString:databaseUrl});await admin.query(`CREATE DATABASE "${database}"`);const url=new URL(databaseUrl!);url.pathname=`/${database}`;pool=new Pool({connectionString:url.href});await setupPlatformSchema(pool);store=new PlatformStore(pool);});
 afterAll(async()=>{await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}});
 async function fixture(){const account=await store.ensureAccount({issuer:"http://configuration.fixture.test",subject:randomUUID(),email:"owner@example.test",displayName:"Owner"});const org=await store.createOrganization(account.id,"Configuration tests");const scope={accountId:account.id,organizationId:org.id};const configuration=defaultBusinessConfiguration();const created=await store.createConfiguredAgent({...scope,name:"Assistant",configuration});return {...scope,...created,configuration,account,agentId:created.agent.id,expectedRevision:1};}
 it("creates a ready snapshot and deduplicates unchanged saves and renames",async()=>{const f=await fixture();expect(f.snapshot.agent_id).toBe(f.agent.id);expect((await store.saveConfiguration(f)).snapshot.id).toBe(f.snapshot.id);const renamed=await store.saveConfiguration({...f,name:"Renamed"});expect(renamed.agent.name).toBe("Renamed");expect(renamed.snapshot.id).toBe(f.snapshot.id);expect(await store.listVersions(f.accountId,f.organizationId,f.agent.id)).toHaveLength(1);});
 it("republishes a known older grounded release without changing the configuration",async()=>{
  const f=await fixture(),configuration={...f.configuration,program:{id:"grounded-conversation" as const,version:"1" as const}};
  const initial=await store.saveConfiguration({...f,configuration,confirmImpact:true});
  const deployment=await store.publishWebsite({...f,versionId:initial.snapshot.id,allowedOrigins:["https://shop.example.test"]});
  const current=initial.snapshot.effective_composition, {digest: _digest,...content}=current;
  const oldProgram={...resolveProgram(configuration.program),allowedTools:["knowledge.search","knowledge.read","channel.request_handoff"]};
  const oldContent={...content,program:{...content.program,digest:requestDigest(oldProgram)}};
  await pool.query("ALTER TABLE agents_platform.agent_versions DISABLE TRIGGER immutable_agent_version");
  try { await pool.query("UPDATE agents_platform.agent_versions SET effective_composition=$2 WHERE id=$1",[initial.snapshot.id,{...oldContent,digest:requestDigest(oldContent)}]); }
  finally { await pool.query("ALTER TABLE agents_platform.agent_versions ENABLE TRIGGER immutable_agent_version"); }
  const saved=await store.saveConfiguration({...f,configuration,expectedRevision:initial.agent.draft_revision});
  expect(saved.snapshot.id).not.toBe(initial.snapshot.id);expect(saved.agent.draft).toEqual(initial.agent.draft);
  expect(saved.deployments[0]?.id).toBe(deployment.id);expect(saved.deployments[0]?.version_id).toBe(saved.snapshot.id);
  expect((await store.saveConfiguration({...f,configuration,expectedRevision:saved.agent.draft_revision})).snapshot.id).toBe(saved.snapshot.id);
 });
 it("republishes an accepted implicit protocol with identical settings and preserves its old pins",async()=>{
  const f=await fixture(),savedConfiguration=f.snapshot.configuration,pins=publishedToolBindings(savedConfiguration,false,new Map()),composition=compilePublishedComposition(savedConfiguration,[],undefined,pins);
  await pool.query("ALTER TABLE agents_platform.agent_versions DISABLE TRIGGER immutable_agent_version");
  try{await pool.query("UPDATE agents_platform.agent_versions SET tool_bindings=$2,effective_composition=$3 WHERE id=$1",[f.snapshot.id,JSON.stringify(pins),composition]);}
  finally{await pool.query("ALTER TABLE agents_platform.agent_versions ENABLE TRIGGER immutable_agent_version");}
  const saved=await store.saveConfiguration(f);
  expect(saved.snapshot.id).not.toBe(f.snapshot.id);expect(saved.agent.draft).toEqual(f.agent.draft);
  expect(saved.snapshot.tool_bindings).toEqual(expect.arrayContaining([expect.objectContaining({name:"tools.discover",version:"3"}),expect.objectContaining({name:"history.read",version:"2"})]));
  const original=(await pool.query("SELECT tool_bindings,effective_composition FROM agents_platform.agent_versions WHERE id=$1",[f.snapshot.id])).rows[0];
  expect(original.tool_bindings).toEqual(pins);expect(original.effective_composition).toEqual(composition);
  expect((await store.saveConfiguration({...f,expectedRevision:saved.agent.draft_revision})).snapshot.id).toBe(saved.snapshot.id);
 });
 it("requires confirmation before authority expansion without mutating draft",async()=>{const f=await fixture(),configuration={...f.configuration,tools:["knowledge.search" as const]};await expect(store.saveConfiguration({...f,configuration})).rejects.toMatchObject({code:"CONFIGURATION_CONFIRMATION_REQUIRED"});expect((await store.getAgent(f.accountId,f.organizationId,f.agentId)).draft_revision).toBe(1);expect((await store.saveConfiguration({...f,configuration,confirmImpact:true})).snapshot.number).toBe(2);});
 it("keeps ordinary work grants valid but revokes them on permission reduction",async()=>{const f=await fixture();const added=await store.saveConfiguration({...f,configuration:{...f.configuration,tools:["knowledge.search"]},confirmImpact:true});const g=await store.createGrant({accountId:f.accountId,grant:{id:randomUUID(),product:"agents",organizationId:f.organizationId,resourceId:f.agentId,callerClientId:"agents-execution",principal:{kind:"human",issuer:f.account.issuer,subject:f.account.subject},versionId:added.snapshot.id,operations:["model.reply","knowledge.read"],sourceRevisionIds:[],connectedToolBindingIds:[],maxInputBytes:f.configuration.model.maxInputBytes,maxOutputTokens:f.configuration.model.maxOutputTokens,maxContextTokens:contextGrantCeiling(f.configuration),rootTokenLimit:20000,expiresAt:new Date(Date.now()+600000).toISOString(),revokedAt:null}});const updated=await store.saveConfiguration({...f,expectedRevision:added.agent.draft_revision,configuration:{...added.agent.draft,instructions:"Updated instructions"}});expect((await pool.query("SELECT revoked_at FROM agents_platform.execution_grants WHERE id=$1",[g.id])).rows[0].revoked_at).toBeNull();expect((await store.createGrant({accountId:f.accountId,grant:{...g,id:randomUUID()}})).versionId).toBe(added.snapshot.id);await store.saveConfiguration({...f,expectedRevision:updated.agent.draft_revision});expect((await pool.query("SELECT revoked_at FROM agents_platform.execution_grants WHERE id=$1",[g.id])).rows[0].revoked_at).not.toBeNull();await expect(store.createGrant({accountId:f.accountId,grant:{...g,id:randomUUID()}})).rejects.toMatchObject({code:"CONFIGURATION_SCOPE_REVOKED"});});
 it("moves stable deployments on confirmed save and rolls back unsafe public configuration",async()=>{const f=await fixture();const d=await store.publishWebsite({...f,versionId:f.snapshot.id,allowedOrigins:["https://shop.example.test"]});const configuration={...f.configuration,instructions:"Answer briefly."};await expect(store.saveConfiguration({...f,configuration})).rejects.toMatchObject({code:"CONFIGURATION_CONFIRMATION_REQUIRED"});const saved=await store.saveConfiguration({...f,configuration,confirmImpact:true});expect(saved.deployments[0]?.id).toBe(d.id);expect(saved.deployments[0]?.version_id).toBe(saved.snapshot.id);await expect(store.saveConfiguration({...f,configuration:{...configuration,memory:{enabled:true}},expectedRevision:saved.agent.draft_revision,confirmImpact:true})).rejects.toMatchObject({code:"PRIVATE_AGENT_CONFIGURATION"});expect((await store.getWebsiteDeployment(d.id)).version_id).toBe(saved.snapshot.id);expect((await store.getAgent(f.accountId,f.organizationId,f.agentId)).draft_revision).toBe(saved.agent.draft_revision);expect(await store.listVersions(f.accountId,f.organizationId,f.agentId)).toHaveLength(2);});
 it("serializes competing saves and rejects stale revisions",async()=>{const f=await fixture();const results=await Promise.allSettled(["A","B"].map(instructions=>store.saveConfiguration({...f,configuration:{...f.configuration,instructions}})));expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(results.filter(r=>r.status==="rejected")).toHaveLength(1);expect(await store.listVersions(f.accountId,f.organizationId,f.agentId)).toHaveLength(2);});
 it("requires confirmation before changing the selected provider route",async()=>{const f=await fixture();const configuration={...f.configuration,model:{...f.configuration.model,selection:{kind:"connection" as const,connectionId:randomUUID(),modelId:"chosen/model"}}};await expect(store.saveConfiguration({...f,configuration})).rejects.toMatchObject({code:"CONFIGURATION_CONFIRMATION_REQUIRED"});expect((await store.getAgent(f.accountId,f.organizationId,f.agentId)).draft_revision).toBe(1);await expect(store.saveConfiguration({...f,configuration,confirmImpact:true})).rejects.toMatchObject({code:"MODEL_CONNECTION_UNAVAILABLE"});expect((await store.getAgent(f.accountId,f.organizationId,f.agentId)).draft_revision).toBe(1);});
 it("publishes the latest configuration without exposing a snapshot selector and grants its exact context budget",async()=>{const f=await fixture();const configuration={...f.configuration,context:{maxInputTokens:4096,compactAtTokens:3072}};const saved=await store.saveConfiguration({...f,configuration});const d=await store.publishCurrentWebsite({...f,allowedOrigins:["https://context.example.test"]});expect(d.version_id).toBe(saved.snapshot.id);const grant=await store.createWebsiteGrant({deploymentId:d.id,origin:"https://context.example.test",sessionId:randomUUID()});expect(grant.maxContextTokens).toBe(4096);});

 it("takes reduction grant locks before deployment locks so a running effect can finish without deadlock",async()=>{
  const f=await fixture();
  const added=await store.saveConfiguration({...f,configuration:{...f.configuration,tools:["knowledge.search"]},confirmImpact:true});
  const deployment=await store.publishCurrentWebsite({...f,allowedOrigins:["https://locks.example.test"]});
  const grant=await store.createWebsiteGrant({deploymentId:deployment.id,origin:"https://locks.example.test",sessionId:randomUUID()});
  const effect=await pool.connect();let save:ReturnType<PlatformStore["saveConfiguration"]>|undefined;
  try{
   await effect.query("BEGIN");await effect.query("SET LOCAL statement_timeout='2s'");await effect.query("SELECT id FROM agents_platform.execution_grants WHERE id=$1 FOR SHARE",[grant.id]);
   save=store.saveConfiguration({...f,expectedRevision:added.agent.draft_revision,configuration:f.configuration,confirmImpact:true});
   for(let attempt=0;attempt<100;attempt++){
    const blocked=(await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT g.id FROM agents_platform.execution_grants g%' ")).rowCount;
    if(blocked)break;
    if(attempt===99)throw new Error("Reduction did not reach its grant lock");
    await new Promise(resolve=>setTimeout(resolve,10));
   }
   await effect.query("SELECT id FROM agents_platform.website_deployments WHERE id=$1 FOR SHARE",[deployment.id]);
   await effect.query("COMMIT");const saved=await save;expect(saved.deployments[0]?.version_id).toBe(saved.snapshot.id);
  }finally{await effect.query("ROLLBACK");effect.release();await save?.catch(()=>{});}
 });

});
