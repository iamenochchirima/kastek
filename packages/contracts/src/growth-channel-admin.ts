import { z } from "zod";

const bounded = (max: number) => z.string().trim().min(1).max(max);
const actor = z.strictObject({
  issuer: z.string().url().max(512),
  subject: bounded(512),
});
const base = {
  version: z.literal("1"),
  requestId: z.uuid(),
  actor,
  growthOrganizationId: bounded(128),
};
const connectionId = z.uuid();
const expectedRevision = z.number().int().positive();
const botToken = z.string().regex(/^\d+:[A-Za-z0-9_-]{1,256}$/);

export const growthChannelAdminRequestSchema = z.discriminatedUnion("operation", [
  z.strictObject({
    ...base,
    operation: z.literal("telegram.connect"),
    name: bounded(120),
    botToken,
  }),
  z.strictObject({
    ...base,
    operation: z.literal("telegram.health"),
    connectionId,
    expectedRevision,
  }),
  z.strictObject({
    ...base,
    operation: z.literal("telegram.rotate"),
    connectionId,
    expectedRevision,
    botToken,
  }),
  z.strictObject({
    ...base,
    operation: z.literal("telegram.disconnect"),
    connectionId,
    expectedRevision,
  }),
  z.strictObject({
    ...base,
    operation: z.literal("channel.list"),
  }),
  z.strictObject({
    ...base,
    operation: z.literal("assistant.target"),
  }),
  z.strictObject({
    ...base,
    operation: z.literal("channel.bind"),
    connectionId,
    expectedRevision,
  }),
  z.strictObject({
    ...base,
    operation: z.literal("channel.unbind"),
    connectionId,
  }),
  z.strictObject({
    ...base,
    operation: z.literal("growth.link"),
    provider: z.literal("whatsapp"),
    connectionId: z.string().trim().min(1).max(128),
    providerAssetId: z.string().trim().min(1).max(512),
    permissionRevision: z.string().min(1).max(128),
    name: z.string().trim().min(1).max(120),
    providerMode: z.literal("meta"),
    grantId: z.uuid(),
    intentId: z.uuid(),
    growthRequestId: z.uuid(),
    exchangeRequestId: z.uuid(),
  }),
  z.strictObject({
    ...base,
    operation: z.literal("growth.unlink"),
    connectionId,
    expectedRevision: expectedRevision.optional(),
  }),
]);

export type GrowthChannelAdminRequest = z.infer<
  typeof growthChannelAdminRequestSchema
>;

export const growthChannelAdminConnectionSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  kind: z.string().min(1).max(40),
  name: z.string().min(1).max(120),
  assetId: z.string().max(512).nullable(),
  mode: z.string().min(1).max(40),
  state: z.string().min(1).max(40),
  revision: z.number().int().positive(),
  credentialRevision: z.number().int().nonnegative(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string().min(20).max(40),
  updatedAt: z.string().min(20).max(40),
});

export const growthChannelAdminDeploymentSchema = z.object({
  id: z.uuid(),
  organizationId: z.uuid(),
  connectionId: z.uuid(),
  agentId: z.uuid(),
  versionId: z.uuid(),
  state: z.string().min(1).max(40),
  revision: z.number().int().positive(),
  createdAt: z.string().min(20).max(40),
  updatedAt: z.string().min(20).max(40),
});

export const growthChannelAdminResponseSchema = z.object({
  version: z.literal("1"),
  requestId: z.uuid(),
  operation: z.string().min(1).max(80),
  connection: growthChannelAdminConnectionSchema.optional(),
  connections: z.array(growthChannelAdminConnectionSchema).max(100).optional(),
  deployment: growthChannelAdminDeploymentSchema.optional(),
  deployments: z.array(growthChannelAdminDeploymentSchema).max(100).optional(),
  targetAgentId: z.uuid().optional(),
  status: z.string().min(1).max(40).optional(),
}).strict();

export type GrowthChannelAdminResponse = z.infer<
  typeof growthChannelAdminResponseSchema
>;

export function parseGrowthChannelAdminRequest(
  value: unknown,
): GrowthChannelAdminRequest {
  return growthChannelAdminRequestSchema.parse(value);
}

export function parseGrowthChannelAdminResponse(
  value: unknown,
): GrowthChannelAdminResponse {
  return growthChannelAdminResponseSchema.parse(value);
}
