import { describe, expect, it, vi } from "vitest";
import { executeDraftEvaluation } from "../src/evaluations/draft";
import type { AgentVersionRecord } from "../src/db/repositories/agent-repository";

const version: AgentVersionRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  agent_definition_id: "22222222-2222-4222-8222-222222222222",
  version_number: 1,
  status: "draft",
  instructions: "Answer briefly.",
  configuration: { temperature: 0, maxTokens: 120 },
  policy: {
    modelPolicy: {
      version: "test-v1",
      primary: { provider: "openrouter", model: "openai/gpt-4.1-mini" },
    },
  },
  checksum: "checksum",
  created_by: "actor",
  created_at: "2026-09-01T00:00:00.000Z",
  published_at: null,
};

describe("draft evaluation execution", () => {
  it("runs only the candidate model call and returns explicit isolation evidence", async () => {
    const complete = vi.fn(async (request: { tools?: unknown; messages: Array<{ role: string; content: string }>; maxTokens?: number }) => ({
      provider: "openrouter" as const,
      model: "openai/gpt-4.1-mini",
      message: { role: "assistant" as const, content: "draft answer" },
      toolCalls: [],
      finishReason: "stop",
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
      latencyMs: 4,
    }));
    const result = await executeDraftEvaluation(
      { organizationId: "org-1", version, scenarioInput: { message: "hello" } },
      {
        gateway: { complete },
        credentials: { resolve: vi.fn(async () => ({ apiKey: "test", fundingSource: "user" as const })) },
      },
    );

    expect(complete).toHaveBeenCalledWith(expect.objectContaining({ maxTokens: 120 }), expect.anything());
    expect(complete.mock.calls[0]?.[0].tools).toBeUndefined();
    expect(result.actualOutput).toEqual({ text: "draft answer" });
    expect(result.isolation).toEqual({
      executionMode: "draft",
      liveRunId: null,
      toolCalls: 0,
      memoryReads: 0,
      memoryWrites: 0,
      deliveryAttempts: 0,
    });
  });

  it("rejects provider tool calls instead of allowing a draft to escape its boundary", async () => {
    await expect(executeDraftEvaluation(
      { organizationId: "org-1", version, scenarioInput: { message: "hello" } },
      {
        gateway: { complete: vi.fn(async () => ({
          provider: "openrouter" as const,
          model: "openai/gpt-4.1-mini",
          message: { role: "assistant" as const, content: "not safe", toolCalls: [{ id: "1", name: "send", arguments: {} }] },
          toolCalls: [{ id: "1", name: "send", arguments: {} }],
          finishReason: "tool_calls",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          latencyMs: 1,
        })) },
        credentials: { resolve: vi.fn(async () => ({ apiKey: "test", fundingSource: "user" as const })) },
      },
    )).rejects.toThrow("DRAFT_TOOL_CALL_UNSUPPORTED");
  });
});
