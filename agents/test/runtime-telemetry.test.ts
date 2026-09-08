import { describe, expect, it } from "vitest";
import { RuntimeTelemetryAccumulator } from "../src/runtime/runtime-telemetry";

describe("runtime telemetry accumulator", () => {
  it("increments a projection revision for journal-correlated snapshots", () => {
    const telemetry = new RuntimeTelemetryAccumulator({ runId: "run-1" });
    expect(telemetry.snapshot().revision).toBe(0);
    expect(telemetry.apply({ type: "loop.started", payload: {}, observedAt: "2026-09-07T00:00:00.000Z" }).revision).toBe(1);
    expect(telemetry.apply({ type: "model.started", payload: {}, observedAt: "2026-09-07T00:00:01.000Z" }).revision).toBe(2);
  });

  it("keeps compaction unknown until provider usage re-anchors occupancy", () => {
    const telemetry = new RuntimeTelemetryAccumulator();
    telemetry.apply({ type: "loop.started", payload: {}, observedAt: "2026-09-07T00:00:00.000Z" });
    telemetry.apply({
      type: "context.planned",
      payload: {
        decision: "compact",
        accounting: { estimatedInputTokens: 900, contextWindowTokens: 1_000, capabilitySource: "configured_override", reservedOutputTokens: 80, safetyMarginTokens: 20 },
        manifest: { schemaVersion: "v1", digest: "digest-1", sourceMessageCount: 12, selectedMessageCount: 4, sourceToolCount: 2, selectedToolCount: 2, components: [] },
      },
      observedAt: "2026-09-07T00:00:01.000Z",
    });
    expect(telemetry.snapshot().context).toMatchObject({ basis: "unknown_after_compaction", tokens: undefined, utilizationPercent: undefined, compactionCount: 1 });

    telemetry.apply({ type: "model.started", payload: { provider: "openai", model: "test", queuedAt: "2026-09-07T00:00:01.500Z", startedAt: "2026-09-07T00:00:02.000Z" }, observedAt: "2026-09-07T00:00:02.000Z" });
    const snapshot = telemetry.apply({
      type: "model.completed",
      payload: { provider: "openai", model: "test", inputTokens: 640, outputTokens: 50, latencyMs: 2_000, contextMeasurementBasis: "provider_reported" },
      observedAt: "2026-09-07T00:00:04.000Z",
    });

    expect(snapshot.context).toMatchObject({ basis: "provider_reported", tokens: 640, utilizationPercent: 64 });
    expect(snapshot.modelAttempt).toMatchObject({ status: "completed", queuedAt: "2026-09-07T00:00:01.500Z", throughputTokensPerSecond: 25 });
  });

  it("keeps deterministic wire pruning measurable", () => {
    const telemetry = new RuntimeTelemetryAccumulator();
    const snapshot = telemetry.apply({
      type: "context.planned",
      payload: {
        decision: "prune",
        accounting: { estimatedInputTokens: 240, contextWindowTokens: 1_000, capabilitySource: "catalog" },
        manifest: { schemaVersion: "v1", digest: "manifest-prune", sourceMessageCount: 6, selectedMessageCount: 4, sourceToolCount: 2, selectedToolCount: 2, components: [] },
      },
      observedAt: "2026-09-07T00:00:00.000Z",
    });
    expect(snapshot.context).toMatchObject({ basis: "full_estimate", tokens: 240, utilizationPercent: 24 });
  });

  it("keeps current occupancy, cumulative usage, and run budget distinct", () => {
    const telemetry = new RuntimeTelemetryAccumulator();
    telemetry.apply({
      type: "loop.started",
      payload: { budget: { maxTotalTokens: 500 } },
      observedAt: "2026-09-07T00:00:00.000Z",
    });
    telemetry.apply({
      type: "context.planned",
      payload: {
        decision: "ready",
        accounting: { estimatedInputTokens: 120, contextWindowTokens: 1_000, capabilitySource: "provider_metadata" },
        manifest: { schemaVersion: "v1", digest: "manifest-usage", sourceMessageCount: 2, selectedMessageCount: 2, sourceToolCount: 0, selectedToolCount: 0, components: [] },
      },
      observedAt: "2026-09-07T00:00:00.100Z",
    });
    const snapshot = telemetry.apply({
      type: "model.completed",
      payload: {
        inputTokens: 120,
        outputTokens: 20,
        totalTokens: 140,
        inputTokensReported: true,
        outputTokensReported: true,
        totalTokensReported: true,
        latencyMs: 100,
        contextMeasurementBasis: "provider_reported",
      },
      observedAt: "2026-09-07T00:00:00.200Z",
    });

    expect(snapshot.context).toMatchObject({ tokens: 120, contextWindowTokens: 1_000, utilizationPercent: 12 });
    expect(snapshot.usage).toMatchObject({ inputTokens: 120, outputTokens: 20, totalTokens: 140, basis: "provider_reported" });
    expect(snapshot.runBudget).toMatchObject({ maxTotalTokens: 500, remainingTokens: 360 });
    expect(snapshot.context.tokens).not.toBe(snapshot.usage.totalTokens);
  });

  it("keeps occupancy unknown through a committed compaction until a provider anchor arrives", () => {
    const telemetry = new RuntimeTelemetryAccumulator();
    telemetry.apply({
      type: "context.planned",
      payload: {
        decision: "ready",
        accounting: { estimatedInputTokens: 120, contextWindowTokens: 1_000 },
        manifest: { schemaVersion: "v1", digest: "before", sourceMessageCount: 2, selectedMessageCount: 2, sourceToolCount: 0, selectedToolCount: 0, components: [] },
      },
      observedAt: "2026-09-07T00:00:00.000Z",
    });
    telemetry.apply({
      type: "compaction_committed",
      payload: { operationId: "compact-1", contextId: "conversation-1", revision: 2 },
      observedAt: "2026-09-07T00:00:01.000Z",
    });
    const afterPlan = telemetry.apply({
      type: "context.planned",
      payload: {
        decision: "ready",
        accounting: { estimatedInputTokens: 80, contextWindowTokens: 1_000 },
        manifest: { schemaVersion: "v1", digest: "after", sourceMessageCount: 2, selectedMessageCount: 2, sourceToolCount: 0, selectedToolCount: 0, components: [] },
      },
      observedAt: "2026-09-07T00:00:02.000Z",
    });
    expect(afterPlan.context).toMatchObject({ basis: "unknown_after_compaction", tokens: undefined, utilizationPercent: undefined });

    const withoutUsage = telemetry.apply({
      type: "model.completed",
      payload: { inputTokens: 0, outputTokens: 4, latencyMs: 100, contextMeasurementBasis: "full_estimate" },
      observedAt: "2026-09-07T00:00:03.000Z",
    });
    expect(withoutUsage.context.basis).toBe("unknown_after_compaction");
    const anchored = telemetry.apply({
      type: "model.completed",
      payload: { inputTokens: 72, outputTokens: 4, latencyMs: 100, contextMeasurementBasis: "provider_reported" },
      observedAt: "2026-09-07T00:00:04.000Z",
    });
    expect(anchored.context).toMatchObject({ basis: "provider_reported", tokens: 72, utilizationPercent: 7.2 });
  });

  it("keeps failed attempt timing visible without inventing provider usage", () => {
    const telemetry = new RuntimeTelemetryAccumulator();
    telemetry.apply({ type: "model.started", payload: { provider: "openai", model: "test", startedAt: "2026-09-07T00:00:00.000Z" }, observedAt: "2026-09-07T00:00:00.000Z" });
    const snapshot = telemetry.apply({ type: "model.failed", payload: { provider: "openai", model: "test", code: "CONTEXT_LENGTH_EXCEEDED", failedAt: "2026-09-07T00:00:00.250Z", latencyMs: 250 }, observedAt: "2026-09-07T00:00:00.250Z" });
    expect(snapshot.modelAttempt).toMatchObject({ status: "failed", errorCode: "CONTEXT_LENGTH_EXCEEDED", latencyMs: 250, completedAt: "2026-09-07T00:00:00.250Z" });
    expect(snapshot.attempts).toHaveLength(1);
    expect(snapshot.context.tokens).toBeUndefined();
  });

  it("keeps queue and prompt-to-first-token timing on the durable attempt", () => {
    const telemetry = new RuntimeTelemetryAccumulator();
    telemetry.apply({
      type: "model.started",
      payload: {
        operationKey: "model:timing",
        provider: "openai",
        model: "test",
        queuedAt: "2026-09-07T00:00:00.000Z",
        startedAt: "2026-09-07T00:00:00.250Z",
      },
      observedAt: "2026-09-07T00:00:00.250Z",
    });
    telemetry.apply({
      type: "model.first_token",
      payload: {
        operationKey: "model:timing",
        firstTokenAt: "2026-09-07T00:00:01.750Z",
      },
      observedAt: "2026-09-07T00:00:01.750Z",
    });
    const snapshot = telemetry.apply({
      type: "model.completed",
      payload: {
        operationKey: "model:timing",
        provider: "openai",
        model: "test",
        outputTokens: 8,
        latencyMs: 2_000,
      },
      observedAt: "2026-09-07T00:00:02.250Z",
    });

    expect(snapshot.modelAttempt).toMatchObject({
      queueMs: 250,
      timeToFirstTokenMs: 1_500,
      latencyMs: 2_000,
    });
  });

  it("keeps the original turn clock while recording waits and retries", () => {
    const telemetry = new RuntimeTelemetryAccumulator();
    telemetry.apply({
      type: "loop.started",
      payload: { phase: "turn", admittedAt: "2026-09-07T00:00:00.000Z", startedAt: "2026-09-07T00:00:02.000Z" },
      observedAt: "2026-09-07T00:00:02.000Z",
    });
    telemetry.apply({ type: "loop.started", payload: { phase: "iteration", reason: "context_compacted" }, observedAt: "2026-09-07T00:00:03.000Z" });
    telemetry.apply({ type: "model.started", payload: { operationKey: "model:1:0", provider: "openai", model: "primary", startedAt: "2026-09-07T00:00:03.000Z" }, observedAt: "2026-09-07T00:00:03.000Z" });
    telemetry.apply({ type: "model.failed", payload: { operationKey: "model:1:0", code: "PROVIDER_DOWN", failedAt: "2026-09-07T00:00:04.000Z", latencyMs: 1_000 }, observedAt: "2026-09-07T00:00:04.000Z" });
    telemetry.apply({ type: "loop.paused", payload: { reason: "approval" }, observedAt: "2026-09-07T00:00:05.000Z" });
    telemetry.apply({ type: "loop.started", payload: { phase: "turn", startedAt: "2026-09-07T00:00:08.000Z" }, observedAt: "2026-09-07T00:00:08.000Z" });
    telemetry.apply({ type: "model.started", payload: { operationKey: "model:1:1", provider: "openai", model: "fallback", startedAt: "2026-09-07T00:00:08.000Z" }, observedAt: "2026-09-07T00:00:08.000Z" });
    telemetry.apply({ type: "model.completed", payload: { operationKey: "model:1:1", provider: "openai", model: "fallback", outputTokens: 4, latencyMs: 100, contextMeasurementBasis: "full_estimate" }, observedAt: "2026-09-07T00:00:08.100Z" });
    const snapshot = telemetry.apply({ type: "loop.completed", payload: {}, observedAt: "2026-09-07T00:00:10.000Z" });

    expect(snapshot.turn).toMatchObject({ admittedAt: "2026-09-07T00:00:00.000Z", startedAt: "2026-09-07T00:00:02.000Z", elapsedMs: 8_000, waitMs: 3_000 });
    expect(snapshot.attempts).toHaveLength(2);
    expect(snapshot.attempts.map((attempt) => attempt.status)).toEqual(["failed", "completed"]);
  });

  it("computes rolling throughput from totals, not the mean of rates", () => {
    const telemetry = new RuntimeTelemetryAccumulator();
    telemetry.apply({ type: "model.completed", payload: { inputTokens: 1, outputTokens: 100, latencyMs: 2_000 }, observedAt: "2026-09-07T00:00:01.000Z" });
    const snapshot = telemetry.apply({ type: "model.completed", payload: { inputTokens: 1, outputTokens: 200, latencyMs: 4_000 }, observedAt: "2026-09-07T00:00:05.000Z" });
    expect(snapshot.rolling).toMatchObject({ sampleCount: 2, latencyMs: 3_000, outputTokensPerSecond: 50 });
  });

  it("does not double-count a replayed completed attempt", () => {
    const telemetry = new RuntimeTelemetryAccumulator();
    const completed = {
      type: "model.completed",
      payload: { operationKey: "model:1:0", inputTokens: 10, outputTokens: 100, latencyMs: 2_000 },
      observedAt: "2026-09-07T00:00:02.000Z",
    } as const;
    telemetry.apply(completed);
    const snapshot = telemetry.apply(completed);
    expect(snapshot.rolling).toMatchObject({ sampleCount: 1, latencyMs: 2_000, outputTokensPerSecond: 50 });
  });

  it("projects the latest durable compaction lifecycle fact without prompt content", () => {
    const telemetry = new RuntimeTelemetryAccumulator({ runId: "run-1", turnId: "turn-1" });
    telemetry.apply({
      type: "compaction_candidate_created",
      payload: {
        operationId: "compact-1",
        contextId: "conversation-1",
        revision: 2,
        generation: 3,
        source: "deterministic_fallback",
        omittedMessageCount: 4,
        retainedMessageCount: 2,
        reason: "bounded_projection",
      },
    });
    const snapshot = telemetry.snapshot();
    expect(snapshot.context.latestCompaction).toMatchObject({
      type: "compaction_candidate_created",
      operationId: "compact-1",
      contextId: "conversation-1",
      revision: 2,
      generation: 3,
      source: "deterministic_fallback",
      omittedMessageCount: 4,
    });
    expect(snapshot.context.latestCompaction).not.toHaveProperty("summary");
  });

  it("keeps the bounded estimate when a provider omits usage counters", () => {
    const telemetry = new RuntimeTelemetryAccumulator();
    telemetry.apply({
      type: "context.planned",
      payload: {
        decision: "ready",
        accounting: { estimatedInputTokens: 120, contextWindowTokens: 1_000, capabilitySource: "provider_metadata" },
        manifest: { schemaVersion: "v1", digest: "manifest-2", sourceMessageCount: 2, selectedMessageCount: 2, sourceToolCount: 0, selectedToolCount: 0, components: [] },
      },
      observedAt: "2026-09-07T00:00:00.000Z",
    });
    const snapshot = telemetry.apply({
      type: "model.completed",
      payload: { inputTokens: 0, outputTokens: 0, contextMeasurementBasis: "full_estimate", contextUsage: { status: "usage_unavailable" } },
      observedAt: "2026-09-07T00:00:01.000Z",
    });
    expect(snapshot.context).toMatchObject({ basis: "full_estimate", tokens: 120, utilizationPercent: 12 });
  });
});
