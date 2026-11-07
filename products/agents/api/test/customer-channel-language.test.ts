import { describe, expect, it } from "vitest";
import { customerChannelInstructions, customerSafeInstructions } from "../src/execution/context/protocol-instructions";
import { projectRecipientText } from "../src/execution/context/recipient-text";
import { publicAnswerText } from "../src/product/inbox/public-text";

describe("customer channel language", () => {
  it("removes internal source wording from customer instructions", () => {
    const safe = customerSafeInstructions("Help customers using approved knowledge. Use approved encyclopedia sources and the knowledge base.");
    expect(safe).toContain("business information");
    expect(safe).not.toMatch(/approved knowledge|approved encyclopedia|knowledge base/i);
  });

  it("adds continuity and internal-language rules to customer replies", () => {
    expect(customerChannelInstructions).toMatch(/Do not greet again/);
    expect(customerChannelInstructions).toMatch(/restart the conversation/);
    expect(customerChannelInstructions).toMatch(/approved knowledge/);
  });

  it("keeps cited customer output readable after public projection", () => {
    const output = "We open at nine [E0123456789abcdef0123456789abcdef] and close at five.";
    const projected = projectRecipientText(output, { controlValues: [], userText: [], permittedValues: [] });
    expect(publicAnswerText(projected)).toBe("We open at nine and close at five.");
  });
});
