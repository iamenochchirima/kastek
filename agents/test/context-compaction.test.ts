import { describe, expect, it, vi } from "vitest";
import {
  compactDurableContext,
  deterministicFallbackSummary,
  type ContextSummaryProvider,
  type DurableContextAdapter,
  type DurableContextPersistenceInput,
  type DurableContextRecord,
} from "../src/runtime/context-compaction";
import { ContextEngine, type ContextEngineJournalEvent } from "../src/runtime/context-engine";
import type { ModelMessage } from "../src/model/types";

const baseMessages: ModelMessage[] = [
  { role: "system", content: "Configured policy." },
  { role: "user", content: "The first durable fact is blue." },
  { role: "assistant", content: "I recorded the request." },
  { role: "user", content: "Keep the latest request visible." },
];

class MemoryContextAdapter implements DurableContextAdapter {
  public readonly writes: DurableContextPersistenceInput[] = [];
  private readonly records = new Map<string, DurableContextRecord>();

  public async read(operationId: string): Promise<DurableContextRecord | undefined> {
    return this.records.get(operationId);
  }

  public async persist(input: DurableContextPersistenceInput) {
    const existing = this.records.get(input.decision.operationId);
    if (existing) return { status: "replayed" as const, record: existing };
    this.writes.push(input);
    const record = { decision: input.decision, compaction: input.compaction };
    this.records.set(input.decision.operationId, record);
    return { status: "created" as const, record };
  }
}

