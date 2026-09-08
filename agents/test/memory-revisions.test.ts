import { describe, expect, it } from "vitest";
import {
  assertMemoryRevisionTransition,
  assertExpectedPredecessor,
  memoryRevisionFingerprint,
  normalizeMemoryFactIdentity,
  normalizeMemoryRevisionInput,
  resolveCurrentMemoryRevision,
  type MemoryRevisionRecord,
} from "../src/memory/revisions";
import { canonicalFactKey } from "../src/memory/contracts";

const semanticFact = {
  organizationId: "org-1",
  workspaceId: "workspace-1",
  agentDefinitionId: "agent-1",
  installationId: "installation-1",
  namespace: "end_user_private" as const,
  memoryType: "semantic" as const,
  endUserId: "customer-1",
  subjectKey: "customer-1",
  predicateKey: "reply_style",
  factKey: "customer-1:reply_style",
};

function semanticRevision(overrides: Partial<Parameters<typeof normalizeMemoryRevisionInput>[0]> = {}) {
  return normalizeMemoryRevisionInput({
    memoryType: "semantic",
    lifecycleState: "active",
    canonicalText: "Customer prefers concise replies",
    typedValue: { value: "concise" },
    validFrom: "2026-09-01T00:00:00.000Z",
    sourceTrust: "user_explicit",
    evidenceDigest: "sha256:one",
    extractionVersion: "manual-v1",
    sourceEventIds: ["event-1"],
    idempotencyKey: "remember:customer-1:reply-style:one",
    createdBy: "user-1",
    ...overrides,
  });
}

