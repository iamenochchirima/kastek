import { describe, expect, it } from "vitest";
import { invitationEmailConfig } from "../src/product/members/email";

const base = {
  AGENTS_PUBLIC_URL: "https://agents.example.test",
  AGENTS_INVITATION_RESEND_API_KEY: "fixture-key",
};

describe("invitation email configuration", () => {
  it("accepts a bare sender address", () => {
    expect(invitationEmailConfig({ ...base, AGENTS_INVITATION_EMAIL_SENDER: "noreply@example.test" }))
      .toMatchObject({ sender: "noreply@example.test" });
  });

  it("accepts a display name with an address", () => {
    expect(invitationEmailConfig({ ...base, AGENTS_INVITATION_EMAIL_SENDER: "KasiTek <noreply@example.test>" }))
      .toMatchObject({ sender: "KasiTek <noreply@example.test>" });
  });

  it("rejects a sender without a valid address", () => {
    expect(() => invitationEmailConfig({ ...base, AGENTS_INVITATION_EMAIL_SENDER: "KasiTek" })).toThrow();
  });

  it("stays disabled when no invitation or follow-up values are present", () => {
    expect(invitationEmailConfig({ AGENTS_PUBLIC_URL: base.AGENTS_PUBLIC_URL })).toBeNull();
  });
});