describe("durable context compaction", () => {
  it("produces a deterministic bounded fallback without mutating or deleting durable messages", async () => {
    const source = structuredClone(baseMessages);
    const first = await compactDurableContext({
      operationId: "compaction-1",
      contextId: "conversation-1",
      revision: 1,
      messages: source,
      policy: { maxRetainedMessageUnits: 1, maxSummaryTokens: 40 },
    });
    const second = await compactDurableContext({
      operationId: "compaction-2",
      contextId: "conversation-1",
      revision: 1,
      messages: source,
      policy: { maxRetainedMessageUnits: 1, maxSummaryTokens: 40 },
    });

    expect(source).toEqual(baseMessages);
    expect(first.summary).toBe(second.summary);
    expect(first.revision.source).toBe("deterministic_fallback");
    expect(first.summary).toContain("The first durable fact is blue.");
    expect(first.summary).not.toContain("A fact not present in the transcript");
    expect(first.diagnostics.summaryTokens).toBeLessThanOrEqual(40);
    expect(first.diagnostics.omittedMessageCount).toBe(2);
    expect(first.messages.at(-1)).toEqual(baseMessages.at(-1));
  });

  it("falls back when the optional provider fails and passes stable operation identity", async () => {
    const calls: string[] = [];
    const provider: ContextSummaryProvider = {
      summarize: async (input) => {
        calls.push(`${input.operationId}:${input.contextId}:${input.revision}`);
        throw new Error("provider secret must not escape diagnostics");
      },
    };
    const result = await compactDurableContext({
      operationId: "summary-op-1",
      contextId: "conversation-1",
      revision: 4,
      messages: baseMessages,
      policy: { maxRetainedMessageUnits: 1, maxSummaryTokens: 12 },
      summaryProvider: provider,
    });

    expect(calls).toEqual(["summary-op-1:conversation-1:4"]);
    expect(result.revision.source).toBe("deterministic_fallback");
    expect(result.diagnostics.providerFailureCode).toBe("provider_error");
    expect(result.diagnostics).not.toHaveProperty("summary");
    expect(result.diagnostics).not.toHaveProperty("provider secret");
    expect(result.diagnostics.summaryTokens).toBeLessThanOrEqual(12);
  });

  it("bounds a provider that never resolves", async () => {
    const provider: ContextSummaryProvider = {
      summarize: async () => new Promise(() => undefined),
    };
    const result = await compactDurableContext({
      operationId: "timeout-op-1",
      contextId: "conversation-1",
      revision: 1,
      messages: baseMessages,
      policy: { maxRetainedMessageUnits: 1, maxSummaryTokens: 20, providerTimeoutMs: 5 },
      summaryProvider: provider,
    });

    expect(result.revision.source).toBe("deterministic_fallback");
    expect(result.diagnostics.providerFailureCode).toBe("provider_timeout");
  });

  it("replays an immutable durable revision without invoking the provider twice", async () => {
    const adapter = new MemoryContextAdapter();
    const provider = { summarize: vi.fn(async () => ({ summary: "Evidence-preserving provider summary." })) };
    const input = {
      operationId: "replay-op-1",
      contextId: "conversation-1",
      revision: 2,
      messages: baseMessages,
      policy: { maxRetainedMessageUnits: 1, maxSummaryTokens: 20 },
      adapter,
      summaryProvider: provider,
    } as const;

    const first = await compactDurableContext(input);
    const replay = await compactDurableContext(input);

    expect(provider.summarize).toHaveBeenCalledTimes(1);
    expect(adapter.writes).toHaveLength(1);
    expect(first.revision).toEqual(replay.revision);
    expect(replay.diagnostics.replayed).toBe(true);
    expect(replay.diagnostics.providerFailureCode).toBeUndefined();
  });

  it("rejects a same-operation replay with different durable source", async () => {
    const adapter = new MemoryContextAdapter();
    const input = {
      operationId: "conflict-op-1",
      contextId: "conversation-1",
      revision: 1,
      messages: baseMessages,
      policy: { maxRetainedMessageUnits: 1 },
      adapter,
    } as const;
    await compactDurableContext(input);

    await expect(compactDurableContext({
      ...input,
      messages: [...baseMessages, { role: "user", content: "changed source" }],
    })).rejects.toMatchObject({ code: "replay_conflict", operationId: "conflict-op-1" });
  });

  it("keeps assistant tool-call/result pairs together in the retained projection", async () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "older request" },
      { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "lookup", arguments: { key: "x" } }] },
      { role: "tool", name: "lookup", toolCallId: "call-1", content: "durable result" },
    ];
    const result = await compactDurableContext({
      operationId: "pair-op-1",
      contextId: "conversation-1",
      revision: 1,
      messages,
      policy: { maxRetainedMessageUnits: 1, maxSummaryTokens: 20 },
    });

    expect(result.diagnostics.protectedPairCount).toBe(1);
    expect(result.messages.map((message) => message.role)).toEqual(["system", "assistant", "tool"]);
    expect(result.messages[1]?.toolCalls?.[0]?.id).toBe("call-1");
    expect(result.messages[2]?.toolCallId).toBe("call-1");
    expect(result.diagnostics.omittedMessageCount).toBe(1);
  });

  it("keeps fallback output within a hard character/token bound", () => {
    const summary = deterministicFallbackSummary([
      { role: "user", content: "x".repeat(500) },
      { role: "assistant", content: "y".repeat(500) },
    ], 10, 2);
    expect(summary.length).toBeLessThanOrEqual(20);
  });

  it("exposes compaction through ContextEngine with redacted journal diagnostics", async () => {
    const events: ContextEngineJournalEvent[] = [];
    const engine = new ContextEngine({
      journal: (event) => events.push(event),
      compactionPolicy: { maxRetainedMessageUnits: 1, maxSummaryTokens: 20 },
    });
    const started = engine.startTurn({
      turnId: "engine-turn-1",
      request: {
        profile: { provider: "openai", model: "test", contextWindowTokens: 1_000, maxOutputTokens: 100 },
        policy: { requestedOutputTokens: 50, maxToolSchemaTokens: 100, maxToolResultTokens: 100 },
        messages: baseMessages,
      },
    });

    const compacted = await engine.compactContext(started.handle);
    const planned = engine.requestPlan(started.handle);

    expect(compacted.messages).toContainEqual(expect.objectContaining({ content: expect.stringContaining("durable-context-summary") }));
    expect(planned.diagnostics.compactionStatus).toBe("completed");
    expect(events.map((event) => event.lifecycle)).toEqual(["turn_start", "context_compaction", "request_plan"]);
    const compactionEvent = events[1];
    expect(compactionEvent?.lifecycle).toBe("context_compaction");
    if (compactionEvent?.lifecycle === "context_compaction") {
      expect(compactionEvent).not.toHaveProperty("summary");
      expect(compactionEvent.diagnostics).not.toHaveProperty("messages");
      expect(compactionEvent.compaction).not.toHaveProperty("summary");
    }
  });
});
