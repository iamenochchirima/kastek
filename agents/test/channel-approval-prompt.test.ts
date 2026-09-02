import { describe, expect, it } from "vitest";
import { buildChannelApprovalPrompt } from "../src/approval/channel-prompt";

describe("channel approval prompts", () => {
  it("describes a publish using product language and safe resource details", () => {
    expect(buildChannelApprovalPrompt("kasitek.core.content_post_publish", {
      request: { postId: "internal-post-id", platform: "BLUESKY" },
      resource: {
        title: "KasiTek agents teaser",
        channels: ["BLUESKY"],
        operation: { type: "publish", platform: "BLUESKY" },
      },
    })).toBe("Publish “KasiTek agents teaser” to Bluesky?");
  });

  it("includes attached images in the publish prompt", () => {
    expect(buildChannelApprovalPrompt("kasitek.core.content_post_publish", {
      request: { platform: "THREADS" },
      resource: { title: "Launch", mediaCount: 1 },
    })).toBe("Publish “Launch” with 1 image to Threads?");
  });

  it("names the platform for published-post deletion", () => {
    expect(buildChannelApprovalPrompt("kasitek.core.content_post_delete_published", {
      request: { postId: "internal-post-id", platform: "THREADS" },
      resource: { title: "Launch", operation: { type: "delete_published", platform: "THREADS" } },
    })).toBe("Delete “Launch” from Threads?");
  });

  it("describes a batch retry without exposing internal identifiers", () => {
    expect(buildChannelApprovalPrompt("kasitek.core.content_post_publish_batch_retry", {
      request: { batchId: "internal-batch-id" },
      resource: {
        postId: "internal-post-id",
        targets: [
          { platform: "INSTAGRAM", accountName: "KasiTek", state: "FAILED" },
          { platform: "X", accountName: "KasiTek Labs", state: "PUBLISHED" },
        ],
      },
    })).toBe("Retry failed destinations for this post: Instagram (KasiTek)?");
  });

  it("includes media in the one-approval batch prompt", () => {
    expect(buildChannelApprovalPrompt("kasitek.core.content_post_publish_batch", {
      request: { postId: "internal-post-id" },
      resource: {
        title: "Launch",
        mediaCount: 1,
        batchPreflight: {
          targets: [
            { platform: "INSTAGRAM", accountName: "KasiTek" },
            { platform: "THREADS", accountName: "KasiTek" },
          ],
        },
      },
    })).toBe("Publish “Launch” with 1 image to Instagram (KasiTek), Threads (KasiTek)?");
  });

  it("uses concise labels for non-content effects", () => {
    expect(buildChannelApprovalPrompt("kasitek.core.contact_update")).toBe("Update this contact?");
    expect(buildChannelApprovalPrompt("kasitek.core.channel_deliver")).toBe("Send this message?");
  });

  it("never exposes an unknown internal capability", () => {
    expect(buildChannelApprovalPrompt("internal.system.operation")).toBe("Approve this action?");
  });
});
