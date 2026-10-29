import { z } from "zod";
import { customerReturnUrl } from "./return-url";

export type CustomerFollowupConfig = { apiKey: string; sender: string; publicUrl: string };
/** Customer follow-up is enabled only when its own sender and public origin are configured. */
export function customerFollowupConfig(env: NodeJS.ProcessEnv): CustomerFollowupConfig | null {
  const apiKey = env.AGENTS_FOLLOWUP_RESEND_API_KEY?.trim(), sender = env.AGENTS_FOLLOWUP_EMAIL_SENDER?.trim();
  if (!apiKey && !sender) return null;
  if (!apiKey || !sender || !env.AGENTS_PUBLIC_URL) throw new Error("Customer follow-up email configuration is incomplete");
  z.email().max(254).parse(sender);
  customerReturnUrl(env.AGENTS_PUBLIC_URL, "11111111-1111-4111-8111-111111111111", "A".repeat(43));
  return { apiKey, sender, publicUrl:env.AGENTS_PUBLIC_URL };
}
