export type CapabilityDenialCode = "CAPABILITY_NOT_GRANTED" | "RESOURCE_NOT_GRANTED" | "APPROVAL_REQUIRED" | "UNAVAILABLE" | "LIMIT_EXCEEDED";

export interface CapabilityPolicyInput {
  capability: string;
  grantedCapabilities: ReadonlySet<string>;
  requestedResources?: Array<{ type: string; id: string }>;
  grantedResources?: Array<{ resourceType: string; resourceId: string }>;
  resourceScopeUnconstrained?: boolean;
  available: boolean;
  requiresApproval: boolean;
  approved: boolean;
  remainingCalls?: number;
}

export function evaluateCapabilityPolicy(input: CapabilityPolicyInput): { allowed: true } | { allowed: false; code: CapabilityDenialCode } {
  if (!input.available) return { allowed: false, code: "UNAVAILABLE" };
  if (!input.grantedCapabilities.has(input.capability)) return { allowed: false, code: "CAPABILITY_NOT_GRANTED" };
  if (input.remainingCalls !== undefined && input.remainingCalls <= 0) return { allowed: false, code: "LIMIT_EXCEEDED" };
  const granted = input.grantedResources ?? [];
  if (!input.resourceScopeUnconstrained && input.requestedResources?.some((resource) => !granted.some((entry) => entry.resourceType === resource.type && entry.resourceId === resource.id))) {
    return { allowed: false, code: "RESOURCE_NOT_GRANTED" };
  }
  if (input.requiresApproval && !input.approved) return { allowed: false, code: "APPROVAL_REQUIRED" };
  return { allowed: true };
}
