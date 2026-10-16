import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../src/tools/registry";

describe("capability manifest registry", () => {
  it("rejects incomplete manifests and filters discovery by grants", () => {
    const registry = new ToolRegistry();
    expect(() => registry.registerManifest({
      name: "content.read", version: "1.0.0", description: "read", riskClass: "read", requiresApproval: false,
      timeoutMs: 1000, inputSchema: { type: "object" }, outputSchema: { type: "object" }, handler: async () => ({}),
      manifest: { ownerService: "core", requiredScope: "content.read", execution: "immediate", idempotency: "not_applicable", approval: "none", auditClassification: "access", redaction: [] },
    })).not.toThrow();
    expect(registry.manifests(new Set(["content.read"]))).toHaveLength(1);
    expect(registry.manifests(new Set())).toHaveLength(0);
  });

  it("rejects presentation metadata that is not a reviewed projection", () => {
    const registry = new ToolRegistry();
    expect(() => registry.registerManifest({
      name: "content.present", version: "1.0.0", description: "read", riskClass: "read", requiresApproval: false,
      timeoutMs: 1000, inputSchema: { type: "object" }, outputSchema: { type: "object" }, handler: async () => ({}),
      manifest: {
        ownerService: "core", requiredScope: "content.read", execution: "immediate", idempotency: "not_applicable", approval: "none", auditClassification: "access", redaction: [],
        presentation: { projection: "arbitrary_html" as "workspace_connections", mode: "inline", channels: ["platform"], fallback: "read" },
      },
    })).toThrow("Invalid presentation metadata");
  });
});
