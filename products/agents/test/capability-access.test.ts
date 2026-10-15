import { describe, expect, it } from "vitest";
import { dependencyProjection, StaticCapabilityAccessSource, UnknownCapabilityAccessSource } from "../src/domain/capability-access";

describe("capability access source", () => {
  it("keeps an unwired product source explicitly unknown", async () => {
    const source = new UnknownCapabilityAccessSource();
    const values = await source.getForCapabilities({ organizationId: "org-1", capabilityNames: ["kasitek.core.contacts_list"] });
    expect(values.size).toBe(0);
    expect(dependencyProjection(values.get("kasitek.core.contacts_list"), { granted: true })).toMatchObject({
      available: true,
      reasonCode: "available",
      subscription: "unknown",
      providerReadiness: "unknown",
      featureFlag: "unknown",
    });
  });

  it("overlays entitlement, provider, and feature decisions without changing grant state", async () => {
    const source = new StaticCapabilityAccessSource({
      "kasitek.core.contacts_list": { entitled: false, providerAvailability: "available", featureEnabled: true },
      "kasitek.core.content_post_publish": { entitled: true, providerAvailability: "not_configured", featureEnabled: true },
      "kasitek.core.workspace_status": { entitled: true, providerAvailability: "available", featureEnabled: false },
    });
    const values = await source.getForCapabilities({ organizationId: "org-1", capabilityNames: [
      "kasitek.core.contacts_list",
      "kasitek.core.content_post_publish",
      "kasitek.core.workspace_status",
    ] });

    expect(dependencyProjection(values.get("kasitek.core.contacts_list"), { granted: true })).toMatchObject({ available: false, reasonCode: "not_entitled", installationGrant: "granted" });
    expect(dependencyProjection(values.get("kasitek.core.content_post_publish"), { granted: true })).toMatchObject({ available: false, reasonCode: "provider_not_configured", providerReadiness: "not_configured" });
    expect(dependencyProjection(values.get("kasitek.core.workspace_status"), { granted: true })).toMatchObject({ available: false, reasonCode: "feature_disabled", featureFlag: "disabled" });
  });
});
