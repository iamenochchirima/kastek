import { describe, expect, it } from "vitest";
import { agentResponseSchema, findAuthorizationRequirement, parseAgentResponse } from "../src/media/contracts";
import { channelMediaProfile } from "../src/media/profiles";
import { buildChannelMediaText } from "../src/media/delivery";
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

  it("extracts only the normalized authorization requirement from trusted tool output", () => {
    const requirement = {
      code: "AUTHORIZATION_REQUIRED",
      provider: "instagram",
      requiredCapabilities: ["SOCIAL_POST_DELETE"],
      requestable: true,
      authMode: "meta_login",
      reasonCode: "MISSING_CONTENT_MANAGEMENT_ACCESS",
      remediation: "connections_access",
    };
    expect(findAuthorizationRequirement({ providerResults: [{ authorization: requirement, scopes: ["instagram_basic"] }] })).toEqual(requirement);
    expect(findAuthorizationRequirement({ authorization: { ...requirement, rawScopes: ["instagram_basic"] } })).toBeUndefined();
  });

  it("persists authorization requirements as part of the agent response contract", () => {
    const requirement = {
      code: "AUTHORIZATION_REQUIRED",
      provider: "facebook",
      requiredCapabilities: ["SOCIAL_PUBLISH"],
      requestable: false,
      reasonCode: "REQUIRES_PROVIDER_APPROVAL",
      remediation: "connections_access",
    };
    expect(agentResponseSchema.parse({ text: "Access is needed.", authorizationRequired: requirement }).authorizationRequired).toEqual(requirement);
  });

  it("keeps gateway support explicit", () => {
    expect(channelMediaProfile("whatsapp").nativeKinds.has("image")).toBe(true);
    expect(channelMediaProfile("whatsapp").nativeKinds.has("document")).toBe(false);
    expect(channelMediaProfile("instagram").fallback).toBe("text");
  });

  it("keeps the text reply when media is unavailable or unsupported", () => {
    const response = agentResponseSchema.parse({
      text: "The post is ready.",
      media: [
        { assetId: "image-1", kind: "image", fileName: "image.png" },
        { assetId: "doc-1", kind: "document", fileName: "brief.pdf" },
      ],
    });
    const resolved = [{ assetId: "image-1", kind: "image", fileName: "image.png", previewUrl: "https://core.test/image" }] as const;
    expect(buildChannelMediaText(response, channelMediaProfile("discord"), resolved)).toBe(
      "The post is ready.\n\nOne attachment could not be loaded.",
    );
    expect(buildChannelMediaText(response, channelMediaProfile("facebook"), [])).toBe(
      "The post is ready.\n\nAttachment unavailable on this channel.",
    );
    expect(buildChannelMediaText(
      agentResponseSchema.parse({ text: "WhatsApp reply", media: [{ assetId: "image-1", kind: "image" }] }),
      channelMediaProfile("whatsapp"),
      [],
      [],
    )).toBe("WhatsApp reply");
  });

  it("removes short-lived transport values from durable tool output", () => {
    expect(redactToolOutput({ media: [{ assetId: "asset-1", previewUrl: "https://temporary.test" }] }, ["media.previewUrl"]))
      .toEqual({ media: [{ assetId: "asset-1", previewUrl: "[REDACTED]" }] });
  });
});
