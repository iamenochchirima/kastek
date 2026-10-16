import { describe, expect, it } from "vitest";
import {
  detectMemoryConflicts,
  evaluateRetention,
  memoryDecayScore,
  type ConflictRevisionCandidate,
} from "../src/memory/retention";

const defaults = { memoryDays: 365, revalidateAfterDays: 90, revision: 3 };

describe("memory retention and quality domain", () => {
  it("selects record, namespace, type, workspace, then organization rules deterministically", () => {
    const base = {
      organizationId: "org-1",
      workspaceId: "workspace-1",
      namespace: "end_user_private",
      memoryType: "semantic" as const,
      factId: "fact-1",
      observedAt: "2026-01-01T00:00:00.000Z",
      organizationDefaults: defaults,
      now: new Date("2026-02-01T00:00:00.000Z"),
    };
    const result = evaluateRetention({
      ...base,
      rules: [
        { scopeType: "organization", scopeId: "org-1", retentionDays: 300, revalidateAfterDays: 100 },
        { scopeType: "workspace", scopeId: "workspace-1", retentionDays: 200, revalidateAfterDays: 80 },
        { scopeType: "memory_type", scopeId: "workspace-1", memoryType: "semantic", retentionDays: 150, revalidateAfterDays: 70 },
        { scopeType: "namespace", scopeId: "workspace-1", namespace: "end_user_private", retentionDays: 120, revalidateAfterDays: 60 },
        { scopeType: "record", scopeId: "fact-1", factId: "fact-1", retentionDays: 30, revalidateAfterDays: 10 },
      ],
    });
    expect(result).toMatchObject({ source: "record", retentionDays: 30, revalidateAfterDays: 10, expired: true, stale: true });
    expect(result.expiresAt).toBe("2026-01-31T00:00:00.000Z");
    expect(result.revalidateAt).toBe("2026-01-11T00:00:00.000Z");
  });

  it("uses decay as a bounded ranking signal without changing lifecycle truth", () => {
    const old = memoryDecayScore({ observedAt: "2025-01-01T00:00:00.000Z", confidence: 0.6, now: new Date("2026-01-01T00:00:00.000Z") });
    const used = memoryDecayScore({ observedAt: "2025-01-01T00:00:00.000Z", confidence: 0.6, quality: { usage: 100, confirmations: 4, helpfulness: 1 }, now: new Date("2026-01-01T00:00:00.000Z") });
    expect(old).toBeGreaterThanOrEqual(0);
    expect(old).toBeLessThanOrEqual(1);
    expect(used).toBeGreaterThan(old);
  });

  it("detects fact-key, entity, and validity conflicts while treating explicit corrections as resolved lineage", () => {
    const candidates: ConflictRevisionCandidate[] = [
      {
        revisionId: "revision-a",
        factId: "fact-a",
        factKey: "customer:timezone",
        subjectKey: "customer-1",
        predicateKey: "timezone",
        canonicalText: "Customer is in UTC+2",
        lifecycleState: "active",
        transitionType: "assertion",
        validFrom: "2026-01-01T00:00:00.000Z",
      },
      {
        revisionId: "revision-b",
        factId: "fact-b",
        factKey: "customer:timezone",
        subjectKey: "customer-1",
        predicateKey: "timezone",
        canonicalText: "Customer is in UTC-5",
        lifecycleState: "review_pending",
        transitionType: "assertion",
        validFrom: "2026-01-02T00:00:00.000Z",
      },
      {
        revisionId: "revision-c",
        factId: "fact-c",
        factKey: "customer:timezone-corrected",
        subjectKey: "customer-1",
        predicateKey: "timezone",
        canonicalText: "Customer is in UTC+1",
        lifecycleState: "active",
        transitionType: "correction",
        predecessorRevisionId: "revision-a",
        validFrom: "2026-01-03T00:00:00.000Z",
      },
    ];
    const conflicts = detectMemoryConflicts(candidates);
    expect(conflicts.some((conflict) => conflict.conflictType === "fact_key" && !conflict.resolved)).toBe(true);
    expect(conflicts.some((conflict) => conflict.conflictType === "entity_overlap" && !conflict.resolved)).toBe(true);
    expect(conflicts.some((conflict) => conflict.conflictType === "validity_overlap")).toBe(true);
    expect(conflicts.some((conflict) => conflict.conflictType === "explicit_correction" && conflict.resolved)).toBe(true);
  });

  it("does not create conflicts for identical values, non-overlapping validity, or terminal revisions", () => {
    const candidates: ConflictRevisionCandidate[] = [
      { revisionId: "a", factId: "a", factKey: "x", subjectKey: "s", predicateKey: "p", canonicalText: "same", lifecycleState: "active", transitionType: "assertion", validFrom: "2026-01-01T00:00:00.000Z", validTo: "2026-01-02T00:00:00.000Z" },
      { revisionId: "b", factId: "b", factKey: "x", subjectKey: "s", predicateKey: "p", canonicalText: "same", lifecycleState: "active", transitionType: "assertion", validFrom: "2026-01-02T00:00:00.000Z" },
      { revisionId: "c", factId: "c", factKey: "x", subjectKey: "s", predicateKey: "p", canonicalText: "different", lifecycleState: "expired", transitionType: "expiration", validFrom: "2026-01-01T00:00:00.000Z" },
    ];
    expect(detectMemoryConflicts(candidates)).toEqual([]);
  });

  it("keeps a concurrent correction open for review instead of treating it as resolved lineage", () => {
    const conflicts = detectMemoryConflicts([
      {
        revisionId: "winner",
        factId: "fact-1",
        factKey: "customer:timezone",
        subjectKey: "customer-1",
        predicateKey: "timezone",
        canonicalText: "Customer is in UTC+2",
        lifecycleState: "active",
        transitionType: "correction",
        predecessorRevisionId: "revision-before-race",
        validFrom: "2026-01-02T00:00:00.000Z",
      },
      {
        revisionId: "loser",
        factId: "fact-1",
        factKey: "customer:timezone",
        subjectKey: "customer-1",
        predicateKey: "timezone",
        canonicalText: "Customer is in UTC-5",
        lifecycleState: "review_pending",
        transitionType: "correction",
        predecessorRevisionId: "winner",
        provenance: { conflictType: "concurrent_correction" },
        validFrom: "2026-01-02T00:00:01.000Z",
      },
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ conflictType: "fact_key", resolved: false });
  });
});
