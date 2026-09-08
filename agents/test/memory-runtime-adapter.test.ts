import { describe, expect, it } from "vitest";
import { toMemoryCheckpointRequest } from "../src/memory/runtime-adapter";

describe("memory runtime adapter", () => {
  it("converts the context runtime boundary into a scoped, redacted checkpoint", () => {
    const request = toMemoryCheckpointRequest({
      runId: "run-1",
      turnId: "turn-1",
      compactionGeneration: 2,
      sourceEventBoundary: { eventIds: ["event-1"], digest: "boundary-digest" },
      scope: {
        organizationId: "org-1",
        workspaceId: "workspace-1",
        agentDefinitionId: "agent-1",
        agentVersionId: "version-1",
        installationId: "installation-1",
        namespace: "agent_private",
      },
      evidenceDigest: "runtime-digest",
      directEvidence: {
        schemaVersion: "v1",
        redacted: true,
        items: [{ sourceEventId: "event-1", role: "user", contentDigest: "content-digest", redactedContent: "A safe excerpt" }],
      },
    });
    expect(request.scope.workspaceId).toBe("workspace-1");
    expect(request.sourceBoundary).toBe("boundary-digest");
    expect(request.evidence.redaction).toBe("content_redacted");
    expect(request.evidence.items[0]).toMatchObject({ id: "event-1", actor: "end_user", content: "A safe excerpt" });
    expect(request.idempotencyKey).toContain("run-1:turn-1:2");
  });

  it("fails closed when runtime scope omits the required workspace boundary", () => {
    expect(() => toMemoryCheckpointRequest({
      runId: "run-1",
      turnId: "turn-1",
      compactionGeneration: 0,
      sourceEventBoundary: { eventIds: [], digest: "boundary-digest" },
      scope: { organizationId: "org-1", agentDefinitionId: "agent-1", agentVersionId: "version-1", installationId: "installation-1", namespace: "agent_private" },
      evidenceDigest: "runtime-digest",
      directEvidence: { schemaVersion: "v1", redacted: true, items: [] },
    })).toThrowError(/workspace/);
  });
});
