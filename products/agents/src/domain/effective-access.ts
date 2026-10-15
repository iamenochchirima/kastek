export const effectiveAccessReasonSchema = [
  "available",
  "not_entitled",
  "not_granted",
  "credential_denied",
  "provider_not_configured",
  "provider_unhealthy",
  "feature_disabled",
  "approval_required",
] as const;

export type EffectiveAccessReason = (typeof effectiveAccessReasonSchema)[number];

export type EffectiveAccessDecision = {
  available: boolean;
  reasonCode: EffectiveAccessReason;
};

export type EffectiveAccessProjection = EffectiveAccessDecision & {
  registryLifecycle: "active" | "not_registered";
  subscription: "entitled" | "not_entitled" | "unknown";
  providerReadiness: "ready" | "not_configured" | "unhealthy" | "unknown";
  installationGrant: "granted" | "not_granted";
  credentialNarrowing: "allowed" | "denied" | "not_applicable";
  resourceConstraint: "unconstrained" | "installation_scoped";
  connectorConstraint: "unconstrained" | "installation_scoped";
  featureFlag: "enabled" | "disabled" | "unknown";
  approvalRequired: boolean;
};

/**
 * Resolves the explainable intersection used by customer discovery and
 * operator evidence. Missing inputs are intentionally neutral so callers can
 * add entitlement, feature, and credential checks as those projections become
 * available without changing the result contract.
 */
export function resolveEffectiveAccess(input: {
  granted: boolean;
  availability?: string | null;
  entitled?: boolean;
  credentialAllowed?: boolean;
  featureEnabled?: boolean;
  requiresApproval?: boolean;
}): EffectiveAccessDecision {
  if (input.entitled === false) return { available: false, reasonCode: "not_entitled" };
  if (input.featureEnabled === false) return { available: false, reasonCode: "feature_disabled" };
  if (input.credentialAllowed === false) return { available: false, reasonCode: "credential_denied" };
  if (!input.granted) return { available: false, reasonCode: "not_granted" };
  if (input.availability === "not_configured") return { available: false, reasonCode: "provider_not_configured" };
  if (input.availability === "unhealthy") return { available: false, reasonCode: "provider_unhealthy" };
  if (input.requiresApproval) return { available: true, reasonCode: "approval_required" };
  return { available: true, reasonCode: "available" };
}

/**
 * Projects the full explainable intersection used by all discovery surfaces.
 * Optional subscription/provider/feature inputs deliberately remain explicit
 * so a caller cannot silently turn an unknown external dependency into an
 * entitlement or readiness claim.
 */
export function projectEffectiveAccess(input: {
  granted: boolean;
  availability?: string | null;
  entitled?: boolean;
  credentialAllowed?: boolean;
  featureEnabled?: boolean;
  requiresApproval?: boolean;
  resourceScoped?: boolean;
  connectorScoped?: boolean;
  registryRegistered?: boolean;
}): EffectiveAccessProjection {
  const decision = resolveEffectiveAccess(input);
  const providerReadiness = input.availability === "not_configured"
    ? "not_configured"
    : input.availability === "unhealthy"
      ? "unhealthy"
      : input.availability === "available"
        ? "ready"
        : "unknown";
  return {
    ...decision,
    registryLifecycle: input.registryRegistered === false ? "not_registered" : "active",
    subscription: input.entitled === undefined ? "unknown" : input.entitled ? "entitled" : "not_entitled",
    providerReadiness,
    installationGrant: input.granted ? "granted" : "not_granted",
    credentialNarrowing: input.credentialAllowed === undefined ? "not_applicable" : input.credentialAllowed ? "allowed" : "denied",
    resourceConstraint: input.resourceScoped ? "installation_scoped" : "unconstrained",
    connectorConstraint: input.connectorScoped ? "installation_scoped" : "unconstrained",
    featureFlag: input.featureEnabled === undefined ? "unknown" : input.featureEnabled ? "enabled" : "disabled",
    approvalRequired: input.requiresApproval === true,
  };
}
