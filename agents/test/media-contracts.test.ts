import { describe, expect, it } from "vitest";
import { agentResponseSchema, parseAgentResponse } from "../src/media/contracts";
import { channelMediaProfile } from "../src/media/profiles";
import { redactToolOutput } from "../src/tools/redaction";

describe("Agent media response contract", () => {
  it("accepts a stable media reference without transport URLs", () => {
    const response = agentResponseSchema.parse({
      text: "Here is the image.",
      media: [{ assetId: "asset-1", kind: "image", fileName: "post.png", altText: "Announcement" }],
    });
    expect(response).toEqual({
      version: "1",
      text: "Here is the image.",
      media: [{ assetId: "asset-1", kind: "image", fileName: "post.png", altText: "Announcement", disposition: "inline" }],
    });
  });

  it("rejects expiring transport URLs and duplicate assets", () => {
    expect(() => agentResponseSchema.parse({ text: "", media: [{ assetId: "asset-1", kind: "image", previewUrl: "https://example.test/image" }] })).toThrow();
    expect(() => agentResponseSchema.parse({ text: "", media: [{ assetId: "asset-1", kind: "image" }, { assetId: "asset-1", kind: "image" }] })).toThrow();
  });

  it("reads old text-only run output as a v1 response", () => {
    expect(parseAgentResponse({ message: "Still supported" })).toEqual({ version: "1", text: "Still supported", media: [] });
  });

  it("keeps gateway support explicit", () => {
    expect(channelMediaProfile("whatsapp").nativeKinds.has("image")).toBe(true);
    expect(channelMediaProfile("whatsapp").nativeKinds.has("document")).toBe(false);
    expect(channelMediaProfile("instagram").fallback).toBe("text");
  });

  it("removes short-lived transport values from durable tool output", () => {
    expect(redactToolOutput({ media: [{ assetId: "asset-1", previewUrl: "https://temporary.test" }] }, ["media.previewUrl"]))
      .toEqual({ media: [{ assetId: "asset-1", previewUrl: "[REDACTED]" }] });
  });
});
