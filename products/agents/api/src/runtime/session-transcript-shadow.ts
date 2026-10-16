import type { ModelMessage } from "../model/types";
import { transcriptDigest } from "./transcript";

export interface SessionTranscriptShadowEntry {
  readonly idempotencyKey: string;
  readonly message: ModelMessage;
  readonly kind?: string;
}

export interface SessionTranscriptShadowComparison {
  readonly status: "match" | "mismatch" | "skipped";
  readonly reason?: "bound_exceeded";
  readonly expectedCount: number;
  readonly canonicalCount: number;
  readonly missingCount: number;
  readonly canonicalOnlyCount: number;
  readonly contentMismatchCount: number;
  readonly orderMatches: boolean;
  readonly expectedDigest: string;
  readonly canonicalDigest: string;
}

const DEFAULT_MAX_ENTRIES = 128;

/**
 * Compare the bounded legacy bootstrap projection with the canonical active
 * transcript without putting message bodies into operational telemetry.
 * Canonical-only rows are intentionally reported rather than discarded: live
 * tool rounds and other Track B entries should become expected once that
 * workstream owns the admission boundary.
 */
export function compareSessionTranscriptShadow(input: {
  readonly expected: readonly SessionTranscriptShadowEntry[];
  readonly canonical: readonly SessionTranscriptShadowEntry[];
  readonly maxEntries?: number;
}): SessionTranscriptShadowComparison {
  const maxEntries = input.maxEntries ?? DEFAULT_MAX_ENTRIES;
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0) throw new Error("SESSION_TRANSCRIPT_SHADOW_BOUND_INVALID");
  if (input.expected.length > maxEntries || input.canonical.length > maxEntries) {
    return {
      status: "skipped",
      reason: "bound_exceeded",
      expectedCount: input.expected.length,
      canonicalCount: input.canonical.length,
      missingCount: 0,
      canonicalOnlyCount: 0,
      contentMismatchCount: 0,
      orderMatches: false,
      expectedDigest: transcriptDigest(input.expected.map((entry) => entry.message)),
      canonicalDigest: transcriptDigest(input.canonical.map((entry) => entry.message)),
    };
  }

  const expectedByKey = new Map(input.expected.map((entry) => [entry.idempotencyKey, entry]));
  const canonicalByKey = new Map(input.canonical.map((entry) => [entry.idempotencyKey, entry]));
  const missingCount = input.expected.filter((entry) => !canonicalByKey.has(entry.idempotencyKey)).length;
  const canonicalOnlyCount = input.canonical.filter((entry) => !expectedByKey.has(entry.idempotencyKey)).length;
  const contentMismatchCount = input.expected.filter((entry) => {
    const canonical = canonicalByKey.get(entry.idempotencyKey);
    return canonical !== undefined && transcriptDigest([entry.message]) !== transcriptDigest([canonical.message]);
  }).length;
  const canonicalExpectedKeys = input.canonical
    .filter((entry) => expectedByKey.has(entry.idempotencyKey))
    .map((entry) => entry.idempotencyKey);
  const orderMatches = canonicalExpectedKeys.length === input.expected.length
    && canonicalExpectedKeys.every((key, index) => key === input.expected[index]?.idempotencyKey);
  const expectedDigest = transcriptDigest(input.expected.map((entry) => entry.message));
  const canonicalDigest = transcriptDigest(input.canonical.map((entry) => entry.message));
  const status = missingCount === 0 && canonicalOnlyCount === 0 && contentMismatchCount === 0 && orderMatches && expectedDigest === canonicalDigest
    ? "match"
    : "mismatch";
  return {
    status,
    expectedCount: input.expected.length,
    canonicalCount: input.canonical.length,
    missingCount,
    canonicalOnlyCount,
    contentMismatchCount,
    orderMatches,
    expectedDigest,
    canonicalDigest,
  };
}
