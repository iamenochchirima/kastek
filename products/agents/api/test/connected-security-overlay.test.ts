import { describe, expect, it } from "vitest";
import { ConnectedExecutor } from "../src/capabilities/connected-tools/connected-executor";
import { retainedSecurityOverlayManifests } from "../src/capabilities/connected-tools/retained-security-overlays";
import { requestDigest } from "../src/contracts/contracts";

describe("verified connected security overlays", () => {
  it("resolves known hosted pins to the hardened executor and rejects unknown pins", () => {
    const executor = new ConnectedExecutor({} as never, {} as never, {} as never, {} as never);
    expect(retainedSecurityOverlayManifests).toHaveLength(7);
    for (const manifest of retainedSecurityOverlayManifests) {
      const adapter = { id: manifest.id, release: manifest.release, manifestDigest: requestDigest(manifest) };
      const binding = { adapter, transport: manifest.transports[0]!, protocolVersion: manifest.protocolVersions[0] ?? null };
      expect(executor.registry.resolve(binding)).toBe(executor);
      expect(() => executor.registry.resolve({ ...binding, adapter: { ...adapter, manifestDigest: "f".repeat(64) } })).toThrowError(expect.objectContaining({ code: "ADAPTER_RELEASE_UNAVAILABLE" }));
    }
  });
});
