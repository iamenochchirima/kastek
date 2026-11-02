import { PlatformError } from "../../contracts/contracts";
import type { MessagingChannelKind } from "../../contracts/channel-adapters";

const day = 24 * 60 * 60 * 1000;
export const channelPolicySources = Object.freeze({
  whatsapp: "https://business.whatsapp.com/policy",
  facebook: "https://raw.githubusercontent.com/fbsamples/messenger-platform-samples/main/postman/messenger-platform-api.postman_collection.json",
  instagram: "https://github.com/fbsamples/messenger-platform-samples/blob/07028ac9929b24a9d993714dda202e75a68ee2f4/postman/instagram-platform-api.postman_collection.json",
});
export type ChannelPolicyDecision = { allowed: boolean; reason: string; tag?: "HUMAN_AGENT"; closesAt?: string };
export interface ChannelReplyPolicyInput {
  kind: MessagingChannelKind; mode?: string; now: number; latestCustomerAt: number | null;
  author: "human" | "assistant"; assignedHuman: boolean; relatedInquiryConfirmed: boolean;
  humanAgentApproved: boolean;
  /** True only when the installed queue/adapter carries an exact, staff-confirmed HUMAN_AGENT effect. */
  humanAgentTransportEnabled: boolean;
}
/** Only a verified customer message opens this window; a takeover, echo, receipt or model turn cannot reset it. */
export function channelReplyPolicy(input: ChannelReplyPolicyInput): ChannelPolicyDecision {
  if (input.kind === "telegram") return { allowed: true, reason: "standard" };
  if (input.latestCustomerAt === null || !Number.isFinite(input.latestCustomerAt) || input.latestCustomerAt > input.now) return { allowed: false, reason: "customer_message_required" };
  const age = input.now - input.latestCustomerAt;
  if (age < day) return { allowed: true, reason: "standard", closesAt: new Date(input.latestCustomerAt + day).toISOString() };
  if (input.kind === "whatsapp") return { allowed: false, reason: "approved_template_required" };
  // The Meta-maintained direct-Instagram collection documents seven days for approved, inquiry-related human support only.
  if (input.kind === "instagram" && input.mode === "instagram_login" && age < 7 * day && input.author === "human" && input.assignedHuman &&
    input.relatedInquiryConfirmed && input.humanAgentApproved && input.humanAgentTransportEnabled) return { allowed: true, reason: "approved_human_support", tag: "HUMAN_AGENT", closesAt: new Date(input.latestCustomerAt + 7 * day).toISOString() };
  return { allowed: false, reason: "standard_window_closed" };
}
export function assertChannelReplyPolicy(input: ChannelReplyPolicyInput): ChannelPolicyDecision {
  const decision = channelReplyPolicy(input);
  if (!decision.allowed) throw new PlatformError(decision.reason === "approved_template_required" ? "CHANNEL_APPROVED_TEMPLATE_REQUIRED" : "CHANNEL_REPLY_WINDOW_CLOSED", 409, "The channel reply window is closed");
  return decision;
}
export function channelPolicyReadiness(kind: MessagingChannelKind, mode?: string, humanAgentApproved = false, transportEnabled = false) {
  return { standardWindowHours: kind === "telegram" ? null : 24, source: kind === "telegram" ? "https://core.telegram.org/bots/api" : channelPolicySources[kind],
    humanSupport: kind === "instagram" && mode === "instagram_login" && humanAgentApproved && transportEnabled ? "approved_staff_confirmation_required" : "standard_window_only",
    templates: kind === "whatsapp" ? "approved_with_customer_opt_in" : "unavailable" };
}
