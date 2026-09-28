import { describe, expect, it } from "vitest";
import { buildChannelApprovalGroupPrompt } from "../src/approval/channel-prompt";

describe("channel approval prompts", () => {
  it("describes a durable group without exposing operation arguments", () => {
    expect(buildChannelApprovalGroupPrompt([
      { capability: "kasitek.calendar.delete" },
      { capability: "kasitek.calendar.delete" },
      { capability: "kasitek.calendar.create" },
    ])).toBe("Approve all 3 requested actions (kasitek.calendar.delete and kasitek.calendar.create)?");
  });

  it("keeps a one-operation group on the group contract", () => {
    expect(buildChannelApprovalGroupPrompt([{ capability: "kasitek.calendar.delete" }]))
      .toBe("Approve all 1 requested actions (kasitek.calendar.delete)?");
  });
});
