import { describe, expect, it } from "vitest";
import { agentResponseSchema, findAuthorizationRequirement, parseAgentResponse } from "../src/media/contracts";
import { projectCapabilityResultUi } from "../src/media/dynamic-ui";
import { channelMediaProfile, channelUiProfile } from "../src/media/profiles";
import { buildChannelMediaText, buildChannelUiFallback, channelUiNavigationButtons } from "../src/media/delivery";
import { redactToolOutput } from "../src/tools/redaction";
import { PRODUCT_WORKFLOWS } from "../src/workflows/product-workflows";

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

  it("accepts a bounded server-owned UI projection without changing text fallback", () => {
    const response = agentResponseSchema.parse({
      text: "Here are the connected accounts.",
      ui: {
        version: "1",
        mode: "inline",
        blocks: [{
          type: "list",
          id: "connected-accounts",
          title: "Connected accounts",
          items: [{ title: "Instagram", description: "@kasitek", status: "success" }],
          actions: [{ id: "open-connections", label: "Open connections", kind: "navigate", href: "/connections" }],
        }],
      },
    });
    expect(response.ui?.blocks[0]?.type).toBe("list");
    expect(response.media).toEqual([]);
  });

  it("projects connection output into display-safe UI", () => {
    const ui = projectCapabilityResultUi({
      presentation: {
        projection: "workspace_connections",
        mode: "inline",
        channels: ["platform", "website"],
        fallback: "I found the workspace connections.",
        actions: [{ id: "open-connections", label: "Open connections", kind: "navigate", href: "/connections" }],
      },
      output: {
        connections: [{
          provider: "instagram",
          displayName: "KasiTek",
          handle: "@kasitek",
          status: "CONNECTED",
          healthStatus: "HEALTHY",
          connectionId: "must-not-appear",
          credentials: "must-not-appear",
        }],
      },
    });
    expect(ui).toEqual({
      version: "1",
      mode: "inline",
      blocks: [{
        type: "list",
        id: "connected-accounts",
        title: "Connected accounts",
        items: [{
          id: "connection-1",
          title: "KasiTek",
          description: "Instagram · @kasitek",
          meta: "CONNECTED · HEALTHY",
          status: "success",
        }],
        emptyText: "No connected accounts",
        actions: [{ id: "open-connections", label: "Open connections", kind: "navigate", href: "/connections" }],
      }],
    });
    expect(JSON.stringify(ui)).not.toContain("must-not-appear");
    expect(projectCapabilityResultUi({
      presentation: {
        projection: "workspace_connections",
        mode: "inline",
        channels: ["platform"],
        fallback: "I found the workspace connections.",
      },
      channel: "website",
      output: { connections: [] },
    })).toBeUndefined();
  });

  it("keeps gateway support explicit", () => {
    expect(channelMediaProfile("whatsapp").nativeKinds.has("image")).toBe(true);
    expect(channelMediaProfile("whatsapp").nativeKinds.has("document")).toBe(false);
    expect(channelMediaProfile("instagram").fallback).toBe("text");
    expect(channelUiProfile("telegram").mode).toBe("native");
    expect(channelUiProfile("whatsapp").mode).toBe("numbered");
    expect(channelUiProfile("facebook").mode).toBe("text");
  });

  it("renders bounded channel UI fallbacks without exposing action prompts", () => {
    const ui = agentResponseSchema.parse({
      text: "Choose the next step.",
      ui: {
        version: "1",
        mode: "expanded",
        blocks: [
          { type: "choice", id: "choice", title: "Next step", options: [{ id: "report", label: "Open report", description: "See the latest activity" }] },
          { type: "workspace", id: "report-workspace", workspace: "report", title: "Workspace report", description: "Review activity.", href: "/workspace", actions: [{ id: "open", label: "Open workspace", kind: "navigate", href: "/workspace" }] },
          { type: "form", id: "details", fields: [{ id: "name", label: "Name", type: "text", required: true, maxLength: 80 }], actions: [{ id: "submit", label: "Submit", kind: "submit", targetId: "details" }] },
        ],
      },
    }).ui!;
    const fallback = buildChannelUiFallback(ui, "whatsapp", "https://app.kasitek.test");
    expect(fallback).toContain("1. Open report");
    expect(fallback).toContain("Workspace report");
    expect(fallback).toContain("Name *");
    expect(fallback).not.toContain("prompt");
    expect(buildChannelUiFallback(ui, "telegram", "https://app.kasitek.test")).toContain("Reply with the number or option name.");
    expect(channelUiNavigationButtons(ui, "telegram", "https://app.kasitek.test")).toEqual([{ label: "Open workspace", url: "https://app.kasitek.test/workspace" }]);
    expect(channelUiNavigationButtons(ui, "telegram", "https://app.kasitek.test").some((button) => button.url.includes("javascript:"))).toBe(false);
  });

  it("renders a list empty state without an orphan section heading", () => {
    const ui = agentResponseSchema.parse({
      text: "No posts yet.",
      ui: {
        version: "1",
        mode: "inline",
        blocks: [{ type: "list", id: "content-posts", title: "Content posts", items: [], emptyText: "No content posts" }],
      },
    }).ui;

    expect(buildChannelUiFallback(ui, "whatsapp")).toBe("No content posts");
  });

  it("keeps product workspace handoffs registered against existing routes", () => {
    expect(PRODUCT_WORKFLOWS.map((workflow) => workflow.id)).toEqual([
      "agent_creation",
      "social_connections",
      "content_operations",
      "workspace_reporting",
    ]);
    for (const workflow of PRODUCT_WORKFLOWS) {
      expect(workflow.entryPath).toMatch(/^\//);
      expect(workflow.capabilities.length).toBeGreaterThan(0);
    }
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
