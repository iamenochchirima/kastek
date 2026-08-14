import { describe, expect, it } from "vitest";
import { buildApprovalResourceSnapshot, buildApprovalResourceSnapshotFromCore, projectContentApprovalOperation, projectContentApprovalResource } from "../src/temporal/activities";

describe("approval preview projection", () => {
  it("keeps stable resource selectors and excludes content, credentials, and metadata", () => {
    expect(buildApprovalResourceSnapshot("kasitek.core.content_post_publish", {
      postId: "post-123",
      platform: "X",
      content: "private provider payload",
      metadata: { secret: "must not persist" },
      accessToken: "token-value",
    })).toEqual({
      capability: "kasitek.core.content_post_publish",
      request: { postId: "post-123", platform: "X" },
    });
  });

  it("bounds string selectors without changing the effect argument hash", () => {
    const preview = buildApprovalResourceSnapshot("kasitek.core.content_post_schedule", {
      postId: "post-123",
      scheduledFor: "2026-08-14T12:00:00Z",
      content: "x".repeat(10_000),
    });
    expect(String((preview.request as Record<string, unknown>).scheduledFor)).toBe("2026-08-14T12:00:00Z");
    expect(JSON.stringify(preview)).not.toContain("x".repeat(100));
  });

  it("projects the reviewed content without persisting provider jobs or metadata", () => {
    const preview = buildApprovalResourceSnapshot("kasitek.core.content_post_publish", {
      postId: "post-123",
      platform: "X",
    }, {
      kind: "content_post",
      revision: "content-post.v1",
      ...projectContentApprovalResource({
        id: "post-123",
        title: "Launch update",
        content: "A reviewed launch update",
        channels: ["X"],
        status: "DRAFT",
        variants: [{ platform: "X", content: "A reviewed launch update", status: "DRAFT" }],
        publishJobs: [{ providerReceipt: "must not persist" }],
        metadata: { secret: "must not persist" },
      }),
    });
    expect(preview).toMatchObject({
      resource: {
        kind: "content_post",
        postId: "post-123",
        title: "Launch update",
        contentPreview: "A reviewed launch update",
        variants: [{ platform: "X", contentPreview: "A reviewed launch update", status: "DRAFT" }],
      },
    });
    expect(JSON.stringify(preview)).not.toContain("providerReceipt");
    expect(JSON.stringify(preview)).not.toContain("must not persist");
  });

  it("projects the requested transition for every enabled content effect", () => {
    const post = {
      id: "post-123",
      content: "Reviewed copy",
      channels: ["X"],
      status: "DRAFT",
      scheduled_for: "2026-08-15T12:00:00Z",
    };
    expect(projectContentApprovalOperation("kasitek.core.content_post_publish", { platform: "X" }, post)).toEqual({
      type: "publish",
      postId: "post-123",
      fromStatus: "DRAFT",
      platform: "X",
      targetStatus: "PUBLISHED",
    });
    expect(projectContentApprovalOperation("kasitek.core.content_post_schedule", { scheduledFor: "2026-08-16T12:00:00Z" }, post)).toEqual({
      type: "schedule",
      postId: "post-123",
      fromStatus: "DRAFT",
      scheduledFor: "2026-08-16T12:00:00Z",
      targetStatus: "SCHEDULED",
    });
    expect(projectContentApprovalOperation("kasitek.core.content_post_unschedule", {}, { ...post, status: "SCHEDULED" })).toEqual({
      type: "unschedule",
      postId: "post-123",
      fromStatus: "SCHEDULED",
      currentScheduledFor: "2026-08-15T12:00:00Z",
      targetStatus: "DRAFT",
    });
    expect(projectContentApprovalOperation("kasitek.core.content_post_delete", {}, post)).toEqual({
      type: "delete",
      postId: "post-123",
      fromStatus: "DRAFT",
      targetStatus: "DELETED",
    });
  });

  it("includes the operation in the immutable content resource preview", async () => {
    const coreClient = {
      getContentPost: async () => ({
        post: {
          id: "post-123",
          content: "Reviewed copy",
          channels: ["X"],
          status: "DRAFT",
          variants: [],
        },
      }),
    } as never;
    const preview = await buildApprovalResourceSnapshotFromCore(coreClient, {
      organizationId: "org-1",
      agentId: "agent-1",
      agentVersionId: "version-1",
      installationId: "install-1",
      runId: "run-1",
      correlationId: "corr-1",
    }, "kasitek.core.content_post_publish", { postId: "post-123", platform: "X" });
    expect(preview).toMatchObject({
      resource: {
        revision: "content-post.v1",
        operation: {
          type: "publish",
          platform: "X",
          targetStatus: "PUBLISHED",
        },
      },
    });
  });

  it("fails closed when an enabled content effect cannot load its preview", async () => {
    const coreClient = { getContentPost: async () => { throw new Error("unavailable"); } } as never;
    await expect(buildApprovalResourceSnapshotFromCore(coreClient, {
      organizationId: "org-1",
      agentId: "agent-1",
      agentVersionId: "version-1",
      installationId: "install-1",
      runId: "run-1",
      correlationId: "corr-1",
    }, "kasitek.core.content_post_delete", { postId: "post-123" })).rejects.toThrow("CONTENT_PREVIEW_UNAVAILABLE");
  });
});
