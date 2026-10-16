import { describe, expect, it } from "vitest";
import { agentExtensionSelectionSchema, agentSpecSchema, compileAgentSpec } from "../src/domain/agent-spec";

const checksum = "A".repeat(64);

const packageReference = {
  kind: "plugin" as const,
  id: "sales.crm",
  version: "1.2.3",
  checksum,
  configuration: {
    region: "za",
    retries: 2,
  },
};

describe("AgentSpec extension package selection", () => {
  it("accepts pinned skill, plugin, and MCP package references with grants", () => {
    const selection = agentExtensionSelectionSchema.parse({
      packages: [
        { kind: "skill", id: "support.triage", version: "1.0.0", checksum },
        packageReference,
        { kind: "mcp_adapter", id: "crm-server", version: "0.4.1-beta.2", checksum },
      ],
      grants: [
        { kind: "skill", id: "support.triage", permissions: ["knowledge.read"] },
        { kind: "plugin", id: "sales.crm", permissions: ["crm.contacts.read"] },
        { kind: "mcp_adapter", id: "crm-server", permissions: ["mcp.tools.call"] },
      ],
    });

    expect(selection.packages[1]).toMatchObject({
      kind: "plugin",
      id: "sales.crm",
      version: "1.2.3",
      checksum: checksum.toLowerCase(),
    });
  });

  it.each([
    ["package id", { ...packageReference, id: "Sales CRM" }],
    ["version", { ...packageReference, version: "1.2" }],
    ["checksum", { ...packageReference, checksum: "not-a-sha" }],
  ])("rejects an invalid %s", (_label, invalidReference) => {
    expect(() => agentExtensionSelectionSchema.parse({ packages: [invalidReference] })).toThrow();
  });

  it("rejects duplicate package references and grants to unselected packages", () => {
    expect(() => agentExtensionSelectionSchema.parse({
      packages: [packageReference, { ...packageReference, version: "1.2.4" }],
    })).toThrow("duplicate package reference: plugin:sales.crm");

    expect(() => agentExtensionSelectionSchema.parse({
      packages: [packageReference],
      grants: [{ kind: "skill", id: "support.triage", permissions: [] }],
    })).toThrow("grant references an unselected package: skill:support.triage");

    expect(() => agentExtensionSelectionSchema.parse({
      packages: [packageReference],
      grants: [
        { kind: "plugin", id: "sales.crm", permissions: [] },
        { kind: "plugin", id: "sales.crm", permissions: ["crm.contacts.read"] },
      ],
    })).toThrow("duplicate package grant: plugin:sales.crm");
  });

  it("compiles extension packages into configuration and grants into policy", () => {
    const compiled = compileAgentSpec({
      specVersion: 1,
      behavior: { instructions: "Use the configured capabilities." },
      model: {
        version: "2026-01",
        primary: { provider: "openrouter", model: "openai/gpt-4.1-mini" },
      },
      extensions: {
        packages: [packageReference],
        grants: [{ kind: "plugin", id: "sales.crm", permissions: ["crm.contacts.read"] }],
      },
    });

    expect(compiled.configuration.extensions).toEqual({
      packages: [{
        ...packageReference,
        checksum: checksum.toLowerCase(),
      }],
    });
    expect(compiled.policy.extensions).toEqual({
      grants: [{ kind: "plugin", id: "sales.crm", permissions: ["crm.contacts.read"] }],
    });
    expect(Object.isFrozen(compiled.configuration.extensions)).toBe(true);
    expect(Object.isFrozen((compiled.configuration.extensions as { packages: readonly unknown[] }).packages)).toBe(true);
    expect(Object.isFrozen(compiled.policy.extensions)).toBe(true);
  });

  it("does not add extension columns when the selection is omitted", () => {
    const parsed = agentSpecSchema.parse({
      specVersion: 1,
      behavior: { instructions: "Answer briefly." },
      model: {
        version: "2026-01",
        primary: { provider: "openrouter", model: "openai/gpt-4.1-mini" },
      },
    });
    const compiled = compileAgentSpec(parsed);

    expect(compiled.configuration).not.toHaveProperty("extensions");
    expect(compiled.policy).not.toHaveProperty("extensions");
  });
});
