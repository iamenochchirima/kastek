import { describe, expect, it } from "vitest";
import { customerChannelInstructions, customerSafeInstructions, retrievalOnlyChannelInstructions } from "../src/execution/context/protocol-instructions";
import { projectRecipientText } from "../src/execution/context/recipient-text";
import { publicAnswerText } from "../src/product/inbox/public-text";

describe("customer channel language", () => {
  it("removes internal source wording from customer instructions", () => {
    const safe = customerSafeInstructions("Help customers using approved knowledge. Use approved encyclopedia sources and the knowledge base.");
    expect(safe).toContain("business information");
    expect(safe).not.toMatch(/approved knowledge|approved encyclopedia|knowledge base/i);
  });

  it("does not ask customer-facing turns to produce evidence handles", () => {
    const text = "Help customers using approved knowledge. Cite each fact from approved knowledge with its provided evidence label in square brackets, exactly as supplied. Never invent a citation.";
    const customer = customerSafeInstructions(text, true);
    expect(customer).not.toMatch(/evidence label/i);
    expect(customer).toContain("business information");
    expect(customerSafeInstructions(text)).toMatch(/evidence label/i);
  });

  it("adds continuity and internal-language rules to customer replies", () => {
    expect(customerChannelInstructions).toMatch(/Do not greet again/);
    expect(customerChannelInstructions).toMatch(/restart the conversation/);
    expect(customerChannelInstructions).toMatch(/approved knowledge/);
  });

  it("does not offer a transfer when the agent has no handoff tool", () => {
    expect(retrievalOnlyChannelInstructions).toMatch(/public contact route/);
    expect(retrievalOnlyChannelInstructions).not.toMatch(/offer human support/i);
    expect(retrievalOnlyChannelInstructions).toMatch(/Do not offer a transfer, callback or human follow-up/);
  });

  it("keeps cited customer output readable after public projection", () => {
    const output = "We open at nine [E0123456789abcdef0123456789abcdef] and close at five.";
    const projected = projectRecipientText(output, { controlValues: [], userText: [], permittedValues: [] });
    expect(publicAnswerText(projected)).toBe("We open at nine and close at five.");
  });
});
