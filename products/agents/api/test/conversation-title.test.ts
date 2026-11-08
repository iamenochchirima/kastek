import { describe, expect, it } from "vitest";
import { sanitizeConversationTitle, shouldGenerateConversationTitle } from "../src/product/agents/conversation-title";

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

  it("only replaces fallback titles in each product", () => {
    expect(shouldGenerateConversationTitle({ product: "agents", conversationTitle: null, productTitle: null, inputPrefix: "Hi" })).toBe(true);
    expect(shouldGenerateConversationTitle({ product: "agents", conversationTitle: "Existing", productTitle: null, inputPrefix: "Hi" })).toBe(false);
    expect(shouldGenerateConversationTitle({ product: "growth", conversationTitle: null, productTitle: "New conversation", inputPrefix: "Plan a launch" })).toBe(true);
    expect(shouldGenerateConversationTitle({ product: "growth", conversationTitle: null, productTitle: "Plan a launch", inputPrefix: "Plan a launch" })).toBe(true);
    expect(shouldGenerateConversationTitle({ product: "growth", conversationTitle: null, productTitle: "My custom title", inputPrefix: "Plan a launch" })).toBe(false);
    expect(shouldGenerateConversationTitle({ product: "agencies", conversationTitle: null, productTitle: null, inputPrefix: "Hi" })).toBe(false);
  });
});
