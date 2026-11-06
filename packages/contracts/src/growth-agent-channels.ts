import { z } from "zod";

export const GROWTH_AGENT_CHANNELS_PATH = "/internal/agents/channel-links";
export const GROWTH_AGENT_CHANNELS_AUDIENCE = "growth-agent-channel-links";
export const growthAgentChannelProviderSchema = z.enum(["facebook", "instagram", "whatsapp"]);
export type GrowthAgentChannelProvider = z.infer<typeof growthAgentChannelProviderSchema>;

const actorSchema = z.strictObject({ issuer: z.url(), subject: z.string().trim().min(1).max(512) });
const shared = z.strictObject({
  version: z.literal("1"),
  requestId: z.uuid(),
  actor: actorSchema,
  workspaceId: z.uuid(),
  agentId: z.uuid(),
});

const channelAttachment = z.strictObject({
  kind: z.enum(["image", "audio", "video", "document"]),
  providerType: z.string().max(64).optional(),
  providerMediaId: z.string().trim().min(1).max(512).optional(),
  url: z.url().optional(),
  mimeType: z.string().max(128).optional(),
  fileName: z.string().max(256).optional(),
});
export const growthAgentChannelEventSchema = z.strictObject({
  kind: z.enum(["message", "receipt", "interaction"]),
  assetId: z.string().trim().min(1).max(512),
  eventId: z.string().trim().min(1).max(512),
  externalConversationId: z.string().trim().min(1).max(512),
  senderId: z.string().trim().min(1).max(512),
  privateChat: z.boolean().optional(),
  senderLabel: z.string().trim().min(1).max(512).optional(),
  occurredAt: z.iso.datetime().nullable(),
  providerMessageId: z.string().trim().min(1).max(512).nullable(),
  text: z.string().max(32768).optional(),
  attachments: z.array(channelAttachment).max(16).default([]),
  replyToProviderMessageId: z.string().trim().min(1).max(512).optional(),
  echo: z.boolean().default(false),
  status: z.enum(["accepted", "sent", "delivered", "read", "failed"]).optional(),
  receiptWatermark: z.string().max(128).optional(),
  errorCode: z.string().max(128).optional(),
  interaction: z.string().max(4096).optional(),
  callbackQueryId: z.string().trim().min(1).max(512).optional(),
});
export type GrowthAgentChannelEvent = z.infer<typeof growthAgentChannelEventSchema>;

export const growthAgentChannelRequestSchema = z.discriminatedUnion("operation", [
  shared.extend({ operation: z.literal("organizations.list") }),
  shared.extend({
    operation: z.literal("intent.create"),
    provider: growthAgentChannelProviderSchema,
    growthOrganizationId: z.string().trim().min(1).max(128),
    returnRoute: z.string().regex(/^\/app\/agents\/[0-9a-f-]{36}\?section=channels$/i),
  }),
  shared.extend({
    operation: z.literal("assets.list"),
    intentId: z.uuid(),
  }),
  shared.extend({
    operation: z.literal("oauth.begin"),
    intentId: z.uuid(),
    loginMode: z.enum(["meta_login", "instagram_login", "whatsapp_embedded_signup"]),
  }),
  shared.extend({
    operation: z.literal("whatsapp.complete"),
    intentId: z.uuid(),
    code: z.string().min(1).max(4096),
    wabaId: z.string().trim().min(1).max(128),
    phoneNumberId: z.string().trim().min(1).max(128),
  }),
  shared.extend({
    operation: z.literal("grant.issue"),
    intentId: z.uuid(),
    connectionId: z.string().trim().min(1).max(128),
    agentsConnectionId: z.uuid(),
    providerAssetId: z.string().trim().min(1).max(512),
  }),
  shared.extend({
    operation: z.literal("grant.exchange"),
    intentId: z.uuid(),
    agentsConnectionId: z.uuid(),
    code: z.string().regex(/^[A-Za-z0-9_-]{40,128}$/),
  }),
  shared.extend({
    operation: z.literal("grant.activate"),
    intentId: z.uuid(),
    agentsConnectionId: z.uuid(),
  }),
  shared.extend({
    operation: z.literal("grant.revoke"),
    grantId: z.uuid(),
    agentsConnectionId: z.uuid(),
  }),
  shared.extend({
    operation: z.literal("message.send"),
    provider: growthAgentChannelProviderSchema,
    deliveryId: z.uuid(),
    grantId: z.uuid(),
    agentsConnectionId: z.uuid(),
    providerAssetId: z.string().trim().min(1).max(512),
    message: z.strictObject({
      recipientId: z.string().trim().min(1).max(512),
      text: z.string().max(32768),
      attachments: z.array(channelAttachment).max(1).optional(),
      replyToProviderMessageId: z.string().trim().min(1).max(512).optional(),
      buttons: z.array(z.strictObject({ title: z.string().min(1).max(20), payload: z.string().min(1).max(64) })).max(2).optional(),
      template: z.strictObject({ name: z.string().min(1).max(512), language: z.string().min(1).max(32), components: z.array(z.unknown()).max(16).optional() }).optional(),
    }),
  }),
  shared.extend({
    operation: z.literal("webhook.deliver"),
    grantId: z.uuid(),
    agentsConnectionId: z.uuid(),
    provider: growthAgentChannelProviderSchema,
    providerAssetId: z.string().trim().min(1).max(512),
    event: growthAgentChannelEventSchema,
  }),
]);
export type GrowthAgentChannelRequest = z.infer<typeof growthAgentChannelRequestSchema>;

