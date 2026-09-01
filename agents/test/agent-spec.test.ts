import { describe, expect, it } from "vitest";
import { agentSpecSchema, compileAgentSpec } from "../src/domain/agent-spec";
import { createVersionInputSchema } from "../src/domain/types";

const spec = {
  specVersion: 1 as const,
  behavior: { instructions: "Answer with sourced, concise help." },
  model: {
    version: "2026-01",
    primary: { provider: "openrouter" as const, model: "openai/gpt-4.1-mini" },
  },
  runtime: { maxModelCalls: 4, maxTotalTokens: 4_000 },
  capabilities: { allowedTools: ["platform.current_time"], requiredCapabilities: ["platform.current_time"] },
  memory: { mode: "explicit" as const, maxRetrieved: 4 },
};

describe("AgentSpec", () => {
  it("compiles a strict typed spec into the immutable version contract", () => {
    const parsed = createVersionInputSchema.parse({ spec });

    expect(parsed).toMatchObject({
      instructions: spec.behavior.instructions,
      configuration: {
        specVersion: 1,
        maxModelCalls: 4,
        maxTotalTokens: 4_000,
        agentSpec: { specVersion: 1, behavior: spec.behavior },
      },
      policy: {
        allowedTools: ["platform.current_time"],
        modelPolicy: { primary: spec.model.primary },
      },
    });
  });

  it("rejects unknown fields instead of silently changing agent behavior", () => {
    expect(() => agentSpecSchema.parse({ ...spec, runtime: { ...spec.runtime, maxRetries: 3 } })).toThrow();
    expect(() => agentSpecSchema.parse({ ...spec, model: { ...spec.model, primary: { ...spec.model.primary, temperature: 1 } } })).toThrow();
    expect(() => createVersionInputSchema.parse({ ...spec, unexpected: true })).toThrow();
  });

  it("validates workflow graphs before they enter a version", () => {
    expect(() => compileAgentSpec({
      ...spec,
      workflow: {
        graph: {
          version: 1,
          entryNodeId: "missing",
          nodes: [{ id: "chat", type: "model" }],
          edges: [],
        },
      },
    })).toThrow("Workflow entry node does not exist");
  });

  it("keeps the existing legacy version shape compatible", () => {
    expect(createVersionInputSchema.parse({ instructions: "legacy", configuration: {}, policy: {} })).toEqual({
      instructions: "legacy",
      configuration: {},
      policy: {},
    });
  });
});
