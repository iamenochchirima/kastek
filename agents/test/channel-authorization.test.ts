import { describe, expect, it } from "vitest";
import { authorizationRemediationText, connectionAccessUrl } from "../src/channels/authorization";

const requirement = {
  code: "AUTHORIZATION_REQUIRED",
  provider: "instagram",
  requiredCapabilities: ["SOCIAL_POST_DELETE"],
  requestable: true,
  reasonCode: "MISSING_CONTENT_MANAGEMENT_ACCESS",
  remediation: "connections_access",
} as const;

describe("gateway authorization remediation", () => {
  it("builds a provider-neutral connection access deep link", () => {
    expect(connectionAccessUrl("https://app.example.test/", requirement)).toBe(
      "https://app.example.test/connections?access=required&provider=instagram&capabilities=SOCIAL_POST_DELETE",
    );
  });

  it("adds the recovery action without exposing provider scopes", () => {
    const text = authorizationRemediationText("The post could not be deleted.", requirement, "https://app.example.test");
    expect(text).toContain("The post could not be deleted.");
    expect(text).toContain("[Open Connections](https://app.example.test/connections?");
    expect(text).toContain("manage published content");
    expect(text).not.toContain("instagram_basic");
  });
});
