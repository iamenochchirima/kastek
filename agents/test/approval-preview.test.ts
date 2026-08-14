import { describe, expect, it } from "vitest";
import { buildApprovalResourceSnapshot } from "../src/temporal/activities";

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
});
