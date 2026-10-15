import type { CoreBooking, CoreCampaignSummary } from "../core/client";

const SAFE_REQUEST_KEYS = new Set([
  "postId",
  "platform",
  "scheduledFor",
  "conversationId",
  "contactId",
  "bookingId",
  "campaignId",
  "channelType",
  "externalConversationId",
  "templateName",
  "action",
  "status",
  "serviceId",
  "scheduledStart",
  "timezone",
]);

function bounded(value: unknown, max = 256): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function safeRequest(argumentsValue: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(argumentsValue)
    .filter(([key, value]) => SAFE_REQUEST_KEYS.has(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean"))
    .map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 256) : value]));
}

export function projectCampaignApprovalResource(summary: CoreCampaignSummary["campaign"]): Record<string, unknown> {
  const source = summary as Record<string, unknown>;
  const resource: Record<string, unknown> = {};
  for (const [from, to, max] of [["id", "campaignId", 160], ["name", "name", 240], ["status", "status", 40], ["scheduledAt", "scheduledAt", 64], ["totalRecipients", "totalRecipients", 20], ["sentCount", "sentCount", 20], ["deliveredCount", "deliveredCount", 20], ["failedCount", "failedCount", 20]] as const) {
    const value = source[from];
    if (typeof value === "number" && max === 20) resource[to] = value;
    else if (typeof value === "string") resource[to] = value.slice(0, max);
  }
  return resource;
}

export function projectBookingApprovalResource(booking: CoreBooking): Record<string, unknown> {
  return {
    bookingId: bounded(booking.id, 160) ?? "",
    ...(bounded(booking.serviceName, 240) ? { serviceName: bounded(booking.serviceName, 240) } : {}),
    ...(bounded(booking.customerName, 240) ? { customerName: bounded(booking.customerName, 240) } : {}),
    ...(bounded(booking.contactName, 240) ? { contactName: bounded(booking.contactName, 240) } : {}),
    ...(bounded(booking.scheduledStart, 64) ? { scheduledStart: bounded(booking.scheduledStart, 64) } : {}),
    ...(bounded(booking.scheduledEnd, 64) ? { scheduledEnd: bounded(booking.scheduledEnd, 64) } : {}),
    ...(bounded(booking.timezone, 80) ? { timezone: bounded(booking.timezone, 80) } : {}),
    ...(bounded(booking.status, 40) ? { status: bounded(booking.status, 40) } : {}),
  };
}

export function projectDomainApprovalOperation(capability: string, argumentsValue: Record<string, unknown>, resource?: Record<string, unknown>): Record<string, unknown> {
  const action = bounded(argumentsValue.action, 80) ?? capability.split(".").at(-1) ?? "effect";
  const domain = capability.includes("channel_deliver") ? "channel" : capability.includes("campaign") ? "campaign" : capability.includes("booking") ? "booking" : capability.includes("content_post") ? "content" : "later";
  const targetId = bounded(argumentsValue.postId ?? argumentsValue.campaignId ?? argumentsValue.bookingId ?? argumentsValue.externalConversationId, 160);
  const operation: Record<string, unknown> = { domain, action, ...(targetId ? { targetId } : {}) };
  if (domain === "channel") {
    const text = bounded(argumentsValue.text ?? argumentsValue.content, 1_000);
    return { ...operation, type: "send_or_reply", ...(bounded(argumentsValue.channelType, 80) ? { channelType: bounded(argumentsValue.channelType, 80) } : {}), ...(text ? { textPreview: text } : {}), targetStatus: "sent" };
  }
  if (domain === "content") return { ...operation, type: action.includes("delete") ? "delete" : action.includes("publish") ? "publish" : action, targetStatus: action.includes("delete") ? "DELETED" : action.includes("schedule") ? "SCHEDULED" : "PUBLISHED" };
  if (domain === "campaign") return { ...operation, type: "campaign_transition", fromStatus: bounded(resource?.status, 40), targetStatus: action.includes("pause") ? "PAUSED" : action.includes("cancel") ? "FAILED" : action.includes("launch") || action.includes("send") ? "RUNNING" : undefined };
  if (domain === "booking") return { ...operation, type: "booking_transition", fromStatus: bounded(resource?.status, 40), targetStatus: action.includes("cancel") ? "CANCELLED" : action.includes("complete") ? "COMPLETED" : "SCHEDULED" };
  return { ...operation, type: "destructive_or_later", targetStatus: "updated" };
}

export function buildDomainApprovalSnapshot(capability: string, argumentsValue: Record<string, unknown>, resource?: Record<string, unknown>): Record<string, unknown> {
  return {
    capability,
    request: safeRequest(argumentsValue),
    operation: projectDomainApprovalOperation(capability, argumentsValue, resource),
    ...(resource ? { resource } : {}),
  };
}
