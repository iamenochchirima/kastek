import { describe, expect, it } from "vitest";
import {
  assertMemoryStateTransition,
  canonicalFactKey,
  createEvidenceItem,
  evidenceDigest,
  memoryClassDefinition,
  MEMORY_CLASS_DEFINITIONS,
  validateMemoryScope,
} from "../src/memory/contracts";
import { assertMemoryProviderProjectionResult, classifyMemoryProviderError } from "../src/memory/provider";

const scope = {
  organizationId: "org-1",
  workspaceId: "workspace-1",
  agentDefinitionId: "agent-1",
  agentVersionId: "version-1",
  installationId: "installation-1",
  namespace: "agent_private" as const,
};

describe("memory architecture contracts", () => {
  it("keeps summaries, episodes, facts, procedures, and knowledge on distinct contracts", () => {
    expect(Object.keys(MEMORY_CLASS_DEFINITIONS).sort()).toEqual(["episodic", "knowledge", "procedural", "semantic", "working"]);
    expect(memoryClassDefinition("working")).toMatchObject({ durable: false, eligibleForFactRevision: false });
    expect(memoryClassDefinition("semantic")).toMatchObject({ durable: true, eligibleForFactRevision: true });
    expect(memoryClassDefinition("procedural")).toMatchObject({ eligibleForFactRevision: false });
  });

  it("classifies provider failures without coupling canonical memory to provider availability", () => {
    expect(classifyMemoryProviderError(new Error("timeout"), "upsert", "local")).toMatchObject({ retryable: true, operation: "upsert" });
    expect(classifyMemoryProviderError(new Error("AUTH_INVALID"), "retrieve", "remote")).toMatchObject({ retryable: false, operation: "retrieve" });
  });

  it("requires provider acknowledgements to preserve readiness and remote identity", () => {
    expect(() => assertMemoryProviderProjectionResult("upsert", {
      readiness: "accepted",
      providerState: "accepted",
      providerRecordId: "remote-1",
    })).not.toThrow();
    expect(() => assertMemoryProviderProjectionResult("upsert", {
      readiness: "visible",
      providerState: "accepted",
      providerRecordId: "remote-1",
    })).toThrow("MEMORY_PROVIDER_READINESS_STATE_MISMATCH");
    expect(() => assertMemoryProviderProjectionResult("upsert", {
      readiness: "visible",
      providerState: "visible",
    })).toThrow("MEMORY_PROVIDER_RECORD_ID_MISSING");
    expect(() => assertMemoryProviderProjectionResult("delete", {
      readiness: "deleted",
      providerState: "deleted",
    })).not.toThrow();
    expect(() => assertMemoryProviderProjectionResult("delete", {
      readiness: "visible",
      providerState: "visible",
    })).toThrow("MEMORY_PROVIDER_DELETE_RESULT_INVALID");
  });

  it("requires the scope fields implied by a namespace", () => {
    expect(() => validateMemoryScope(scope)).not.toThrow();
    expect(() => validateMemoryScope({ ...scope, installationId: "", namespace: "agent_private" })).toThrowError(/installationId/);
    expect(() => validateMemoryScope({ ...scope, conversationId: undefined, namespace: "conversation" })).toThrowError(/conversationId/);
    expect(() => validateMemoryScope({ ...scope, endUserId: undefined, namespace: "end_user_private" })).toThrowError(/endUserId/);
  });

  it("keeps fact identity independent of the value", () => {
    const first = canonicalFactKey({ ...scope, subject: "Customer 42", predicate: "prefers reply style" });
    const second = canonicalFactKey({ ...scope, subject: " customer 42 ", predicate: "PREFERS REPLY STYLE" });
    expect(first).toBe(second);
  });

  it("rejects invalid lifecycle transitions", () => {
    expect(() => assertMemoryStateTransition("candidate", "review_pending")).not.toThrow();
    expect(() => assertMemoryStateTransition("active", "candidate")).toThrowError(/Invalid memory state transition/);
    expect(() => assertMemoryStateTransition("deleted", "active")).toThrowError(/Invalid memory state transition/);
  });

  it("redacts secrets while retaining a digest of the original evidence", () => {
    const item = createEvidenceItem({
      id: "message-1",
      actor: "end_user",
      occurredAt: "2026-09-07T00:00:00.000Z",
      sourceType: "message",
      rawContent: "Use api_key=sk_live_1234567890123456 for this request",
    });
    expect(item.content).toContain("[REDACTED]");
    expect(item.content).not.toContain("sk_live_1234567890123456");
    expect(item.contentDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces deterministic evidence digests", () => {
    const item = createEvidenceItem({
      id: "message-1",
      actor: "end_user",
      occurredAt: "2026-09-07T00:00:00.000Z",
      sourceType: "message",
      rawContent: "A bounded fact",
    });
    expect(evidenceDigest([item])).toBe(evidenceDigest([{ ...item }]));
  });
});
