import { describe, expect, it } from "vitest";
import { parseCanonicalMessageContent } from "../src/channels/messages";

describe("canonical channel messages", () => {
  it("accepts canonical text and attachment envelopes", () => {
    expect(parseCanonicalMessageContent("text", { text: "hello", provider: "x" })).toMatchObject({ text: "hello" });
    expect(parseCanonicalMessageContent("attachment", { attachmentId: "a1", mimeType: "image/png" })).toMatchObject({ attachmentId: "a1" });
  });

  it("rejects provider payloads that do not satisfy the declared type", () => {
    expect(() => parseCanonicalMessageContent("reaction", { text: "not a reaction" })).toThrow();
  });
});
