import { describe, expect, it } from "vitest";
import { growthAgentChannelResponseSchema } from "@kasitek-labs/contracts";

describe("Growth-managed channel responses", () => {
  it("accepts organization lists and both OAuth begin variants", () => {
    const requestId = "33b55c30-c484-4aac-ae9a-f2f31458c81d";
    const expiresAt = new Date().toISOString();

    expect(growthAgentChannelResponseSchema.safeParse({
      operation: "organizations.list",
      requestId,
      organizations: [{ id: "growth-org", name: "Business" }],
    }).success).toBe(true);

    expect(growthAgentChannelResponseSchema.safeParse({
      operation: "oauth.begin",
      requestId,
      flow: "oauth",
      authorizationUrl: "https://example.test/oauth",
      expiresAt,
    }).success).toBe(true);

    expect(growthAgentChannelResponseSchema.safeParse({
      operation: "oauth.begin",
      requestId,
      flow: "embedded_signup",
      intentId: requestId,
      appId: "development-app",
      apiVersion: "v23.0",
      configurationId: "embedded-signup",
      messageOrigins: ["https://www.facebook.com"],
      expiresAt,
    }).success).toBe(true);
  });
});
