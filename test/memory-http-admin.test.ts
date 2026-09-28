import { describe, expect, it, vi } from "vitest";
import { CanonicalMemoryHttpAdmin } from "../src/memory/http-admin";

const baseRow = {
  fact_id: "fact-1",
  revision_id: "revision-1",
  organization_id: "org-1",
  workspace_id: "workspace-1",
  agent_definition_id: "agent-1",
  installation_id: "install-1",
  agent_version_id: "version-1",
  conversation_id: null,
  end_user_id: null,
  namespace: "workspace_shared" as const,
  memory_type: "semantic" as const,
  fact_key: "fact:key",
  lifecycle_state: "active" as const,
  canonical_text: "The launch review is Friday.",
  typed_value: { value: "Friday" },
  valid_from: "2026-09-08T10:00:00.000Z",
  valid_to: null,
  confidence: "0.9",
  sensitivity: "normal" as const,
  source_trust: "user_explicit" as const,
  provenance: { source: "test" },
  created_at: "2026-09-08T10:00:00.000Z",
};

function service() {
  const pool = {
    query: vi.fn(async () => ({ rows: [baseRow], rowCount: 1 })),
  };
  const deletionJobs = { enqueue: vi.fn(async () => ({ id: "job-1", status: "queued", replayed: false })) };
  const revisionCommands = {
    operatorTransition: vi.fn(async (input: { command: "approve" | "reject" | "revalidate"; validTo?: string | null }) => ({
      status: "created" as const,
      revision: {
        ...baseRow,
        id: `revision-${input.command}`,
        factId: "fact-1",
        createdAt: "2026-09-08T11:00:00.000Z",
        validTo: input.validTo ?? undefined,
      },
    })),
  };
  return {
    admin: new CanonicalMemoryHttpAdmin(pool as never, deletionJobs as never, revisionCommands as never),
    pool,
    deletionJobs,
    revisionCommands,
  };
}

describe("canonical memory HTTP admin", () => {
  it("maps canonical revisions to the existing scoped memory view", async () => {
    const { admin } = service();
    await expect(admin.list({ organizationId: "org-1", agentId: "agent-1", installationId: "install-1" })).resolves.toMatchObject([
      {
        id: "revision-1",
        namespace: "organization_shared",
        memory_type: "semantic",
        canonical_text: "The launch review is Friday.",
        source_type: "explicit",
        status: "active",
        fact_id: "fact-1",
      },
    ]);
  });

  it("queues canonical fact deletion instead of mutating a legacy record", async () => {
    const { admin, deletionJobs } = service();
    await admin.delete({ organizationId: "org-1", actorId: "operator-1", memoryId: "revision-1", agentId: "agent-1", installationId: "install-1" });
    expect(deletionJobs.enqueue).toHaveBeenCalledWith({ organizationId: "org-1", requestedBy: "operator-1", targetType: "memory", targetId: "fact-1" });
  });

  it("preserves revalidation expiry through an immutable v2 transition", async () => {
    const { admin, revisionCommands } = service();
    const result = await admin.revalidate({ organizationId: "org-1", actorId: "operator-1", memoryId: "revision-1", agentId: "agent-1", installationId: "install-1", expiresAt: "2026-10-01T00:00:00.000Z", operationId: "revalidate-1" });
    expect(revisionCommands.operatorTransition).toHaveBeenCalledWith(expect.objectContaining({ command: "revalidate", validTo: "2026-10-01T00:00:00.000Z" }));
    expect(result).toMatchObject({ id: "revision-revalidate", status: "active", expires_at: "2026-10-01T00:00:00.000Z" });
  });

  it("reviews only pending canonical revisions", async () => {
    const { admin, pool, revisionCommands } = service();
    pool.query.mockResolvedValueOnce({ rows: [{ ...baseRow, lifecycle_state: "review_pending" }], rowCount: 1 });
    const result = await admin.review({ organizationId: "org-1", actorId: "operator-1", memoryId: "revision-1", agentId: "agent-1", installationId: "install-1", decision: "approve", operationId: "review-1" });
    expect(revisionCommands.operatorTransition).toHaveBeenCalledWith(expect.objectContaining({ command: "approve" }));
    expect(result.status).toBe("active");
  });
});
