import {dropClosedTestDatabase} from "./support/database-cleanup";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import Fastify from "fastify";
import { afterAll,beforeAll,describe,expect,it } from "vitest";
import { modelControls,validateGeneration,applyGeneration,generationSdkOptions } from "../src/adapters/models/model-controls";
import type { ModelDescriptor } from "../src/contracts/model-providers";
import { defaultBusinessConfiguration,requestDigest } from "../src/contracts/contracts";
import { registerModelPolicyRoutes } from "../src/product/model-providers/model-policy";
import { PlatformStore } from "../src/product/agents/store";
import { setupPlatformSchema } from "../src/composition/setup";
import { connectFixtureModel } from "./model-fixture";
import { loadExecution } from "../src/execution/lifecycle/execution";

const source={kind:"official" as const,reference:"controlled-model-metadata",observedAt:"2026-10-21T00:00:00.000Z"};
function descriptor(providerId:string,id:string,protocol:ModelDescriptor["protocol"]):ModelDescriptor {
 return {providerId,id,protocol,name:id,revision:"fixture",contextTokens:{value:262144,source},maxInputTokens:{value:null,source:null},maxOutputTokens:{value:32768,source},
  capabilities:{tools:{value:true,evidence:"verified",source},reasoning:{value:true,evidence:"discovered",source},structuredOutput:{value:null,evidence:"unknown",source:null}},inputModalities:["text"],outputModalities:["text"],pricing:null,lifecycle:"active"};
}
describe("reviewed model generation controls",()=>{
 it("keeps effort choices model-specific and hides unknown compatibility",()=>{
  const model=descriptor("openai","gpt-5.1","openai_responses"),policy={maxOutputTokens:4096};
  expect(modelControls(model,policy,"https://api.openai.com/v1").reasoning?.values).toEqual(["none","low","medium","high"]);
  expect(modelControls({...model,id:"gpt-5-pro"},policy,"https://api.openai.com/v1").reasoning).toBeNull();
  expect(modelControls(model,policy,"https://private.example/v1").reasoning).toBeNull();
  expect(()=>validateGeneration(model,policy,"https://api.openai.com/v1",{reasoning:{kind:"effort",value:"max"}})).toThrow("MODEL_REASONING_CONFIGURATION_INVALID");
 });
 it("enforces sourced manual-thinking ranges within the actual reply allowance",()=>{
  const model=descriptor("anthropic","claude-sonnet-4-5","anthropic_messages"),policy={maxOutputTokens:4096},endpoint="https://api.anthropic.com/v1";
  expect(modelControls(model,policy,endpoint).reasoning).toMatchObject({kind:"budget",minTokens:1024,maxTokens:4095});
  for(const tokens of [1023,4096]) expect(()=>validateGeneration(model,policy,endpoint,{reasoning:{kind:"budget",tokens}})).toThrow();
  const settings=validateGeneration(model,policy,endpoint,{reasoning:{kind:"budget",tokens:2048}}),payload:Record<string,unknown>={max_tokens:4096};
  applyGeneration(model,policy,endpoint,settings,payload);expect(payload).toMatchObject({thinking:{type:"enabled",budget_tokens:2048},max_tokens:4096});
  expect(generationSdkOptions(model,endpoint,settings)).toEqual({thinkingEnabled:true,thinkingBudgetTokens:2048});
 });
 it("does not substitute a new mode for provider defaults and retains encrypted continuity",()=>{
  const payload:Record<string,unknown>={reasoning:{effort:"none"},include:[]};
  applyGeneration(descriptor("openai","gpt-5.1","openai_responses"),{maxOutputTokens:4096},"https://api.openai.com/v1",{},payload);
  expect(payload).not.toHaveProperty("reasoning");expect(payload.include).toEqual(["reasoning.encrypted_content"]);
 });
 it("maps Gemini budgets and levels independently and keeps thought text private",()=>{
  const endpoint="https://generativelanguage.googleapis.com/v1beta",policy={maxOutputTokens:4096},payload:Record<string,unknown>={generationConfig:{maxOutputTokens:4096}};
  applyGeneration(descriptor("google","gemini-2.5-pro","google_generate_content"),policy,endpoint,{reasoning:{kind:"budget",tokens:1024},temperature:0.5},payload);
  expect(payload).toMatchObject({generationConfig:{maxOutputTokens:4096,temperature:0.5,thinkingConfig:{thinkingBudget:1024,includeThoughts:false}}});
  applyGeneration(descriptor("google","gemini-3-pro-preview","google_generate_content"),policy,endpoint,{reasoning:{kind:"level",value:"high"}},payload);
  expect(payload).toMatchObject({generationConfig:{thinkingConfig:{thinkingLevel:"HIGH",includeThoughts:false}}});
  expect(()=>validateGeneration(descriptor("google","gemini-2.5-pro","google_generate_content"),policy,endpoint,{reasoning:{kind:"budget",tokens:0}})).toThrow();
 });
});
const databaseUrl=process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip)("model policy preview with real PostgreSQL",()=>{
 const database=`agents_model_controls_${randomUUID().replaceAll("-","")}`;let admin:Pool,pool:Pool,platform:PlatformStore;
 beforeAll(async()=>{admin=new Pool({connectionString:databaseUrl});await admin.query(`CREATE DATABASE "${database}"`);const url=new URL(databaseUrl!);url.pathname=`/${database}`;pool=new Pool({connectionString:url.href});await setupPlatformSchema(pool);platform=new PlatformStore(pool);});
 afterAll(async()=>{await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}});
 async function fixture(){
  const account=await platform.ensureAccount({issuer:"https://identity.example",subject:randomUUID(),email:"owner@example.test",displayName:"Owner"}),org=await platform.createOrganization(account.id,"Controls");
  const provider=await connectFixtureModel(pool,account.id,org.id,"fixture/reasoning",["tools","reasoning"]),configuration=defaultBusinessConfiguration();
  configuration.model.generation={reasoning:{kind:"effort",value:"high"}};
  const {agent,snapshot}=await platform.createConfiguredAgent({accountId:account.id,organizationId:org.id,name:"Agent",configuration});
  const app=Fastify();registerModelPolicyRoutes(app,{store:provider.store,resolveScope:async()=>provider.scope});
  return{account,org,provider,configuration,agent,snapshot,app};
 }
 it("derives preview limits and errors without inference or authority changes",async()=>{
  const f=await fixture();try{
   const path=`/api/organizations/${f.org.id}/agents/${f.agent.id}/model-policy`,preview=await f.app.inject({method:"POST",url:path,payload:{configuration:f.configuration}});
   expect(preview.statusCode).toBe(200);const body=preview.json();expect(body.errors).toEqual([]);expect(body.controls.reasoning).toMatchObject({kind:"effort",values:["low","medium","high"]});
   expect(body.limits).toMatchObject({maxRootTokens:null,maxOutputTokens:32768,maxCallDurationMs:120000});
   const bad=structuredClone(f.configuration);bad.context.compactAtTokens=bad.context.maxInputTokens;
   const invalid=await f.app.inject({method:"POST",url:path,payload:{configuration:bad}});expect(invalid.statusCode).toBe(200);expect(invalid.json().errors.some((error:{field:string})=>error.field==="context.compactAtTokens")).toBe(true);
   expect((await pool.query("SELECT id FROM agents_platform.tasks WHERE organization_id=$1",[f.org.id])).rowCount).toBe(0);
  }finally{await f.app.close();}
 });
 it("pins generation settings and rejects invalid settings before task admission",async()=>{
  const f=await fixture();try{
   const authority={product:"agents" as const,organizationId:f.org.id,resourceId:f.agent.id,callerClientId:"agents-execution",principal:{kind:"human" as const,issuer:f.account.issuer,subject:f.account.subject}};
   const grant=await platform.createGrant({accountId:f.account.id,grant:{...authority,id:randomUUID(),versionId:f.snapshot.id,operations:["model.reply"],sourceRevisionIds:[],connectedToolBindingIds:[],maxInputBytes:16384,maxOutputTokens:4096,maxContextTokens:8192,rootTokenLimit:32000,expiresAt:new Date(Date.now()+600000).toISOString(),revokedAt:null}});
   const result=await platform.admitTask({authority,grantId:grant.id,versionId:f.snapshot.id,requestKey:randomUUID(),input:"Hello"}),execution=await loadExecution(pool,result.task.id);
   expect(execution.models.primary.generation).toEqual(f.configuration.model.generation);
   expect(execution.models.primary.binding.generationDigest).toBe(requestDigest({generation:execution.models.primary.generation,revision:execution.models.primary.generationRevision}));
   const unsupported={...f.configuration,model:{...f.configuration.model,generation:{reasoning:{kind:"effort" as const,value:"max"}}}};
   const bad=await platform.createConfiguredAgent({accountId:f.account.id,organizationId:f.org.id,name:"Invalid",configuration:unsupported});
   const badAuthority={...authority,resourceId:bad.agent.id},badGrant=await platform.createGrant({accountId:f.account.id,grant:{...grant,id:randomUUID(),...badAuthority,versionId:bad.snapshot.id}});
   await expect(platform.admitTask({authority:badAuthority,grantId:badGrant.id,versionId:bad.snapshot.id,requestKey:randomUUID(),input:"Hello"})).rejects.toMatchObject({code:"MODEL_REASONING_CONFIGURATION_INVALID"});
  }finally{await f.app.close();}
 });
});
