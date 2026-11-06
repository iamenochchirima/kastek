import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { Pool } from "pg";
import type { GrowthAgentPublication, ProductCapabilityDescriptor } from "@kasitek-labs/contracts";
import { GrowthProductRuntime } from "../src/execution/products/growth-runtime";
import { growthContentReadAdapterManifest, growthReferenceAdapterManifest } from "../src/adapters/products/growth-capability-manifests";
import { growthFeatureConfiguration, validateGrowthPublication } from "../src/product/integrations/growth-features";
import { rolloutGrowthConnectionBindings, rolloutGrowthConnectionBindingsForTarget } from "../src/product/integrations/growth-runtime-binding-rollout";
import { orchestrationTools } from "../src/contracts/orchestration";
import { capabilityBindingSchema, createModelAlias } from "../src/contracts/capability-catalog";
import { requestDigest } from "../src/contracts/contracts";
import { growthConnectedPins } from "../src/product/integrations/growth-connected-pins";
import { growthAgentPublication as currentGrowthAgentPublication } from "../../../growth/api/src/agents/manifest";

const adminUrl=process.env.AGENTS_TEST_ADMIN_URL;
const descriptor: ProductCapabilityDescriptor={operation:"connections.list",revision:"1",description:"List connections",inputSchema:{type:"object",properties:{}},outputSchema:null,handlerRef:"growth.operation.connections.list@1",requiredAuthority:["feature.agents.manage"],evidence:"none",policy:{effect:"read",disclosure:"approved_resource_identifiers",retry:"safe_read",approval:"none",cancel:"stop_admission"},limits:{timeoutMs:10000,maxPhysicalAttempts:1,maxResponseBytes:131072,maxModelResultBytes:8192}};
function fixturePublication(revision:string,adapter:typeof growthContentReadAdapterManifest):GrowthAgentPublication {
  const body={schemaVersion:1 as const,product:"growth",revision,adapter:{id:adapter.id,release:adapter.release,manifestDigest:requestDigest(adapter)},operations:[descriptor]};
  return {manifest:{...body,digest:requestDigest(body)},presets:(["assistant","research","content","campaigns"] as const).map(id=>({id,name:id,description:id,instructions:"Fixture",operations:[descriptor.operation]})),policy:{revision,optionalCapabilities:{knowledge:false,skills:false,memory:false,delegation:false,sandbox:false,workflows:false,connections:false}}};
}
const growthAgentPublicationV12=fixturePublication("12",growthContentReadAdapterManifest),growthAgentPublicationV14=fixturePublication("14",growthReferenceAdapterManifest);

describe("Growth runtime binding rollout target",()=>{
  it("recognizes only the exact reviewed revision-14 publication",async()=>{
    const query=vi.fn(async()=>({rows:[]}));
    const client={query} as unknown as import("pg").PoolClient;
    expect(await rolloutGrowthConnectionBindings(client,"tenant","organization",currentGrowthAgentPublication)).toBe(0);
    expect(query).toHaveBeenCalledTimes(1);
    const changed={...currentGrowthAgentPublication,manifest:{...currentGrowthAgentPublication.manifest,digest:"0".repeat(64)}};
    expect(await rolloutGrowthConnectionBindings(client,"tenant","organization",changed)).toBe(0);
    expect(query).toHaveBeenCalledTimes(1);
  });
});

