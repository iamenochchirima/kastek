import { describe, expect, it } from "vitest";
import { diffEffectiveAgentConfig, projectEffectiveAgentConfig } from "../src/domain/effective-agent-config";
import type { AgentVersionRecord } from "../src/db/repositories/agent-repository";

const version = (overrides: Partial<AgentVersionRecord> = {}): AgentVersionRecord => ({
  id: "11111111-1111-4111-8111-111111111111",
  agent_definition_id: "22222222-2222-4222-8222-222222222222",
  version_number: 1,
  status: "published",
  instructions: "Keep answers concise.",
  configuration: { maxContextTokens: 4_000 },
  policy: {},
  checksum: "candidate-checksum",
  created_by: "actor-1",
  created_at: "2026-09-01T00:00:00.000Z",
  published_at: "2026-09-01T00:00:00.000Z",
  ...overrides,
});

describe("effective agent configuration", () => {
  it("projects effective behavior without exposing secrets or provider internals", () => {
    const projection = projectEffectiveAgentConfig({
      version: version({ configuration: { credentialReference: "should-not-leak", workflow: { nodes: [{ id: "secret-node" }] } } }),
      source: "legacy",
      model: {
        provider: "openrouter",
        model: "openai/gpt-oss-20b",
        fallback: [],
        allowUserFundedFallbackToKasiTek: false,
      },
      tools: ["platform.current_time", "platform.current_time"],
      connectors: ["telegram.messaging"],
      knowledge: { sourceIds: ["knowledge-1"], requiredConnections: ["website"] },
      memory: { mode: "explicit", maxRetrieved: 8 },
      limits: { maxContextTokens: 4_000 },
      workflow: { configured: true, valid: true, nodeCount: 1 },
      channels: ["telegram"],
      skills: [],
      remoteMcpProviders: [],
    });

    expect(projection.tools).toEqual(["platform.current_time"]);
    expect(projection.behavior).toEqual({ instructionCharacters: 21 });
    expect(projection.workflow).toEqual({ configured: true, valid: true, nodeCount: 1 });
    expect(projection).not.toHaveProperty("configuration");
    expect(projection).not.toHaveProperty("credentialReference");
    expect(projection).not.toHaveProperty("workflow.nodes");
  });

  it("diffs effective sections while ignoring immutable version identity", () => {
    const base = projectEffectiveAgentConfig({
      version: version(),
      source: "legacy",
      model: { provider: "openrouter", model: "model-a", fallback: [], allowUserFundedFallbackToKasiTek: false },
      tools: ["tool-a"],
      connectors: [],
      knowledge: { sourceIds: [], requiredConnections: [] },
      memory: { mode: "explicit" },
      limits: { maxContextTokens: 4_000 },
      workflow: { configured: false, valid: true },
      channels: [],
      skills: [],
      remoteMcpProviders: [],
    });
    const candidate = { ...base, version: { ...base.version, id: "33333333-3333-4333-8333-333333333333", checksum: "deployed-checksum" }, model: { ...base.model, model: "model-b" }, tools: ["tool-a", "tool-b"] };

    const diff = diffEffectiveAgentConfig(candidate, base);
    expect(diff.changed).toBe(true);
    expect(diff.truncated).toBe(false);
    expect(diff.paths).toEqual(["/model/model", "/tools"]);
  });

  it("bounds diff output", () => {
    const base = projectEffectiveAgentConfig({
      version: version(),
      source: "legacy",
      model: { provider: "openrouter", model: "model-a", fallback: [], allowUserFundedFallbackToKasiTek: false },
      tools: [],
      connectors: [],
      knowledge: { sourceIds: [], requiredConnections: [] },
      memory: {},
      limits: {},
      workflow: { configured: false, valid: true },
      channels: [],
      skills: [],
      remoteMcpProviders: [],
    });
    const candidate = { ...base, memory: { a: 1, b: 2, c: 3 } };
    const diff = diffEffectiveAgentConfig(candidate, base, 2);
    expect(diff.paths).toHaveLength(2);
    expect(diff.truncated).toBe(true);
  });
});
