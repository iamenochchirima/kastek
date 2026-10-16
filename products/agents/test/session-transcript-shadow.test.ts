import { describe, expect, it } from "vitest";
import { compareSessionTranscriptShadow } from "../src/runtime/session-transcript-shadow";

const expected = [
  { idempotencyKey: "message:1", message: { role: "user" as const, content: "one" } },
  { idempotencyKey: "response:1", message: { role: "assistant" as const, content: "done" } },
];

describe("session transcript shadow comparison", () => {
  it("reports a bounded legacy projection match without exposing message content", () => {
    const result = compareSessionTranscriptShadow({ expected, canonical: expected });
    expect(result).toMatchObject({
      status: "match",
      expectedCount: 2,
      canonicalCount: 2,
      missingCount: 0,
      canonicalOnlyCount: 0,
      contentMismatchCount: 0,
      orderMatches: true,
    });
    expect(result.expectedDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.canonicalDigest).toBe(result.expectedDigest);
  });

  it("reports missing, canonical-only, content, and ordering drift", () => {
    const result = compareSessionTranscriptShadow({
      expected,
      canonical: [
        { idempotencyKey: "response:1", message: { role: "assistant", content: "changed" } },
        { idempotencyKey: "tool:1", message: { role: "tool", content: "result", toolCallId: "call-1" } },
      ],
    });
    expect(result).toMatchObject({
      status: "mismatch",
      missingCount: 1,
      canonicalOnlyCount: 1,
      contentMismatchCount: 1,
      orderMatches: false,
    });
  });

  it("skips projections above the bounded shadow budget", () => {
    const result = compareSessionTranscriptShadow({ expected, canonical: expected, maxEntries: 1 });
    expect(result).toMatchObject({ status: "skipped", reason: "bound_exceeded", expectedCount: 2, canonicalCount: 2 });
  });
});
