import type { Prisma } from "@kasitek/database";

export const socialChannelPublicSelect = {
  id: true,
  userId: true,
  platform: true,
  status: true,
  displayName: true,
  handle: true,
  externalAccountId: true,
  metadata: true,
  lastSyncedAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SocialChannelConnectionSelect;

