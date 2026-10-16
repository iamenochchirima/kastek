import { z } from "zod";

export const canonicalMessageTypeSchema = z.enum(["text", "attachment", "reaction", "status", "command", "system"]);
export type CanonicalMessageType = z.infer<typeof canonicalMessageTypeSchema>;

const contentSchemas: Record<CanonicalMessageType, z.ZodType<Record<string, unknown>>> = {
  text: z.object({ text: z.string().max(50_000) }).passthrough(),
  attachment: z.object({
    attachmentId: z.string().min(1).max(240),
    mimeType: z.string().min(1).max(160),
    // Provider payloads commonly use null for omitted optional metadata.
    // Normalize that representation at the canonical ingress so gateways do
    // not each need to special-case the same wire variation.
    fileName: z.string().max(240).nullish().transform((value) => value ?? undefined),
    url: z.string().url().max(2_000).nullish().transform((value) => value ?? undefined),
  }).passthrough(),
  reaction: z.object({ messageId: z.string().min(1).max(240), emoji: z.string().min(1).max(32) }).passthrough(),
  status: z.object({ status: z.enum(["sent", "delivered", "read", "failed"]), providerStatus: z.string().max(120).optional() }).passthrough(),
  command: z.object({ name: z.string().min(1).max(160), arguments: z.record(z.string(), z.unknown()).default({}) }).passthrough(),
  system: z.object({ code: z.string().min(1).max(160), detail: z.string().max(2_000).optional() }).passthrough(),
};

export function parseCanonicalMessageContent(type: string, content: Record<string, unknown>): Record<string, unknown> {
  const messageType = canonicalMessageTypeSchema.parse(type);
  return contentSchemas[messageType].parse(content);
}

export interface CanonicalInboundEvent {
  channelType: string;
  externalConversationId: string;
  externalMessageId: string;
  occurredAt: string;
  sender: { externalId: string; displayName?: string };
  type: CanonicalMessageType;
  content: Record<string, unknown>;
  metadata: Record<string, unknown>;
}
