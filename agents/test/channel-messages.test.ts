import { describe, expect, it } from "vitest";
import { parseCanonicalMessageContent } from "../src/channels/messages";

describe("canonical channel messages", () => {
  it("accepts canonical text and attachment envelopes", () => {
    expect(parseCanonicalMessageContent("text", { text: "hello", provider: "x" })).toMatchObject({ text: "hello" });
    expect(parseCanonicalMessageContent("attachment", { attachmentId: "a1", mimeType: "image/png" })).toMatchObject({ attachmentId: "a1" });
  });

  it("accepts provider-null optional attachment metadata", () => {
    const parsed = parseCanonicalMessageContent("attachment", {
      assetId: "asset-image-1",
      attachmentId: "whatsapp-media-1",
      mimeType: "image/jpeg",
      fileName: null,
      url: null,
      mediaKind: "IMAGE",
      text: "Post this on Instagram",
    });
    expect(parsed).toMatchObject({
      assetId: "asset-image-1",
      attachmentId: "whatsapp-media-1",
      mimeType: "image/jpeg",
      mediaKind: "IMAGE",
      text: "Post this on Instagram",
    });
    expect(parsed.fileName).toBeUndefined();
    expect(parsed.url).toBeUndefined();
  });

  it("rejects provider payloads that do not satisfy the declared type", () => {
    expect(() => parseCanonicalMessageContent("reaction", { text: "not a reaction" })).toThrow();
  });
});
