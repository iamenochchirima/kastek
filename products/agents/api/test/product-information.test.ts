import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { narrowProductInformation, productProviderDestination } from "../src/contracts/product-information";
import { createDependencyManifest } from "../src/contracts/source-contracts";
import type { ResolvedModelBinding } from "../src/contracts/model-providers";

function fixture() {
  const binding: ResolvedModelBinding = { organizationId: randomUUID(), connectionId: randomUUID(), connectionRevision: 1,
    credentialRevision: 1, useGrantId: randomUUID(), useGrantRevision: 1, providerId: "fixture", providerDefinitionDigest: "a".repeat(64),
    endpoint: "https://provider.example/v1", protocol: "openai_chat_completions", modelId: "one", modelRevision: "1",
    adapterId: "fixture", adapterRevision: "1", role: "primary", policyDigest: "b".repeat(64) };
  const actor = { issuer: "https://agency.example/identity", subject: "same-name-owner" };
  const information = { version: "1" as const, origin: { product: "agencies", tenantId: "workspace-one", actor },
    audience: { product: "agencies", tenantId: "workspace-one", actor, conversationId: randomUUID(), clientId: "client-one" },
    providers: [productProviderDestination(binding), productProviderDestination({ ...binding, modelId: "summary" })] };
  return { binding, information };
}

describe("product information destinations", () => {
  it("permits a product to narrow providers while rejecting a different recipient, client or credential account", () => {
    const { binding, information } = fixture();
    expect(narrowProductInformation(information, { ...information, providers: [information.providers[0]!] }).providers).toHaveLength(1);
    const attempted = [
      { ...information, audience: { ...information.audience, clientId: "client-two" } },
      { ...information, audience: { ...information.audience, actor: { ...information.audience.actor, subject: "another-owner" } } },
      { ...information, origin: { ...information.origin, tenantId: "workspace-two" } },
      { ...information, providers: [productProviderDestination({ ...binding, connectionId: randomUUID() })] },
      { ...information, providers: [productProviderDestination({ ...binding, credentialRevision: 2 })] },
    ];
    for (const response of attempted) expect(() => narrowProductInformation(information, response))
      .toThrowError(expect.objectContaining({ code: "PRODUCT_INFORMATION_DENIED" }));
  });

  it("separates physical provider identity from call role while retaining the exact accepted binding receipt", () => {
    const { binding } = fixture(), primary = productProviderDestination(binding), summary = productProviderDestination({ ...binding, role: "compaction" });
    expect(primary.destinationDigest).toBe(summary.destinationDigest);
    expect(primary.bindingDigest).not.toBe(summary.bindingDigest);
    expect(productProviderDestination({ ...binding, endpoint: "https://another.example/v1" }).destinationDigest).not.toBe(primary.destinationDigest);
  });

  it("retains information policy through evidence manifests and rejects conflicting same-source scope", () => {
    const { information } = fixture(), dependency = { kind: "product" as const, product: "agencies", tenantId: "workspace-one", taskId: randomUUID(),
      contextRevision: "a".repeat(64), bindingId: randomUUID(), bindingDigest: "b".repeat(64), sourceId: "metadata-one", information };
    expect(createDependencyManifest([dependency]).dependencies[0]).toMatchObject({ information });
    expect(() => createDependencyManifest([dependency, { ...dependency, information: { ...information, providers: [information.providers[0]!] } }]))
      .toThrowError(expect.objectContaining({ code: "EVIDENCE_POLICY_CONFLICT" }));
  });

  it("deduplicates the same access scope without losing narrower provider restrictions", () => {
    const { information }=fixture();
    const dependency={kind:"product_access" as const,product:"agencies",tenantId:"workspace-one",taskId:randomUUID(),
      bindingId:randomUUID(),bindingDigest:"b".repeat(64),reference:"scope:one",information};
    expect(createDependencyManifest([dependency,dependency]).dependencies).toHaveLength(1);
    const restricted={...dependency,information:{...information,providers:[information.providers[0]!]}};
    expect(createDependencyManifest([dependency,restricted]).dependencies).toHaveLength(2);
  });
});
