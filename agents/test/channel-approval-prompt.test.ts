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

  it("uses concise labels for non-content effects", () => {
    expect(buildChannelApprovalPrompt("kasitek.core.contact_update")).toBe("Update this contact?");
    expect(buildChannelApprovalPrompt("kasitek.core.channel_deliver")).toBe("Send this message?");
  });

  it("never exposes an unknown internal capability", () => {
    expect(buildChannelApprovalPrompt("internal.system.operation")).toBe("Approve this action?");
  });
});
