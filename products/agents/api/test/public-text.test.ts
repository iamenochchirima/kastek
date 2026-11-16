import { describe, expect, it } from "vitest";
import { publicAnswerText } from "../src/product/inbox/public-text";

describe("customer-visible answer text", () => {
  it("removes internal evidence handles and tidies spacing", () => {
    expect(publicAnswerText(`We are in Centurion [E${"a".repeat(32)}]. [E2] Open until 16:30.`)).toBe("We are in Centurion. Open until 16:30.");
    expect(publicAnswerText("Only [E2]")).toBe("Only");
    expect(publicAnswerText("[E2]")).toBe("");
    expect(publicAnswerText("Price [E2], hours [E3].")).toBe("Price, hours.");
  });

  it("removes labels split by whitespace or grouped in one bracket", () => {
    expect(publicAnswerText("The All Cheese platter is R345 [E4c830b0924f041098c7 f7328e96d232].")).toBe("The All Cheese platter is R345.");
    expect(publicAnswerText(`Price [E${"a".repeat(32)} E${"b".repeat(32)}].`)).toBe("Price.");
    expect(publicAnswerText("See [Sandwich menu] for details.")).toBe("See [Sandwich menu] for details.");
  });
});
