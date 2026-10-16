import { describe, expect, it } from "vitest";
import {
  createChannelApprovalActionToken,
  verifyChannelApprovalActionToken,
} from "../src/approval/channel-action";

const input = {
  approvalId: "11111111-1111-4111-8111-111111111111",
  organizationId: "org-1",
  installationId: "installation-1",
  runId: "run-1",
  providerToolCallId: "tool-call-1",
  argumentsHash: "a".repeat(64),
  bindingId: "binding-1",
  channelType: "telegram",
  externalIdentity: "42",
  externalConversationId: "42",
  decision: "approved" as const,
  expiresAt: "2030-01-01T00:00:00.000Z",
  now: Date.parse("2029-12-31T23:59:00.000Z"),
};

describe("channel approval actions", () => {
  it("signs and verifies a decision bound to its channel context", () => {
    const token = createChannelApprovalActionToken(input, "approval-secret");
    expect(token).toMatch(/^ka_approval_/);
    expect(token.length).toBeLessThanOrEqual(64);
    expect(verifyChannelApprovalActionToken(token, "approval-secret", {
      approvalId: input.approvalId,
      decision: input.decision,
    }, input.now)).toMatchObject({
      decision: "approved",
      approvalId: input.approvalId,
    });
  });

  it("rejects tampering, mismatched bindings, and expiry", () => {
    const token = createChannelApprovalActionToken(input, "approval-secret");
    expect(() => verifyChannelApprovalActionToken(`${token}x`, "approval-secret", {}, input.now)).toThrow("signature");
    expect(() => verifyChannelApprovalActionToken(token, "approval-secret", { approvalId: "22222222-2222-4222-8222-222222222222" }, input.now)).toThrow("approvalId");
    expect(() => verifyChannelApprovalActionToken(token, "approval-secret", {}, Date.parse("2030-01-01T00:00:00.000Z"))).toThrow("expired");
  });
});
