import { describe, it, expect, vi } from "vitest";
import type { Pool } from "pg";
import type { GrowthActionClient } from "../src/adapters/products/growth-action-client";
import { growthLocalRetainedVariants,growthContentReadAdapterManifest,growthReferenceAdapterManifest,growthProductReferences,growthFullOperationHandlers } from "../src/adapters/products/growth-capability-manifests";
import { requestDigest } from "../src/contracts/contracts";
import { productAdapterRegistry } from "../src/capabilities/products/product-capabilities";
import {
  GrowthProductRuntime,
  growthOperationAdapterManifest,
  growthOperationAdapterManifestV7,
  growthOperationAdapterManifestV8,
  growthOperationAdapterManifestV9,
  growthOperationAdapterManifestV10,
  growthCurrentOperationAdapterManifest,
} from "../src/execution/products/growth-runtime";

describe("Growth installed operation releases", () => {
  it("keeps retained adapter identities stable and installs revision 9 separately", () => {
    new GrowthProductRuntime(
      {} as Pool,
      { invoke: vi.fn(), call: vi.fn() } as unknown as GrowthActionClient,
    );
    const local=growthLocalRetainedVariants.find(value=>value.manifest.release==="6")!;
    expect(requestDigest(local.manifest)).toBe("ea866f17fc8f723774d916468055fda67ebd30851a1b18821fc6aebbfcdf06fa");
    expect(productAdapterRegistry.resolve({adapter:{id:local.manifest.id,release:"6",manifestDigest:requestDigest(local.manifest)},transport:"native_http",protocolVersion:null}).handlers).toHaveLength(45);
    expect(growthContentReadAdapterManifest.release).toBe("9");
    expect(growthReferenceAdapterManifest.release).toBe("11");
    expect(requestDigest(growthReferenceAdapterManifest)).not.toBe(requestDigest(growthContentReadAdapterManifest));
    const expectedReferences=Object.fromEntries(Object.entries(growthProductReferences).filter(([handler])=>growthFullOperationHandlers.includes(handler)));
    expect(productAdapterRegistry.resolve({adapter:{id:growthReferenceAdapterManifest.id,release:growthReferenceAdapterManifest.release,
      manifestDigest:requestDigest(growthReferenceAdapterManifest)},transport:"native_http",protocolVersion:null}).references).toEqual(expectedReferences);
    const retained = [
      [
        growthOperationAdapterManifest,
        "cca5ab25a1f2f96388014d59ace9e714a1229e13ef6471f123a2c9cc916df992",
      ],
      [
        growthOperationAdapterManifestV7,
        "ae784549df8ae1d9b0c3a7b710f1ff554f286f7fafe6d4a90a787f03fc712e47",
      ],
      [
        growthOperationAdapterManifestV8,
        "106a9aae8e8a8181eb9454e9c94930a2d53aae62a77d3e09cb5bfe61a71a384f",
      ],
    ] as const;
    for (const [manifest, digest] of retained) {
      expect(requestDigest(manifest)).toBe(digest);
      const installed = productAdapterRegistry.resolve({
        adapter: {
          id: manifest.id,
          release: manifest.release,
          manifestDigest: digest,
        },
        transport: "native_http",
        protocolVersion: null,
      });
      expect(installed.handlers).not.toContain(
        "growth.operation.content.actions.preview@1",
      );
    }
    expect(requestDigest(growthOperationAdapterManifestV9)).toBe(
      "8465b3e82957e5584fe45585c356c849b85aa7a445f91ae8557d7724c96aef70",
    );
    const current = growthCurrentOperationAdapterManifest;
    expect(current.release).toBe("8");
    const installed = productAdapterRegistry.resolve({
      adapter: {
        id: current.id,
        release: current.release,
        manifestDigest: requestDigest(current),
      },
      transport: "native_http",
      protocolVersion: null,
    });
    expect(installed.handlers).toContain(
      "growth.operation.content.actions.preview@1",
    );
    expect(requestDigest(growthOperationAdapterManifestV10)).toBe(
      "f186a4066acab3848a73743f477f3856e12cdba7f814d55e9b6049b7945a4051",
    );
    const prior = productAdapterRegistry.resolve({
      adapter: {
        id: growthOperationAdapterManifestV10.id,
        release: "7",
        manifestDigest: requestDigest(growthOperationAdapterManifestV10),
      },
      transport: "native_http",
      protocolVersion: null,
    });
    expect(prior.handlers).toHaveLength(46);
    for (const name of [
      "content.media.list",
      "content.media.update",
      "content.media.usage",
      "content.media.archive",
      "content.media.restore",
      "content.templates.list",
      "content.templates.get",
      "content.templates.create",
      "content.templates.update",
      "content.templates.render",
      "content.templates.instantiate",
      "content.templates.archive",
      "content.templates.restore",
    ]) {
      expect(installed.handlers).toContain(`growth.operation.${name}@1`);
      expect(prior.handlers).not.toContain(`growth.operation.${name}@1`);
    }
  });
});

it("discovers canonical library schemas in content specialist bindings and rejects invalid invocation arguments", async () => {
  const { growthAgentPublication } =
    await import("../../../growth/api/src/agents/manifest");
  const { growthFeatureConfiguration } =
    await import("../src/product/integrations/growth-features");
  const { productModelTools, productDescriptor } =
    await import("../src/capabilities/products/product-capabilities");
  const { validateProductArguments } =
    await import("../src/execution/products/product-runtime");
  new GrowthProductRuntime(
    {} as Pool,
    { invoke: vi.fn(), call: vi.fn() } as unknown as GrowthActionClient,
  );
  const configuration = growthFeatureConfiguration(
    growthAgentPublication,
    "content",
    "00000000-0000-4000-8000-000000000001",
    "fixture-workspace",
  );
  const bindings = configuration.productBindings;
  const tools = productModelTools(bindings);
  for (const name of [
    "content.media.list",
    "content.media.update",
    "content.media.usage",
    "content.media.archive",
    "content.media.restore",
    "content.templates.list",
    "content.templates.get",
    "content.templates.create",
    "content.templates.update",
    "content.templates.render",
    "content.templates.instantiate",
    "content.templates.archive",
    "content.templates.restore",
  ]) {
    const binding = bindings.find(
      (item) => item.definition.providerOperation === name,
    )!;
    expect(binding, name).toBeDefined();
    const descriptor = growthAgentPublication.manifest.operations.find(
      (item) => item.operation === name,
    )!;
    expect(productDescriptor(binding)).toEqual(descriptor);
    expect(
      tools.find((tool) => tool.function.name === binding.alias)?.function
        .parameters,
    ).toEqual(descriptor.inputSchema);
    expect(binding.authority).toMatchObject({
      tenantId: "fixture-workspace",
      policyRevision: "14",
      handlerRef: `growth.operation.${name}@1`,
    });
  }
  const list = bindings.find(
    (item) => item.definition.providerOperation === "content.media.list",
  )!;
  await expect(
    validateProductArguments(list, { limit: 1, kind: "IMAGE" }),
  ).resolves.toBeUndefined();
  await expect(
    validateProductArguments(list, { limit: 1000 }),
  ).rejects.toMatchObject({ code: "TOOL_ARGUMENTS_INVALID" });
  const archive = bindings.find(
    (item) => item.definition.providerOperation === "content.media.archive",
  )!;
  await expect(
    validateProductArguments(archive, { assetId: "asset" }),
  ).rejects.toMatchObject({ code: "TOOL_ARGUMENTS_INVALID" });
});
