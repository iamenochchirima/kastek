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
import { InMemoryContextAttemptBudget } from "../src/runtime/context-attempt-budget";
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

  public async readLatest(contextId: string): Promise<number> {
    return Math.max(0, ...[...this.records.values()]
      .filter((record) => record.compaction.contextId === contextId)
      .map((record) => record.compaction.generation));
  }

  public async persist(input: DurableContextPersistenceInput) {
    const existing = this.records.get(input.decision.operationId);
    if (existing) return { status: "replayed" as const, record: existing };
    const latest = await this.readLatest(input.decision.contextId);
    if (latest !== input.decision.expectedGeneration) throw new Error("CONTEXT_COMPACTION_FENCE_CONFLICT");
    this.writes.push(input);
    const record = { decision: input.decision, compaction: input.compaction };
    this.records.set(input.decision.operationId, record);
    return { status: "created" as const, record };
  }
}

class CrashAfterCommitAdapter extends MemoryContextAdapter {
  private crashed = false;

  public override async persist(input: DurableContextPersistenceInput) {
    const result = await super.persist(input);
    if (!this.crashed) {
      this.crashed = true;
      throw new Error("WORKER_LOST_AFTER_COMPACTION_COMMIT");
    }
    return result;
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
    expect(first.diagnostics.projectionDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(replay.diagnostics.projectionDigest).toBe(first.diagnostics.projectionDigest);
    expect(replay.diagnostics.replayed).toBe(true);
    expect(replay.diagnostics.providerFailureCode).toBeUndefined();
  });

  it("rejects a replay when the durable projection digest does not match", async () => {
    const baseAdapter = new MemoryContextAdapter();
    let tamperProjection = false;
    const adapter: DurableContextAdapter = {
      read: async (operationId) => {
        const record = await baseAdapter.read(operationId);
        if (!record || !tamperProjection) return record;
        return {
          ...record,
          compaction: {
            ...record.compaction,
            projectionDigest: "0".repeat(64),
          },
        };
      },
      readLatest: (contextId) => baseAdapter.readLatest(contextId),
      persist: (input) => baseAdapter.persist(input),
    };
    const input = {
      operationId: "projection-replay-conflict-1",
      contextId: "conversation-1",
      revision: 1,
      messages: baseMessages,
      policy: { maxRetainedMessageUnits: 1 },
      adapter,
    } as const;

    const first = await compactDurableContext(input);
    tamperProjection = true;

    expect(first.diagnostics.projectionDigest).not.toBe("0".repeat(64));
    await expect(compactDurableContext(input)).rejects.toMatchObject({
      code: "replay_conflict",
      operationId: input.operationId,
    });
  });

  it("replays after a worker is lost after the durable commit", async () => {
    const adapter = new CrashAfterCommitAdapter();
    const provider = { summarize: vi.fn(async () => ({ summary: "Durable worker-loss summary." })) };
    const input = {
      operationId: "worker-loss-after-commit-1",
      contextId: "conversation-1",
      revision: 2,
      messages: baseMessages,
      policy: { maxRetainedMessageUnits: 1, maxSummaryTokens: 20 },
      adapter,
      summaryProvider: provider,
    } as const;

    await expect(compactDurableContext(input)).rejects.toMatchObject({ code: "persistence_failed" });
    const replay = await compactDurableContext(input);

    expect(replay.diagnostics.replayed).toBe(true);
    expect(replay.summary).toBe("Durable worker-loss summary.");
    expect(provider.summarize).toHaveBeenCalledOnce();
    expect(replay.messages.some((message) => message.content.includes("Durable worker-loss summary."))).toBe(true);
  });

