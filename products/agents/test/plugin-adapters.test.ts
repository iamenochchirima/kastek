import { describe, expect, it, vi } from "vitest";
import {
  getPluginAdapter,
  getPluginAdapterStatus,
  listPluginAdapters,
  PLUGIN_ADAPTER_PROTOCOL_VERSION,
} from "../src/extensions";

const tavily = {
  id: "hermes.plugin.web.tavily",
  version: "1.0.0",
  checksum: "1cc7c2e133b0a9ca45c43816bfa0c109da308a7e988999021dff38787372a6cb",
};

describe("plugin adapter registry", () => {
  it("registers adapters by exact reviewed artifact identity", () => {
    const adapter = getPluginAdapter(tavily);

    expect(adapter).toBeDefined();
    expect(adapter?.identity).toEqual({ pluginId: tavily.id, version: tavily.version, checksum: tavily.checksum, protocolVersion: PLUGIN_ADAPTER_PROTOCOL_VERSION });
    expect(adapter?.capabilityIds).toEqual(["kasitek.web.search"]);
    expect(adapter?.connectorIds).toEqual(["tavily.search"]);
    expect(getPluginAdapterStatus(tavily)).toBe("supported");
    expect(getPluginAdapterStatus({ ...tavily, checksum: "f".repeat(64) })).toBe("metadata_only");
  });

  it("keeps the registry narrow and makes adapter readiness explicit", async () => {
    const adapter = getPluginAdapter(tavily)!;
    expect(listPluginAdapters()).toHaveLength(1);
    expect(adapter.checkReadiness({ configuration: {}, credentials: { "tavily.search": "missing" } })).toEqual({
      state: "blocked",
      blockers: ["credential_missing"],
    });
    expect(adapter.checkReadiness({ configuration: {}, credentials: { "tavily.search": "configured" } })).toEqual({
      state: "ready",
      blockers: [],
    });

    const probe = vi.fn().mockResolvedValue(undefined);
    await expect(adapter.checkHealth({ probe })).resolves.toEqual({ status: "healthy" });
    expect(probe).toHaveBeenCalledWith("kasitek.web.search");
  });

  it("delegates native adapter invocation to the approved capability", async () => {
    const adapter = getPluginAdapter(tavily)!;
    const invokeCapability = vi.fn().mockResolvedValue({ results: [] });

    await expect(adapter.invoke({ capabilityId: "kasitek.web.search", input: { query: "KasiTek" }, invokeCapability }))
      .resolves.toEqual({ results: [] });
    expect(invokeCapability).toHaveBeenCalledWith("kasitek.web.search", { query: "KasiTek" });
    await expect(adapter.invoke({ capabilityId: "kasitek.other", input: {}, invokeCapability }))
      .rejects.toThrow("PLUGIN_ADAPTER_CAPABILITY_UNSUPPORTED");
  });
});
