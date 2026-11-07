import { describe, expect, it } from "vitest";
import { publicAnswerText } from "../src/product/inbox/public-text";

describe("customer-visible answer text", () => {
  it("removes internal evidence handles and tidies spacing", () => {
    expect(publicAnswerText(`We are in Centurion [E${"a".repeat(32)}]. [E2] Open until 16:30.`)).toBe("We are in Centurion. Open until 16:30.");
    expect(publicAnswerText("Only [E2]")).toBe("Only");
    expect(publicAnswerText("[E2]")).toBe("");
    expect(publicAnswerText("Price [E2], hours [E3].")).toBe("Price, hours.");
  });
});
