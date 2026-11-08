import { describe, expect, it } from "vitest";
import { sanitizeConversationTitle } from "../src/product/agents/conversation-title";

describe("conversation titles", () => {
  it("normalizes a model title into plain text", () => {
    expect(sanitizeConversationTitle('  "Title: Refund for a damaged order."  ')).toBe("Refund for a damaged order");
    expect(sanitizeConversationTitle("`Weekend platter ideas`")).toBe("Weekend platter ideas");
  });

  it("rejects empty and generic model output", () => {
    expect(sanitizeConversationTitle("   ")).toBe("");
    expect(sanitizeConversationTitle("Conversation")).toBe("");
    expect(sanitizeConversationTitle("New chat")).toBe("");
  });

  it("bounds long titles on a word boundary", () => {
    const title = sanitizeConversationTitle("word ".repeat(40));
    expect(title.length).toBeLessThanOrEqual(120);
    expect(title.endsWith(" ")).toBe(false);
  });
});
