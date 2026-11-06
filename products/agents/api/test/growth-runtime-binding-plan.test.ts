import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { ProductCapabilityDescriptor } from "@kasitek-labs/contracts";
import { defaultBusinessConfiguration, requestDigest } from "../src/contracts/contracts";
import { registerProductAdapter, createProductBindings } from "../src/capabilities/products/product-capabilities";
import { growthContentReadAdapterManifest, growthReferenceAdapterManifest } from "../src/adapters/products/growth-capability-manifests";
import { planGrowthRuntimeBindingClones, rebaseGrowthRuntimeDraft } from "../src/product/integrations/growth-runtime-binding-plan";
import { assertGrowthConfigurationPreservingConnections } from "../src/product/integrations/growth-features";
import type { GrowthAgentPublication } from "@kasitek-labs/contracts";

const descriptor: ProductCapabilityDescriptor = { operation: "connections.list", revision: "1", description: "List connections", inputSchema: { type: "object", properties: {} }, outputSchema: null, handlerRef: "growth.operation.connections.list@1", requiredAuthority: ["feature.agents.manage"], evidence: "none", policy: { effect: "read", disclosure: "approved_resource_identifiers", retry: "safe_read", approval: "none", cancel: "stop_admission" }, limits: { timeoutMs: 10000, maxPhysicalAttempts: 1, maxResponseBytes: 131072, maxModelResultBytes: 8192 } };
const install = (manifest: typeof growthContentReadAdapterManifest) => registerProductAdapter(manifest,{handlers:[descriptor.handlerRef],async invoke(){throw new Error("not used");}});
const oldAdapter = install(growthContentReadAdapterManifest), newAdapter = install(growthReferenceAdapterManifest);
const makeManifest = (revision: string, adapter: typeof oldAdapter) => { const body = { schemaVersion: 1 as const, product: "growth", revision, adapter, operations: [descriptor] }; return { ...body, digest: requestDigest(body) }; };
const previous = makeManifest("12",oldAdapter), next = makeManifest("14",newAdapter);
const tenant = randomUUID(), org = randomUUID();
function config() { const value=defaultBusinessConfiguration(); value.productBindings=createProductBindings(previous,org,{originProduct:"growth",originTenantId:tenant,tenantId:tenant,mappingRef:`growth:${tenant}`,policyRevision:"12"},[descriptor.operation]); return value; }

describe("Growth immutable runtime binding plan", () => {
  it("clones the child and coordinator while preserving settings and binding IDs", () => {
    const childId=randomUUID(),parentId=randomUUID(),child=config(),parent=config();
    parent.instructions="custom instructions";
    parent.capabilities.delegation={enabled:true,maxChildren:1,maxDepth:1,policy:{maxTasks:null,maxStalls:3},bindings:[{id:"child",versionId:childId,sourceRevisionIds:[],connectedToolBindingIds:[],tools:[],maxTokens:2048,maxActiveMs:1000,productBindingIds:[parent.productBindings[0].id]}]};
    const plan=planGrowthRuntimeBindingClones({roots:[parentId],organizationId:org,tenantId:tenant,versions:[{id:parentId,organizationId:org,product:"growth",tenantId:tenant,configuration:parent},{id:childId,organizationId:org,product:"growth",tenantId:tenant,configuration:child}],previous:[{manifest:previous,policyRevision:"12"}],next,nextPolicy:"14"});
    expect(plan.clones).toHaveLength(2);
    const parentClone=plan.clones.find(v=>v.sourceVersionId===parentId)!;
    expect(parentClone.configuration.instructions).toBe("custom instructions");
    expect(parentClone.configuration.productBindings[0].id).toBe(parent.productBindings[0].id);
    expect(parentClone.configuration.productBindings[0].authority?.manifestDigest).toBe(next.digest);
    expect(parentClone.configuration.capabilities.delegation.enabled && parentClone.configuration.capabilities.delegation.bindings[0].versionId).toBe(plan.clones.find(v=>v.sourceVersionId===childId)!.versionId);
    expect(parent.productBindings[0].authority?.manifestDigest).toBe(previous.digest);
    const edited=structuredClone(parent);edited.instructions="unsaved changes";
    const rebased=rebaseGrowthRuntimeDraft(edited,parent,parentClone.configuration);
    expect(rebased.instructions).toBe("unsaved changes");
    expect(rebased.productBindings[0].authority?.manifestDigest).toBe(next.digest);
    expect(rebased.capabilities.delegation.enabled && rebased.capabilities.delegation.bindings[0].versionId).toBe(plan.clones.find(v=>v.sourceVersionId===childId)!.versionId);
    edited.productBindings=[];
    expect(rebaseGrowthRuntimeDraft(edited,parent,parentClone.configuration).productBindings).toEqual([]);
  });
  it("fails safely for missing descendants, cycles and changed operation contracts", () => {
    const id=randomUUID(),missing=randomUUID(),parent=config();
    parent.capabilities.delegation={enabled:true,maxChildren:1,maxDepth:1,policy:{maxTasks:null,maxStalls:3},bindings:[{id:"child",versionId:missing,sourceRevisionIds:[],connectedToolBindingIds:[],tools:[],maxTokens:2048,maxActiveMs:1000}]};
    const base={roots:[id],organizationId:org,tenantId:tenant,versions:[{id,organizationId:org,product:"growth",tenantId:tenant,configuration:parent}],previous:[{manifest:previous,policyRevision:"12"}],next,nextPolicy:"14"};
    expect(()=>planGrowthRuntimeBindingClones(base)).toThrow();
    expect(()=>planGrowthRuntimeBindingClones({...base,versions:[{...base.versions[0],organizationId:randomUUID()}]})).toThrow();
    parent.capabilities.delegation.bindings[0].versionId=id;
    expect(()=>planGrowthRuntimeBindingClones(base)).toThrow();
    const changed={...next,operations:[{...descriptor,requiredAuthority:["different"]}]};
    const {digest:_digest,...body}=changed;
    expect(()=>planGrowthRuntimeBindingClones({...base,next:{...body,digest:requestDigest(body)}})).toThrow();
  });
  it("retains previously selected connected tools without adding or redistributing them",()=>{
    const direct=randomUUID(),childOnly=randomUUID(),old=config();old.connectedToolBindingIds=[direct];
    old.capabilities.delegation={enabled:true,maxChildren:1,maxDepth:1,policy:{maxTasks:null,maxStalls:3},bindings:[{id:"child",versionId:randomUUID(),sourceRevisionIds:[],connectedToolBindingIds:[childOnly],tools:[],maxTokens:2048,maxActiveMs:1000}]};
    const publication={policy:{optionalCapabilities:{knowledge:false,skills:false,memory:false,delegation:true,sandbox:false,workflows:false,connections:false}}} as GrowthAgentPublication;
    expect(()=>assertGrowthConfigurationPreservingConnections(old,old,publication)).not.toThrow();
    const widened=structuredClone(old);widened.connectedToolBindingIds.push(childOnly);
    expect(()=>assertGrowthConfigurationPreservingConnections(widened,old,publication)).toThrow();
    const added=structuredClone(old);if(!added.capabilities.delegation.enabled)throw Error("expected delegation");added.capabilities.delegation.bindings[0].connectedToolBindingIds.push(direct);
    expect(()=>assertGrowthConfigurationPreservingConnections(added,old,publication)).toThrow();
  });
});
