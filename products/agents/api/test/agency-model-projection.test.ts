import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createProductBindings, registerProductAdapter, registerProductManifest } from "../src/capabilities/products/product-capabilities";
import { productModelResult } from "../src/execution/products/product-result";
import { createProductHttpAdapterManifest, type ProductCapabilityDescriptor } from "@kasitek-labs/contracts";
import { requestDigest } from "../src/contracts/contracts";

const descriptor: ProductCapabilityDescriptor={operation:"agency.workspace_agents.read",revision:"1",description:"Read permitted agents",
  inputSchema:{type:"object",additionalProperties:false,properties:{agentId:{type:"string"},after:{type:"string"}}},outputSchema:null,
  handlerRef:"agency.workspace-agent-metadata@1",policy:{effect:"read",disclosure:"approved_resource_identifiers",retry:"safe_read",approval:"none",cancel:"stop_admission"},
  requiredAuthority:["agency.workspace.agent.read"],evidence:"versioned_sources",limits:{timeoutMs:5000,maxPhysicalAttempts:1,maxResponseBytes:65536,maxModelResultBytes:8192}};
const agencyCapabilityAdapterManifest=createProductHttpAdapterManifest("agencies","1",requestDigest);
const manifest={schemaVersion:1 as const,product:"agencies",revision:"fixture-1",adapter:{id:agencyCapabilityAdapterManifest.id,
  release:agencyCapabilityAdapterManifest.release,manifestDigest:requestDigest(agencyCapabilityAdapterManifest)},operations:[descriptor]};
const agencyCapabilityManifest={...manifest,digest:requestDigest(manifest)};

describe("Agency workspace model view", () => {
  it("omits the internal workspace scope while preserving selectors, pagination and evidence", () => {
    registerProductAdapter(agencyCapabilityAdapterManifest, {handlers:["agency.workspace-agent-metadata@1"], invoke:async()=>({value:{}})});
    registerProductManifest(agencyCapabilityManifest);
    const binding=createProductBindings(agencyCapabilityManifest,randomUUID(),{originProduct:"agencies",originTenantId:"tenant",tenantId:"tenant",mappingRef:"map",policyRevision:"1"},["agency.workspace_agents.read"])[0]!;
    const original={value:{data:{workspaceId:"internal-workspace",agents:[{id:"agent-1",name:"Support",status:"active"}],next:"agent-1"},passages:[{citation:"[1]",text:"Support"}]}};
    const before=structuredClone(original);
    expect(productModelResult(binding,original,randomUUID(),"operation")).toEqual({value:{data:{agents:[{id:"agent-1",name:"Support",status:"active"}],next:"agent-1"},passages:[{citation:"[1]",text:"Support"}]}});
    expect(original).toEqual(before);
  });
});