export const growthAgentChannelOrganizationSchema = z.strictObject({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(160),
});
export type GrowthAgentChannelOrganization = z.infer<typeof growthAgentChannelOrganizationSchema>;

export const growthAgentChannelAssetSchema = z.strictObject({
  growthOrganizationId: z.string().min(1).max(128),
  growthOrganizationName: z.string().min(1).max(160),
  connectionId: z.string().min(1).max(128),
  provider: growthAgentChannelProviderSchema,
  providerMode: z.enum(["meta", "instagram_login"]),
  providerAssetId: z.string().min(1).max(512),
  name: z.string().min(1).max(256),
  handle: z.string().max(256).nullable(),
  permissionRevision: z.string().min(1).max(128),
  inbound: z.literal(true),
  outbound: z.literal(true),
});
export type GrowthAgentChannelAsset = z.infer<typeof growthAgentChannelAssetSchema>;

export const growthAgentChannelGrantSchema = z.strictObject({
  grantId: z.string().uuid(),
  growthActor: actorSchema,
  growthOrganizationId: z.string().min(1).max(128),
  connectionId: z.string().min(1).max(128),
  provider: growthAgentChannelProviderSchema,
  providerAssetId: z.string().min(1).max(512),
  permissionRevision: z.string().min(1).max(128),
  state: z.enum(["pending", "active", "revoked", "needs_attention"]),
  routeOwner: z.enum(["agents", "growth"]),
});
export type GrowthAgentChannelGrant = z.infer<typeof growthAgentChannelGrantSchema>;

export const growthAgentChannelResponseSchema = z.union([
  shared.pick({ requestId: true }).extend({
    operation: z.literal("organizations.list"),
    organizations: z.array(growthAgentChannelOrganizationSchema).max(200),
  }),
  shared.pick({ requestId: true }).extend({
    operation: z.literal("intent.create"), intentId: z.uuid(), expiresAt: z.iso.datetime(),
  }),
  shared.pick({ requestId: true }).extend({
    operation: z.literal("assets.list"), assets: z.array(growthAgentChannelAssetSchema).max(500),
  }),
  shared.pick({ requestId: true }).extend({
    operation: z.literal("oauth.begin"),
    flow: z.literal("oauth"),
    authorizationUrl: z.url(),
    expiresAt: z.iso.datetime(),
  }),
  shared.pick({ requestId: true }).extend({
    operation: z.literal("oauth.begin"),
    flow: z.literal("embedded_signup"),
    intentId: z.uuid(),
    appId: z.string().min(1).max(128),
    apiVersion: z.string().regex(/^v\d+\.\d+$/),
    configurationId: z.string().min(1).max(128),
    messageOrigins: z.array(z.url()).max(4),
    expiresAt: z.iso.datetime(),
  }),
  shared.pick({ requestId: true }).extend({
    operation: z.literal("whatsapp.complete"),
    authorized: z.literal(true),
  }),
  shared.pick({ requestId: true }).extend({
    operation: z.literal("grant.issue"), intentId: z.uuid(), code: z.string().regex(/^[A-Za-z0-9_-]{40,128}$/), expiresAt: z.iso.datetime(),
  }),
  shared.pick({ requestId: true }).extend({ operation: z.literal("grant.exchange"), grant: growthAgentChannelGrantSchema }),
  shared.pick({ requestId: true }).extend({ operation: z.literal("grant.activate"), grant: growthAgentChannelGrantSchema }),
  shared.pick({ requestId: true }).extend({ operation: z.literal("grant.revoke"), grant: growthAgentChannelGrantSchema }),
  shared.pick({ requestId: true }).extend({
    operation: z.literal("message.send"),
    state: z.enum(["accepted", "failed", "unknown"]),
    providerMessageId: z.string().trim().min(1).max(512).nullable(),
    code: z.string().max(128).nullable(),
  }),
  shared.pick({ requestId: true }).extend({ operation: z.literal("webhook.deliver"), accepted: z.literal(true) }),
]);
export type GrowthAgentChannelResponse = z.infer<typeof growthAgentChannelResponseSchema>;

export class GrowthAgentChannelContractError extends Error {
  constructor() { super("Invalid Growth channel request"); this.name = "GrowthAgentChannelContractError"; }
}
export function parseGrowthAgentChannelRequest(value: unknown): GrowthAgentChannelRequest {
  const result = growthAgentChannelRequestSchema.safeParse(value);
  if (!result.success) throw new GrowthAgentChannelContractError();
  return result.data;
}
