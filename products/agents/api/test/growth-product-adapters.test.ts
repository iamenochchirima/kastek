import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  growthAgentPublicationV3, growthAgentPublicationV4, growthAgentPublicationV5,
  growthAgentPublicationV6, growthAgentPublicationV7, growthAgentPublicationV8, growthAgentPublicationV9, growthAgentPublicationV10, growthAgentPublicationV11, growthAgentPublicationV12, growthAgentPublicationV13, growthAgentPublication,
} from "../../../growth/api/src/agents/manifest";
import type { GrowthActionClient } from "../src/adapters/products/growth-action-client";
import { GrowthProductRuntime } from "../src/execution/products/growth-runtime";
import { delegatedConfiguration } from "../src/execution/delegation/scope";
import { growthDelegationPolicy, growthFeatureConfiguration, growthFeatureProvisionOrder, validateGrowthPublication } from "../src/product/integrations/growth-features";
import { sourceAuthorityIds, type AgentConfiguration } from "../src/contracts/contracts";

describe("installed Growth publication adapters", () => {
  it("loads retained and current owning-product publications using their exact executable releases", async () => {
    const publications = [growthAgentPublicationV3, growthAgentPublicationV4, growthAgentPublicationV5,
      growthAgentPublicationV6, growthAgentPublicationV7, growthAgentPublicationV8, growthAgentPublicationV9, growthAgentPublicationV10,
      growthAgentPublicationV11,growthAgentPublicationV12,growthAgentPublicationV13,growthAgentPublication];
    const query = vi.fn(async () => ({ rows: publications.map(publication => ({ publication })) }));
    const client = { invoke: vi.fn() } as unknown as GrowthActionClient;
    const runtime = new GrowthProductRuntime({ query } as unknown as Pool, client);
    await expect(runtime.loadPublications()).resolves.toBeUndefined();
    expect(client.invoke).not.toHaveBeenCalled();
    expect(growthAgentPublication.manifest.revision).toBe("14");
    expect(growthAgentPublication.manifest.adapter.release).toBe("11");
  });

  it("applies the versioned Growth delegation graph through child configurations", async () => {
    const query=vi.fn(async()=>({rows:[{publication:growthAgentPublication}]}));
    const runtime=new GrowthProductRuntime({query} as unknown as Pool,{invoke:vi.fn()} as unknown as GrowthActionClient);
    await runtime.loadPublications();

    expect(validateGrowthPublication(growthAgentPublication).policy.delegation).toBeDefined();
    const cyclic=structuredClone(growthAgentPublication);
    cyclic.policy.delegation!.delegates.research=["content"];
    expect(()=>validateGrowthPublication(cyclic)).toThrowError(expect.objectContaining({code:"PRODUCT_MANIFEST_INVALID"}));
    const policy=growthDelegationPolicy(growthAgentPublication)!;
    expect(growthFeatureProvisionOrder(growthAgentPublication).map(feature=>feature.id)).toEqual(["research","content","campaigns","assistant"]);
    expect(growthDelegationPolicy(growthAgentPublicationV10)).toMatchObject({maxDepth:1,policy:{maxTasks:16},childLimits:{maxTokens:48000,maxActiveMs:300000}});
    const organizationId="1f000000-0000-4000-8000-000000000001",tenantId="2f000000-0000-4000-8000-000000000002";
    const research=growthFeatureConfiguration(growthAgentPublication,"research",organizationId,tenantId);
    const allowedTools=new Set<AgentConfiguration["tools"][number]>(["knowledge.search","knowledge.read","memory.search","memory.read","memory.propose","artifact.create","sandbox.analyze"]);
    const binding=(id:"research"|"content"|"campaigns",configuration:AgentConfiguration)=>({id,versionId:randomUUID(),
      sourceRevisionIds:sourceAuthorityIds(configuration),connectedToolBindingIds:[],label:id,description:id,tools:configuration.tools.filter(tool=>allowedTools.has(tool)),
      maxTokens:policy.childLimits.maxTokens,maxActiveMs:policy.childLimits.maxActiveMs});
    const roster=(ids:Array<"research"|"content"|"campaigns">,configurations:Record<string,AgentConfiguration>):AgentConfiguration["capabilities"]["delegation"]=>({
      enabled:true,maxChildren:policy.maxChildren,maxDepth:policy.maxDepth,policy:policy.policy,bindings:ids.map(id=>binding(id,configurations[id]!)),
    });
    const content=growthFeatureConfiguration(growthAgentPublication,"content",organizationId,tenantId,undefined,roster(["research"],{research}));
    const campaigns=growthFeatureConfiguration(growthAgentPublication,"campaigns",organizationId,tenantId,undefined,roster(["research"],{research}));
    const assistant=growthFeatureConfiguration(growthAgentPublication,"assistant",organizationId,tenantId,undefined,
      roster(["research","content","campaigns"],{research,content,campaigns}));

    if(!assistant.capabilities.delegation.enabled)throw new Error("Growth Assistant delegation was not configured");
    const effectiveContent=delegatedConfiguration(assistant,assistant.capabilities.delegation.bindings.find(item=>item.id==="content")!,content);
    expect(effectiveContent.capabilities.delegation).toMatchObject({enabled:true,maxDepth:null,policy:{maxTasks:null}});
    expect(effectiveContent.tools).toContain("agents.start");
    if(!effectiveContent.capabilities.delegation.enabled)throw new Error("Growth Content delegation was not configured");
    const effectiveResearch=delegatedConfiguration(effectiveContent,effectiveContent.capabilities.delegation.bindings[0]!,research);
    expect(effectiveResearch.capabilities.delegation.enabled).toBe(false);
    expect(effectiveResearch.tools).not.toContain("agents.start");
    const contentOperations=new Set(effectiveContent.productBindings.map(item=>item.definition.providerOperation));
    expect(effectiveResearch.productBindings.every(item=>contentOperations.has(item.definition.providerOperation))).toBe(true);
    expect(effectiveResearch.productBindings.map(item=>item.definition.providerOperation)).not.toContain("campaigns.read");
  });
});