(adminUrl ? describe : describe.skip)("Growth binding rollout against PostgreSQL",()=>{
  const database="growth_binding_"+randomUUID().replaceAll("-","");
  let admin:Pool,pool:Pool;
  beforeAll(async()=>{
    admin=new Pool({connectionString:adminUrl}); await admin.query(`CREATE DATABASE "${database}"`);
    const url=new URL(adminUrl!); url.pathname="/"+database; pool=new Pool({connectionString:url.toString()});
    await pool.query(`CREATE SCHEMA agents_platform;
      CREATE TABLE agents_platform.agents (id uuid PRIMARY KEY,organization_id uuid NOT NULL,draft jsonb NOT NULL,draft_revision integer NOT NULL DEFAULT 1,updated_at timestamptz DEFAULT now(),deleted_at timestamptz);
      CREATE TABLE agents_platform.agent_versions (id uuid PRIMARY KEY,organization_id uuid NOT NULL,agent_id uuid NOT NULL,number integer NOT NULL,draft_revision integer NOT NULL,execution_kind text NOT NULL,configuration jsonb NOT NULL,created_by uuid,created_by_service jsonb,tool_bindings jsonb,effective_composition jsonb,runtime_derived_from uuid REFERENCES agents_platform.agent_versions(id),UNIQUE(agent_id,number));
      CREATE UNIQUE INDEX agent_version_draft_unique ON agents_platform.agent_versions(agent_id,draft_revision) WHERE runtime_derived_from IS NULL;
      CREATE TABLE agents_platform.product_execution_features(product text NOT NULL,tenant_id text NOT NULL,feature_id text NOT NULL,organization_id uuid NOT NULL,agent_id uuid NOT NULL,version_id uuid NOT NULL,revision integer NOT NULL,enabled boolean NOT NULL,managed_configuration_digest text,managed_capability_baseline jsonb,updated_at timestamptz DEFAULT now(),PRIMARY KEY(product,tenant_id,feature_id));
      CREATE TABLE agents_platform.growth_capability_publications(tenant_id text NOT NULL,revision text NOT NULL,publication jsonb NOT NULL);
      CREATE TABLE agents_platform.version_sources(organization_id uuid,version_id uuid,source_id uuid,revision_id uuid);
      CREATE TABLE agents_platform.capability_bindings(organization_id uuid,id uuid,alias text,binding jsonb);
      CREATE TABLE agents_platform.version_connected_tools(organization_id uuid,version_id uuid,binding_id uuid);
      CREATE TABLE agents_platform.tasks(id uuid PRIMARY KEY,version_id uuid NOT NULL);`);
    new GrowthProductRuntime(pool,{invoke:async()=>{throw new Error("not called");}} as never);
      validateGrowthPublication(growthAgentPublicationV12);validateGrowthPublication(growthAgentPublicationV14);
  });
  afterAll(async()=>{await pool?.end(); if(admin){await admin.query(`DROP DATABASE IF EXISTS "${database}"`);await admin.end();}});
  it("clones a published binding once, preserves drafts and accepted tasks, and defers an unsupported root",async()=>{
    const org=randomUUID(),tenant=randomUUID(),agent=randomUUID(),version=randomUUID(),task=randomUUID(),source=randomUUID(),revision=randomUUID();
    const configuration=growthFeatureConfiguration(growthAgentPublicationV12,"content",org,tenant),goodChildVersion=randomUUID();
    const connectedId=randomUUID(), connectionId=randomUUID(), sample=configuration.productBindings[0]!;
    const {authority:_authority,digest:_digest,...prior}=sample;
    const {product:_product,...definition}=sample.definition;
    const connectedContent={...prior,id:connectedId,alias:createModelAlias(connectedId),definition:{...definition,providerOperation:"get_repository"},
      connection:{id:connectionId,profileId:"github-public-read-v1",policyRevision:1},resources:[{kind:"github.repository",id:"approved/repo"}],
      policy:{effect:"read" as const,disclosure:"public_identifiers" as const,retry:"safe_read" as const,approval:"none" as const,cancel:"stop_admission" as const}};
    const connected=capabilityBindingSchema.parse({...connectedContent,digest:requestDigest(connectedContent)});
    configuration.connectedToolBindingIds=[connectedId];
    configuration.program={id:"tool-directed",version:"4"};configuration.tools=[...new Set([...configuration.tools,...orchestrationTools])];
    configuration.capabilities.delegation={enabled:true,maxChildren:1,maxDepth:1,policy:{maxTasks:null,maxStalls:3},bindings:[{id:"custom-child",versionId:goodChildVersion,sourceRevisionIds:[],connectedToolBindingIds:[],tools:[],maxTokens:2048,maxActiveMs:1000}]};
    const draft={...configuration,instructions:"Unsaved custom draft"};
    const otherAgent=randomUUID(),otherVersion=randomUUID(),otherParent=structuredClone(configuration);otherParent.connectedToolBindingIds=[];
    const unsupported=growthFeatureConfiguration(growthAgentPublicationV12,"research",org,tenant),badAgent=randomUUID(),badVersion=randomUUID();
    unsupported.program={id:"tool-directed",version:"4"};unsupported.tools=[...new Set([...unsupported.tools,...orchestrationTools])];
    unsupported.capabilities.delegation={enabled:true,maxChildren:1,maxDepth:1,policy:{maxTasks:null,maxStalls:3},bindings:[{id:"missing",versionId:randomUUID(),sourceRevisionIds:[],connectedToolBindingIds:[],tools:[],maxTokens:2048,maxActiveMs:1000}]};
    await pool.query("INSERT INTO agents_platform.agents(id,organization_id,draft) VALUES($1,$2,$3),($4,$2,$5)",[agent,org,draft,badAgent,unsupported]);
    await pool.query("INSERT INTO agents_platform.agents(id,organization_id,draft) VALUES($1,$2,$3)",[otherAgent,org,otherParent]);
    await pool.query("INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,draft_revision,execution_kind,configuration) VALUES($1,$2,$3,1,1,'business',$4),($5,$2,$6,1,1,'business',$7)",[version,org,agent,configuration,badVersion,badAgent,unsupported]);
    const goodChild=growthFeatureConfiguration(growthAgentPublicationV12,"research",org,tenant);
    await pool.query("INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,draft_revision,execution_kind,configuration) VALUES($1,$2,$3,2,2,'business',$4)",[goodChildVersion,org,badAgent,goodChild]);
    await pool.query("INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,draft_revision,execution_kind,configuration) VALUES($1,$2,$3,1,1,'business',$4)",[otherVersion,org,otherAgent,otherParent]);
    await pool.query("INSERT INTO agents_platform.product_execution_features(product,tenant_id,feature_id,organization_id,agent_id,version_id,revision,enabled) VALUES('growth',$1,'content',$2,$3,$4,1,true),('growth',$1,'research',$2,$5,$6,1,true)",[tenant,org,agent,version,badAgent,badVersion]);
    await pool.query("INSERT INTO agents_platform.product_execution_features(product,tenant_id,feature_id,organization_id,agent_id,version_id,revision,enabled) VALUES('growth',$1,'assistant',$2,$3,$4,1,true)",[tenant,org,otherAgent,otherVersion]);
    await pool.query("INSERT INTO agents_platform.growth_capability_publications VALUES($1,'12',$2)",[tenant,growthAgentPublicationV12]);
    await pool.query("INSERT INTO agents_platform.version_sources VALUES($1,$2,$3,$4)",[org,version,source,revision]);
    await pool.query("INSERT INTO agents_platform.capability_bindings VALUES($1,$2,$3,$4)",[org,connectedId,connected.alias,connected]);
    await pool.query("INSERT INTO agents_platform.version_connected_tools VALUES($1,$2,$3)",[org,version,connectedId]);
    await pool.query("INSERT INTO agents_platform.tasks VALUES($1,$2)",[task,version]);
    const client=await pool.connect();
    try {
      await client.query("BEGIN");
      expect(await rolloutGrowthConnectionBindingsForTarget(client,tenant,org,growthAgentPublicationV14)).toBe(3);
      expect(await rolloutGrowthConnectionBindingsForTarget(client,tenant,org,growthAgentPublicationV14)).toBe(0);
      await client.query("COMMIT");
    } finally {client.release();}
    const feature=(await pool.query("SELECT version_id FROM agents_platform.product_execution_features WHERE feature_id='content'")).rows[0];
    expect(feature.version_id).not.toBe(version);
    expect((await pool.query("SELECT draft FROM agents_platform.agents WHERE id=$1",[agent])).rows[0].draft).toEqual(draft);
    expect((await pool.query("SELECT version_id FROM agents_platform.tasks WHERE id=$1",[task])).rows[0].version_id).toBe(version);
    expect((await pool.query("SELECT count(*)::int AS count FROM agents_platform.version_sources WHERE version_id=$1",[feature.version_id])).rows[0].count).toBe(1);
    expect((await pool.query("SELECT version_id FROM agents_platform.product_execution_features WHERE feature_id='research'")).rows[0].version_id).toBe(badVersion);
    expect((await pool.query("SELECT revision FROM agents_platform.product_execution_features WHERE feature_id='research'")).rows[0].revision).toBe(3);
    const parent=(await pool.query("SELECT configuration FROM agents_platform.agent_versions WHERE id=$1",[feature.version_id])).rows[0].configuration;
    expect(parent.capabilities.delegation.bindings[0].versionId).not.toBe(goodChildVersion);
    const other=(await pool.query("SELECT v.configuration FROM agents_platform.product_execution_features f JOIN agents_platform.agent_versions v ON v.id=f.version_id WHERE f.feature_id='assistant'")).rows[0].configuration;
    expect(other.capabilities.delegation.bindings[0].versionId).toBe(parent.capabilities.delegation.bindings[0].versionId);
    expect(parent.connectedToolBindingIds).toEqual([connectedId]);
    expect((await pool.query("SELECT effective_composition FROM agents_platform.agent_versions WHERE id=$1",[feature.version_id])).rows[0].effective_composition.connectedBindings).toEqual([{id:connectedId,digest:connected.digest}]);
    const pinsClient=await pool.connect();
    try {
      expect((await growthConnectedPins(pinsClient,org,feature.version_id,parent)).direct.map(binding=>binding.id)).toEqual([connectedId]);
      await expect(growthConnectedPins(pinsClient,org,feature.version_id,{...parent,connectedToolBindingIds:[connectedId,randomUUID()]})).rejects.toMatchObject({code:"PRODUCT_CAPABILITY_UNAVAILABLE"});
    } finally {pinsClient.release();}
  });
});