function revision(id: string, revisionNumber: number, overrides: Partial<MemoryRevisionRecord> = {}): MemoryRevisionRecord {
  return {
    id,
    factId: "fact-1",
    memoryType: "semantic",
    transitionType: "assertion",
    lifecycleState: "active",
    canonicalText: `value-${revisionNumber}`,
    typedValue: { value: revisionNumber },
    validFrom: "2026-09-01T00:00:00.000Z",
    sourceTrust: "user_explicit",
    sensitivity: "normal",
    provenance: {},
    evidenceDigest: `digest-${revisionNumber}`,
    extractionVersion: "manual-v1",
    sourceEventIds: [`event-${revisionNumber}`],
    redactionClass: "standard",
    idempotencyKey: `idempotency-${revisionNumber}`,
    createdBy: "user-1",
    revisionNumber,
    committedAt: "2026-09-01T00:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("canonical memory revision domain", () => {
  it("keeps the four factual namespaces distinct and rejects cross-scope identifiers", () => {
    const common = {
      organizationId: "org-1",
      workspaceId: "workspace-1",
      agentDefinitionId: "agent-1",
      installationId: "installation-1",
      memoryType: "semantic" as const,
      subjectKey: "customer-1",
      predicateKey: "reply_style",
    };
    const matrix = [
      { namespace: "end_user_private" as const, endUserId: "customer-1" },
      { namespace: "conversation" as const, conversationId: "conversation-1" },
      { namespace: "agent_private" as const },
      { namespace: "workspace_shared" as const },
    ].map((scope) => normalizeMemoryFactIdentity({
      ...common,
      ...scope,
      factKey: canonicalFactKey({ ...common, ...scope, subject: common.subjectKey, predicate: common.predicateKey }),
    }));

    expect(matrix.map((scope) => scope.namespace)).toEqual([
      "end_user_private",
      "conversation",
      "agent_private",
      "workspace_shared",
    ]);
    expect(new Set(matrix.map((scope) => scope.factKey)).size).toBe(4);
    expect(() => normalizeMemoryFactIdentity({
      ...common,
      namespace: "conversation",
      conversationId: "conversation-1",
      endUserId: "customer-1",
      factKey: "fact:conversation-with-user",
    })).toThrow("CONVERSATION_SCOPE_CANNOT_HAVE_END_USER");
    expect(() => normalizeMemoryFactIdentity({
      ...common,
      namespace: "workspace_shared",
      conversationId: "conversation-1",
      factKey: "fact:workspace-with-conversation",
    })).toThrow("CONVERSATION_SCOPE_NOT_ALLOWED");
    expect(() => normalizeMemoryFactIdentity({
      ...common,
      namespace: "agent_private",
      endUserId: "customer-1",
      factKey: "fact:agent-with-user",
    })).toThrow("END_USER_SCOPE_NOT_ALLOWED");
  });

  it("normalizes scope and rejects value-dependent or incomplete scopes", () => {
    expect(normalizeMemoryFactIdentity({ ...semanticFact, factKey: " customer-1:reply_style " })).toMatchObject({
      factKey: "customer-1:reply_style",
      endUserId: "customer-1",
    });
    expect(() => normalizeMemoryFactIdentity({ ...semanticFact, endUserId: undefined })).toThrow("END_USER_SCOPE_REQUIRED");
    expect(() => normalizeMemoryFactIdentity({ ...semanticFact, namespace: "conversation", conversationId: undefined, endUserId: undefined })).toThrow("CONVERSATION_SCOPE_REQUIRED");
  });

  it("requires explicit evidence and validity for semantic revisions", () => {
    expect(semanticRevision()).toMatchObject({
      transitionType: "assertion",
      sourceEventIds: ["event-1"],
      sensitivity: "normal",
      redactionClass: "standard",
    });
    expect(() => semanticRevision({ sourceEventIds: [] })).toThrow("MEMORY_SOURCE_EVENT_REQUIRED");
    expect(() => semanticRevision({ validFrom: "2026-09-02T00:00:00.000Z", validTo: "2026-09-01T00:00:00.000Z" })).toThrow("MEMORY_VALIDITY_INTERVAL_INVALID");
    expect(() => semanticRevision({ transitionType: "correction" })).toThrow("TRANSITION_PREDECESSOR_REQUIRED");
  });

  it("requires event metadata for episodic revisions and keeps semantic events separate", () => {
    expect(() => normalizeMemoryRevisionInput({
      ...semanticRevision(),
      memoryType: "episodic",
    })).toThrow("EPISODIC_EVENT_TIME_REQUIRED");
    expect(() => semanticRevision({ eventTime: "2026-09-01T01:00:00.000Z" })).toThrow("SEMANTIC_EVENT_TIME_NOT_ALLOWED");
    expect(normalizeMemoryRevisionInput({
      ...semanticRevision(),
      memoryType: "episodic",
      eventTime: "2026-09-01T01:00:00.000Z",
      eventSummary: "Customer selected the concise reply style",
    })).toMatchObject({ memoryType: "episodic", eventSummary: "Customer selected the concise reply style" });
  });

  it("requires corrections to identify a predecessor from the same fact", () => {
    expect(() => assertMemoryRevisionTransition(
      { transitionType: "correction", predecessorRevisionId: "revision-1" },
      { id: "revision-1", factId: "other-fact", lifecycleState: "active" },
      "fact-1",
    )).toThrow("MEMORY_PREDECESSOR_SCOPE_MISMATCH");
    expect(() => assertMemoryRevisionTransition(
      { transitionType: "correction", predecessorRevisionId: "revision-1" },
      { id: "revision-1", factId: "fact-1", lifecycleState: "deleted" },
      "fact-1",
    )).toThrow("MEMORY_PREDECESSOR_NOT_TRANSITIONABLE");
    expect(() => assertMemoryRevisionTransition(
      { transitionType: "correction", predecessorRevisionId: "revision-1" },
      { id: "revision-1", factId: "fact-1", lifecycleState: "active" },
      "fact-1",
    )).not.toThrow();
  });

  it("resolves current truth without erasing the historical revision", () => {
    const original = revision("revision-1", 1);
    const corrected = revision("revision-2", 2, {
      transitionType: "correction",
      predecessorRevisionId: original.id,
      canonicalText: "Customer prefers detailed replies",
      typedValue: { value: "detailed" },
      validFrom: "2026-09-03T00:00:00.000Z",
    });
    expect(resolveCurrentMemoryRevision([original, corrected], new Date("2026-09-04T00:00:00.000Z"))).toMatchObject({ id: corrected.id });
    expect(resolveCurrentMemoryRevision([original, corrected], new Date("2026-09-02T00:00:00.000Z"))).toMatchObject({ id: original.id });
  });

  it("does not hide the active winner when a concurrent correction is pending review", () => {
    const original = revision("revision-1", 1);
    const pending = revision("revision-2", 2, {
      transitionType: "correction",
      lifecycleState: "review_pending",
      predecessorRevisionId: original.id,
      canonicalText: "Customer prefers detailed replies",
      typedValue: { value: "detailed", conflict: "concurrent_correction" },
      validFrom: "2026-09-03T00:00:00.000Z",
      provenance: { conflictType: "concurrent_correction" },
    });
    expect(resolveCurrentMemoryRevision([original, pending], new Date("2026-09-04T00:00:00.000Z"))).toMatchObject({ id: original.id });
  });

  it("makes idempotency fingerprints stable for the same normalized write", () => {
    const first = semanticRevision({ canonicalText: "  Customer prefers concise replies  " });
    const second = semanticRevision({ canonicalText: "Customer prefers concise replies" });
    expect(memoryRevisionFingerprint("fact-1", first)).toBe(memoryRevisionFingerprint("fact-1", second));
    expect(memoryRevisionFingerprint("fact-1", first)).not.toBe(memoryRevisionFingerprint("fact-2", first));
  });

  it("rejects a stale correction instead of silently branching current truth", () => {
    expect(() => assertExpectedPredecessor("revision-1", "revision-2")).toThrow("MEMORY_STALE_EXPECTED_REVISION");
    expect(() => assertExpectedPredecessor("revision-1", undefined)).toThrow("MEMORY_STALE_EXPECTED_REVISION");
    expect(() => assertExpectedPredecessor("revision-2", "revision-2")).not.toThrow();
  });
});
