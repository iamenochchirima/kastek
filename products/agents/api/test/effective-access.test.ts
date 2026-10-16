import { describe, expect, it } from "vitest";
import { projectEffectiveAccess, resolveEffectiveAccess } from "../src/domain/effective-access";

describe("effective access projection", () => {
  it("keeps denial reasons distinct", () => {
    expect(resolveEffectiveAccess({ granted: true, entitled: false })).toEqual({ available: false, reasonCode: "not_entitled" });
    expect(resolveEffectiveAccess({ granted: true, featureEnabled: false })).toEqual({ available: false, reasonCode: "feature_disabled" });
    expect(resolveEffectiveAccess({ granted: true, credentialAllowed: false })).toEqual({ available: false, reasonCode: "credential_denied" });
    expect(resolveEffectiveAccess({ granted: true, availability: "not_configured" })).toEqual({ available: false, reasonCode: "provider_not_configured" });
    expect(resolveEffectiveAccess({ granted: false })).toEqual({ available: false, reasonCode: "not_granted" });
  });

  it("keeps approval visible without treating an approved capability as denied", () => {
    expect(resolveEffectiveAccess({ granted: true, requiresApproval: true })).toEqual({ available: true, reasonCode: "approval_required" });
  });

  it("projects every authority layer without collapsing unknown dependencies", () => {
    expect(projectEffectiveAccess({
      granted: true,
      availability: "available",
      credentialAllowed: true,
      requiresApproval: true,
      resourceScoped: true,
      connectorScoped: true,
    })).toEqual({
      available: true,
      reasonCode: "approval_required",
      registryLifecycle: "active",
      subscription: "unknown",
      providerReadiness: "ready",
      installationGrant: "granted",
      credentialNarrowing: "allowed",
      resourceConstraint: "installation_scoped",
      connectorConstraint: "installation_scoped",
      featureFlag: "unknown",
      approvalRequired: true,
    });
  });
});
