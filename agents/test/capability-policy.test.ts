import { describe, expect, it } from "vitest";
import { evaluateCapabilityPolicy } from "../src/capabilities/policy";

describe("capability policy", () => {
  const base = { capability: "content.publish", grantedCapabilities: new Set(["content.publish"]), available: true, requiresApproval: false, approved: false };
  it("denies each independent policy gate", () => {
    expect(evaluateCapabilityPolicy({ ...base, grantedCapabilities: new Set() })).toEqual({ allowed: false, code: "CAPABILITY_NOT_GRANTED" });
    expect(evaluateCapabilityPolicy({ ...base, requestedResources: [{ type: "social_account", id: "a" }], grantedResources: [] })).toEqual({ allowed: false, code: "RESOURCE_NOT_GRANTED" });
    expect(evaluateCapabilityPolicy({ ...base, requiresApproval: true })).toEqual({ allowed: false, code: "APPROVAL_REQUIRED" });
    expect(evaluateCapabilityPolicy({ ...base, available: false })).toEqual({ allowed: false, code: "UNAVAILABLE" });
  });
});
