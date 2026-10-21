import { z } from "zod";

export const channelKindSchema = z.enum(["website", "whatsapp", "telegram", "facebook", "instagram"]);
export type ChannelKind = z.infer<typeof channelKindSchema>;
export type MessagingChannelKind = Exclude<ChannelKind, "website">;
const externalId = z.string().min(1).max(512).refine(value => !/[\u0000-\u001f\u007f]/.test(value));
export const channelAttachmentSchema = z.strictObject({
  kind: z.enum(["image", "audio", "video", "document"]),
  providerType: z.string().max(64).optional(),
  providerMediaId: externalId.optional(), url: z.url().optional(),
  mimeType: z.string().max(128).optional(), fileName: z.string().max(256).optional(),
});
export type ChannelAttachment = z.infer<typeof channelAttachmentSchema>;
export const channelWebhookEventSchema = z.strictObject({
  kind: z.enum(["message", "receipt", "interaction"]),
  assetId: externalId, eventId: externalId,
  externalConversationId: externalId, senderId: externalId,
  occurredAt: z.iso.datetime().nullable(), providerMessageId: externalId.nullable(),
  text: z.string().max(32768).optional(), attachments: z.array(channelAttachmentSchema).max(16).default([]),
  replyToProviderMessageId: externalId.optional(), echo: z.boolean().default(false),
  status: z.enum(["accepted", "sent", "delivered", "read", "failed"]).optional(),
  receiptWatermark: z.string().max(128).optional(),
  errorCode: z.string().max(128).optional(), interaction: z.string().max(4096).optional(),
  callbackQueryId: externalId.optional(),
});
export type ChannelWebhookEvent = z.infer<typeof channelWebhookEventSchema>;
export interface ChannelWebhookRequest {
  rawBody: Uint8Array;
  headers: Readonly<Record<string, string | undefined>>;
  secrets: { appSecret?: string; webhookSecret?: string; verifyToken?: string };
}
export interface ChannelSendRequest {
  assetId: string; recipientId: string; text: string;
  attachments?: ChannelAttachment[]; replyToProviderMessageId?: string;
  template?: { name: string; language: string; components?: unknown[] };
}
/** Private invocation data. Product code supplies an authorized bounded fetch and current credentials. */
export interface ChannelProviderContext {
  credential: string; fetch: typeof globalThis.fetch; signal?: AbortSignal;
  mode?: "meta" | "instagram_login"; apiVersion?: string; pageId?: string;
}
export interface ChannelSendResult { providerMessageId: string | null; status: "accepted" | "unknown" }
export interface ChannelProviderAdapter {
  readonly kind: MessagingChannelKind;
  verifyWebhook(request: ChannelWebhookRequest): void;
  verifyChallenge?(query: Readonly<Record<string, string | undefined>>, verifyToken: string): string;
  normalize(payload: unknown, context?: { assetId: string }): ChannelWebhookEvent[];
  send(request: ChannelSendRequest, context: ChannelProviderContext): Promise<ChannelSendResult>;
}
export class ChannelAdapterError extends Error {
  constructor(readonly code: string, readonly outcome: "rejected" | "unknown", readonly status = 502,
    readonly retryAfterMs?: number) { super(code); this.name = "ChannelAdapterError"; }
}
