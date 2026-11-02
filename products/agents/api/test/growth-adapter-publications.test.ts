import { describe, it, expect, vi } from "vitest";
import type { Pool } from "pg";
import type { GrowthActionClient } from "../src/adapters/products/growth-action-client";
import { requestDigest } from "../src/contracts/contracts";
import { productAdapterRegistry } from "../src/capabilities/products/product-capabilities";
import { GrowthProductRuntime, growthOperationAdapterManifest, growthOperationAdapterManifestV7,
  growthOperationAdapterManifestV8, growthOperationAdapterManifestV9, growthCurrentOperationAdapterManifest } from "../src/execution/products/growth-runtime";

describe("Growth installed operation releases", () => {
  it("keeps retained adapter identities stable and installs revision 9 separately", () => {
    new GrowthProductRuntime({} as Pool, {invoke: vi.fn(), call: vi.fn()} as unknown as GrowthActionClient);
    const retained = [
      [growthOperationAdapterManifest, "cca5ab25a1f2f96388014d59ace9e714a1229e13ef6471f123a2c9cc916df992"],
      [growthOperationAdapterManifestV7, "ae784549df8ae1d9b0c3a7b710f1ff554f286f7fafe6d4a90a787f03fc712e47"],
      [growthOperationAdapterManifestV8, "106a9aae8e8a8181eb9454e9c94930a2d53aae62a77d3e09cb5bfe61a71a384f"],
    ] as const;
    for (const [manifest, digest] of retained) {
      expect(requestDigest(manifest)).toBe(digest);
      const installed = productAdapterRegistry.resolve({adapter:{id:manifest.id,release:manifest.release,manifestDigest:digest},transport:"native_http",protocolVersion:null});
      expect(installed.handlers).not.toContain("growth.operation.content.actions.preview@1");
    }
    expect(requestDigest(growthOperationAdapterManifestV9)).toBe("8465b3e82957e5584fe45585c356c849b85aa7a445f91ae8557d7724c96aef70");
    const current = growthCurrentOperationAdapterManifest;
    expect(current.release).toBe("7");
    const installed = productAdapterRegistry.resolve({adapter:{id:current.id,release:current.release,manifestDigest:requestDigest(current)},transport:"native_http",protocolVersion:null});
    expect(installed.handlers).toContain("growth.operation.content.actions.preview@1");
  });
});
