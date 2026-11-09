import { z } from "zod";

export type InvitationEmailConfig = { apiKey: string; sender: string; publicUrl: string };

/** Invitation mail uses the existing follow-up provider configuration when no dedicated key is set. */
export function invitationEmailConfig(env: NodeJS.ProcessEnv = process.env): InvitationEmailConfig | null {
  const apiKey = env.AGENTS_INVITATION_RESEND_API_KEY?.trim() || env.AGENTS_FOLLOWUP_RESEND_API_KEY?.trim();
  const sender = env.AGENTS_INVITATION_EMAIL_SENDER?.trim() || env.AGENTS_FOLLOWUP_EMAIL_SENDER?.trim();
  if (!apiKey && !sender) return null;
  if (!apiKey || !sender || !env.AGENTS_PUBLIC_URL) {
    throw new Error("Invitation email configuration is incomplete");
  }
  z.email().max(254).parse(sender);
  return { apiKey, sender, publicUrl: env.AGENTS_PUBLIC_URL };
}
