import { z } from "zod";
import { channelKindSchema } from "./channel-adapters";

export const channelModeSchema = z.enum(["website", "bot", "cloud_api", "meta", "instagram_login", "growth_managed"]);
export const channelConnectionStateSchema = z.enum(["pending", "active", "needs_attention", "disconnected", "removed"]);
export const channelConnectionSchema = z.strictObject({
  id: z.uuid(), organizationId: z.uuid(), createdBy: z.uuid(), kind: channelKindSchema,
  name: z.string(), assetId: z.string().nullable(), mode: channelModeSchema, state: channelConnectionStateSchema,
  providerHealth: z.enum(["ready", "needs_attention"]).optional(),
  revision: z.number().int().positive(), credentialRevision: z.number().int().nonnegative(),
  metadata: z.record(z.string(), z.unknown()), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});
export type ChannelConnection = z.infer<typeof channelConnectionSchema>;
export type ChannelMode = z.infer<typeof channelModeSchema>;
export const channelDeploymentSchema = z.strictObject({
  id: z.uuid(), organizationId: z.uuid(), connectionId: z.uuid(), agentId: z.uuid(), versionId: z.uuid(),
  state: z.enum(["active", "paused", "revoked"]), revision: z.number().int().positive(),
  createdBy: z.uuid(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
});
export type ChannelDeployment = z.infer<typeof channelDeploymentSchema>;
export const channelAssetSchema = z.strictObject({
  id: z.uuid(), organizationId: z.uuid(), connectionId: z.uuid(), providerAssetId: z.string(), name: z.string(),
  eligible: z.boolean(), reasonCode: z.string().nullable(), metadata: z.record(z.string(), z.unknown()), observedAt: z.iso.datetime(),
});
export type ChannelAsset = z.infer<typeof channelAssetSchema>;
