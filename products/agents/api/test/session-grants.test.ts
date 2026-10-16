import { describe, expect, it } from "vitest";
import {
  approvalSessionGrantMatches,
  approvalSessionKey,
  approvalSessionResourceSelector,
  type ApprovalSessionGrantRecord,
} from "../src/approval/session-grants";

const manifest = { resourceSelector: { type: "post", argument: "postId" } };
const match = {
  organizationId: "org-1",
  installationId: "install-1",
  conversationId: "conversation-1",
  sessionKey: approvalSessionKey("install-1", "conversation-1"),
  actorId: "actor-1",
  capability: "content.publish",
  capabilityVersion: "1.0.0",
  policyRevision: "v1",
  resourceSelector: { type: "post", argument: "postId", value: "post-1" },
};

function grant(overrides: Partial<ApprovalSessionGrantRecord> = {}): ApprovalSessionGrantRecord {
  return {
    id: "grant-1",
    ...match,
    grantedBy: "operator-1",
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: new Date().toISOString(),
    revokedAt: null,
    ...overrides,
  };
}

describe("bounded approval session grants", () => {
  it("derives an exact resource selector from manifest arguments", () => {
    expect(approvalSessionResourceSelector(manifest, { postId: "post-1" })).toEqual(match.resourceSelector);
    expect(approvalSessionResourceSelector(manifest, { postId: 42 })).toEqual({ type: "post", argument: "postId", value: "42" });
    expect(approvalSessionResourceSelector(manifest, { postId: "" })).toBeNull();
    expect(approvalSessionResourceSelector(undefined, { postId: "post-1" })).toBeNull();
    expect(approvalSessionResourceSelector({ resourceSelector: { type: "post" } }, { postId: "post-1" })).toBeNull();
  });

  it("matches every identity dimension and rejects expiry or revocation", () => {
    expect(approvalSessionGrantMatches(grant(), match)).toBe(true);
    expect(approvalSessionGrantMatches(grant({ actorId: "other-actor" }), match)).toBe(false);
    expect(approvalSessionGrantMatches(grant({ capabilityVersion: "2.0.0" }), match)).toBe(false);
    expect(approvalSessionGrantMatches(grant({ resourceSelector: { ...match.resourceSelector, value: "post-2" } }), match)).toBe(false);
    expect(approvalSessionGrantMatches(grant({ revokedAt: new Date().toISOString() }), match)).toBe(false);
    expect(approvalSessionGrantMatches(grant({ expiresAt: new Date(Date.now() - 1).toISOString() }), match)).toBe(false);
  });
});
