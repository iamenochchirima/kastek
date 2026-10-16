import { describe, expect, it } from "vitest";
import {
  createContextUsageAnchor,
  measureInputFromAnchor,
  validateContextUsageAnchor,
  type ContextUsageAnchorBoundary,
} from "../src/runtime/context-usage-anchor";

const boundary: ContextUsageAnchorBoundary = {
  provider: "openai",
  model: "test-model",
  endpointId: "openai:default",
  manifestDigest: "manifest-1",
  sourceDigest: "source-1",
  compactionGeneration: 0,
};

describe("context usage anchors", () => {
  it("anchors provider usage to the exact request and source boundary", () => {
    const anchor = createContextUsageAnchor({
      operationKey: "model:1:0",
      boundary,
      estimatedInputTokens: 600,
      providerInputTokens: 640,
      providerOutputTokens: 50,
      providerTotalTokens: 690,
      recordedAt: "2026-09-07T00:00:00.000Z",
    });

    expect(validateContextUsageAnchor(anchor, boundary)).toEqual({ valid: true, reasons: [] });
    expect(measureInputFromAnchor({ anchor, boundary, estimatedInputTokens: 620, maxDeltaTokens: 64 })).toEqual({
      inputTokens: 660,
      basis: "anchored_estimate",
      anchorOperationKey: "model:1:0",
    });
  });

  it("invalidates after a model, source, or compaction boundary changes", () => {
    const anchor = createContextUsageAnchor({
      operationKey: "model:1:0",
      boundary,
      estimatedInputTokens: 600,
      providerInputTokens: 640,
      providerOutputTokens: 50,
      providerTotalTokens: 690,
    });
    const changed = { ...boundary, model: "fallback-model", compactionGeneration: 1, sourceDigest: "source-2" };
    expect(validateContextUsageAnchor(anchor, changed)).toMatchObject({
      valid: false,
      reasons: ["model_changed", "source_boundary_changed", "compaction_generation_changed"],
    });
    expect(measureInputFromAnchor({ anchor, boundary: changed, estimatedInputTokens: 620, maxDeltaTokens: 64 })).toMatchObject({
      inputTokens: 620,
      basis: "full_estimate",
      reason: "model_changed",
    });
  });

  it("refuses an unbounded estimate delta instead of reusing stale usage", () => {
    const anchor = createContextUsageAnchor({
      operationKey: "model:1:0",
      boundary,
      estimatedInputTokens: 600,
      providerInputTokens: 640,
      providerOutputTokens: 50,
      providerTotalTokens: 690,
    });
    expect(measureInputFromAnchor({ anchor, boundary, estimatedInputTokens: 900, maxDeltaTokens: 64 })).toMatchObject({
      inputTokens: 900,
      basis: "full_estimate",
      reason: "input_delta_exceeded",
    });
  });
});
