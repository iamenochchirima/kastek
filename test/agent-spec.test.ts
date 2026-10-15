import { describe, expect, it } from "vitest";
import { agentSpecSchema, compileAgentSpec, renderAgentBehaviorSettings } from "../src/domain/agent-spec";
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
  it("persists the execution strategy and rejects unknown strategies", () => {
    const parsed = createVersionInputSchema.parse({ spec: { ...spec, runtime: { ...spec.runtime, executionStrategy: "simple" } } });
    expect(parsed.configuration.executionStrategy).toBe("simple");
    expect(() => createVersionInputSchema.parse({ spec: { ...spec, runtime: { executionStrategy: "unlimited" } } })).toThrow();
    expect(() => createVersionInputSchema.parse({ instructions: "test", configuration: { executionStrategy: "unlimited" } })).toThrow();
  });
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

  it("rejects a token budget that cannot contain its configured context", () => {
    expect(() => agentSpecSchema.parse({
      ...spec,
      runtime: { maxContextTokens: 8_000, maxTotalTokens: 2_048 },
    })).toThrow("must be greater than maxContextTokens");
    expect(() => createVersionInputSchema.parse({
      instructions: "legacy",
      configuration: { maxContextTokens: 8_000, maxTotalTokens: 2_048 },
      policy: {},
    })).toThrow("must be greater than maxContextTokens");
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

  it("keeps behavior preferences typed and renders them as a separate prompt layer", () => {
    const parsed = agentSpecSchema.parse({
      ...spec,
      behavior: {
        instructions: spec.behavior.instructions,
        tone: "direct",
        responseLength: "short",
        initiative: "proactive",
        language: "en-ZA",
        formatting: "structured",
        rules: ["Confirm before optional external effects."],
        advancedInstructions: "Prefer concrete next steps.",
      },
    });

    expect(renderAgentBehaviorSettings(parsed.behavior)).toContain("Tone: direct.");
    expect(renderAgentBehaviorSettings(parsed.behavior)).toContain("- Confirm before optional external effects.");
    expect(renderAgentBehaviorSettings(parsed.behavior)).toContain("Advanced behavior overlay:");
  });
});
