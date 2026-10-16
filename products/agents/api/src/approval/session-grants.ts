import type { CapabilityManifestMetadata } from "../tools/types";

/**
 * A session grant is deliberately narrower than a capability grant: it is an
 * exact capability/version/resource authorization for one conversation and
 * one actor, and it always expires. Wildcard capabilities and unconstrained
 * resources are not represented by this type.
 */
export interface ApprovalSessionResourceSelector {
  type: string;
  argument: string;
  value: string;
}

export interface ApprovalSessionGrantMatchInput {
  organizationId: string;
  installationId: string;
  conversationId: string;
  sessionKey: string;
  actorId: string;
  capability: string;
  capabilityVersion: string;
  policyRevision: string;
  resourceSelector: ApprovalSessionResourceSelector;
}

export interface ApprovalSessionGrantRecord extends ApprovalSessionGrantMatchInput {
  id: string;
  grantedBy: string;
  expiresAt: string;
  createdAt: string;
  revokedAt: string | null;
}

export function approvalSessionKey(installationId: string, conversationId: string): string {
  return `conversation:${installationId}:${conversationId}`;
}

function boundedSelectorPart(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const normalized = String(value).trim();
  if (!normalized || normalized.length > 240) return undefined;
  return normalized;
}

/**
 * Derive the only resource scope a manifest is allowed to grant. A manifest
 * without an argument-level resource selector fails closed and cannot create
 * a reusable session authorization.
 */
export function approvalSessionResourceSelector(
  manifest: Pick<CapabilityManifestMetadata, "resourceSelector"> | undefined,
  argumentsValue: Record<string, unknown>,
): ApprovalSessionResourceSelector | null {
  const selector = manifest?.resourceSelector;
  if (!selector?.argument) return null;
  const value = boundedSelectorPart(argumentsValue[selector.argument]);
  if (!value) return null;
  const type = boundedSelectorPart(selector.type);
  const argument = boundedSelectorPart(selector.argument);
  if (!type || !argument) return null;
  return { type, argument, value };
}

export function approvalSessionResourceSelectorsEqual(
  left: ApprovalSessionResourceSelector | null | undefined,
  right: ApprovalSessionResourceSelector | null | undefined,
): boolean {
  return Boolean(left && right)
    && left!.type === right!.type
    && left!.argument === right!.argument
    && left!.value === right!.value;
}

export function approvalSessionGrantMatches(
  grant: ApprovalSessionGrantRecord,
  input: ApprovalSessionGrantMatchInput,
  now = Date.now(),
): boolean {
  return grant.organizationId === input.organizationId
    && grant.installationId === input.installationId
    && grant.conversationId === input.conversationId
    && grant.sessionKey === input.sessionKey
    && grant.actorId === input.actorId
    && grant.capability === input.capability
    && grant.capabilityVersion === input.capabilityVersion
    && grant.policyRevision === input.policyRevision
    && approvalSessionResourceSelectorsEqual(grant.resourceSelector, input.resourceSelector)
    && grant.revokedAt === null
    && Number.isFinite(Date.parse(grant.expiresAt))
    && Date.parse(grant.expiresAt) > now;
}