  it("emits content-free lifecycle telemetry without making telemetry part of the commit", async () => {
    const adapter = new MemoryContextAdapter();
    const events: Array<{ type: string; operationId: string; sourceDigest?: string; reason?: string }> = [];
    const input = {
      operationId: "telemetry-op-1",
      contextId: "conversation-1",
      revision: 1,
      messages: baseMessages,
      policy: { maxRetainedMessageUnits: 1, maxSummaryTokens: 20 },
      adapter,
      onCompactionEvent: (event: typeof events[number]) => { events.push(event); },
    } as const;

    await compactDurableContext(input);
    await compactDurableContext(input);

    expect(events.map((event) => event.type)).toEqual([
      "compaction_attempted",
      "compaction_candidate_created",
      "compaction_committed",
      "compaction_replayed",
    ]);
    expect(events.every((event) => event.operationId === "telemetry-op-1")).toBe(true);
    expect(events.every((event) => typeof event.sourceDigest === "string")).toBe(true);

    const deferred: Array<{ type: string; reason?: string }> = [];
    await expect(compactDurableContext({
      operationId: "telemetry-op-2",
      contextId: "conversation-1",
      revision: 2,
      messages: [{ role: "user", content: "short" }],
      policy: { maxRetainedMessageUnits: 20 },
      onCompactionEvent: (event) => { deferred.push(event); },
    })).rejects.toMatchObject({ code: "no_progress" });
    expect(deferred.map((event) => event.type)).toEqual(["compaction_deferred", "compaction_ineffective", "compaction_terminal"]);

    await compactDurableContext({
      ...input,
      operationId: "telemetry-op-3",
      onCompactionEvent: () => { throw new Error("telemetry sink unavailable"); },
    });
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

  it("uses a compare-and-swap generation and rejects a stale compaction worker", async () => {
    const adapter = new MemoryContextAdapter();
    await compactDurableContext({
      operationId: "generation-op-1",
      contextId: "conversation-1",
      revision: 1,
      messages: baseMessages,
      policy: { maxRetainedMessageUnits: 1 },
      adapter,
      fenceToken: "lease-1",
    });

    await expect(compactDurableContext({
      operationId: "generation-op-stale",
      contextId: "conversation-1",
      revision: 2,
      expectedGeneration: 0,
      messages: baseMessages,
      policy: { maxRetainedMessageUnits: 1 },
      adapter,
      fenceToken: "old-lease",
    })).rejects.toMatchObject({ code: "fence_conflict", operationId: "generation-op-stale" });

    const next = await compactDurableContext({
      operationId: "generation-op-2",
      contextId: "conversation-1",
      revision: 2,
      messages: [...baseMessages, { role: "user", content: "new source" }],
      policy: { maxRetainedMessageUnits: 1 },
      adapter,
      fenceToken: "lease-2",
    });
    expect(next.revision.generation).toBe(2);
    expect(next.revision.expectedGeneration).toBe(1);
  });

  it("shares one bounded durable attempt budget across compaction operations", async () => {
    const budget = new InMemoryContextAttemptBudget({ maxAttempts: 1, budgetId: "run-1:context-attempts" });
    await compactDurableContext({
      operationId: "budgeted-compaction-1",
      contextId: "conversation-1",
      revision: 1,
      messages: baseMessages,
      policy: { maxRetainedMessageUnits: 1, maxSummaryTokens: 20 },
      contextAttemptBudget: budget,
      contextAttemptBudgetId: "run-1:context-attempts",
      contextAttemptRunId: "run-1",
      contextAttemptTurnId: "turn-1",
    });

    await expect(compactDurableContext({
      operationId: "budgeted-compaction-2",
      contextId: "conversation-1",
      revision: 2,
      messages: [...baseMessages, { role: "user", content: "new source" }],
      policy: { maxRetainedMessageUnits: 1, maxSummaryTokens: 20 },
      contextAttemptBudget: budget,
      contextAttemptBudgetId: "run-1:context-attempts",
      contextAttemptRunId: "run-1",
      contextAttemptTurnId: "turn-1",
    })).rejects.toMatchObject({ code: "attempt_budget_exhausted" });
  });

  it("blocks a cancelled or stale-fenced compaction before publishing a revision", async () => {
    const adapter = new MemoryContextAdapter();
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(compactDurableContext({
      operationId: "cancelled-op-1",
      contextId: "conversation-1",
      revision: 1,
      messages: baseMessages,
      adapter,
      signal: cancelled.signal,
    })).rejects.toMatchObject({ code: "cancelled" });

    await expect(compactDurableContext({
      operationId: "stale-fence-op-1",
      contextId: "conversation-1",
      revision: 1,
      messages: baseMessages,
      adapter,
      assertFenceCurrent: () => { throw new Error("SESSION_LEASE_STALE"); },
    })).rejects.toMatchObject({ code: "fence_conflict" });
    expect(adapter.writes).toHaveLength(0);
  });

  it("captures a checkpoint on a turn that does not need a lossy projection", async () => {
    const checkpoint = vi.fn(async () => ({ checkpointId: "checkpoint-1", status: "committed" as const }));
    const result = await compactDurableContext({
      operationId: "checkpoint-only-op-1",
      contextId: "conversation-1",
      revision: 1,
      messages: [
        { role: "system", content: "Configured policy." },
        { role: "user", content: "A short request." },
      ],
      policy: { maxRetainedMessageUnits: 20 },
      memoryCheckpointPort: { checkpoint },
      memoryCheckpointRequired: true,
      memoryRunId: "run-1",
      memoryTurnId: "turn-1",
      memoryScope: {
        organizationId: "org-1",
        workspaceId: "workspace-1",
        agentDefinitionId: "agent-1",
        agentVersionId: "version-1",
        installationId: "installation-1",
        namespace: "conversation",
      },
    });

    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(result.diagnostics.omittedMessageCount).toBe(0);
    expect(result.messages.at(-1)).toEqual({ role: "user", content: "A short request." });
  });

  it("keeps assistant tool-call/result pairs together in the retained projection", async () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "older request" },
      { role: "assistant", content: "", toolCalls: [{ id: "call-1", name: "lookup", arguments: { key: "x" } }] },
      { role: "tool", name: "lookup", toolCallId: "call-1", content: "durable result" },
      { role: "user", content: "current request" },
    ];
    const result = await compactDurableContext({
      operationId: "pair-op-1",
      contextId: "conversation-1",
      revision: 1,
      messages,
      policy: { maxRetainedMessageUnits: 2, maxSummaryTokens: 20 },
    });

    expect(result.diagnostics.protectedPairCount).toBe(1);
    expect(result.messages.map((message) => message.role)).toEqual(["system", "assistant", "tool", "user"]);
    expect(result.messages[1]?.toolCalls?.[0]?.id).toBe("call-1");
    expect(result.messages[2]?.toolCallId).toBe("call-1");
    expect(result.diagnostics.omittedMessageCount).toBe(1);
  });

  it("protects the active user task even when a later tail would otherwise displace it", async () => {
    const result = await compactDurableContext({
      operationId: "active-task-protection-1",
      contextId: "conversation-1",
      revision: 1,
      messages: [
        { role: "user", content: "active task" },
        { role: "assistant", content: "stale follow-up" },
        { role: "assistant", content: "latest tail" },
      ],
      policy: { maxRetainedMessageUnits: 1, maxSummaryTokens: 20 },
    });

    expect(result.messages).toContainEqual({ role: "user", content: "active task" });
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
    const started = await engine.startTurn({
      turnId: "engine-turn-1",
      request: {
        profile: { provider: "openai", model: "test", contextWindowTokens: 1_000, maxOutputTokens: 100 },
        policy: { requestedOutputTokens: 50, maxToolSchemaTokens: 100, maxToolResultTokens: 100 },
        messages: baseMessages,
      },
    });

    const compacted = await engine.compactContext(started.handle);
    const planned = await engine.requestPlan(started.handle);

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
