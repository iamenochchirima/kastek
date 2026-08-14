import { describe, expect, it } from "vitest";
import { buildApprovalResourceSnapshot, projectContentApprovalResource } from "../src/temporal/activities";

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
});
