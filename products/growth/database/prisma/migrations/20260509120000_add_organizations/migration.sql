-- CreateEnum
CREATE TYPE "OrgRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

-- CreateTable: Organization
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logo" TEXT,
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");
CREATE INDEX "Organization_ownerId_idx" ON "Organization"("ownerId");

-- CreateTable: OrganizationMember
CREATE TABLE "OrganizationMember" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "OrgRole" NOT NULL DEFAULT 'MEMBER',
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationMember_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrganizationMember_orgId_userId_key" ON "OrganizationMember"("orgId", "userId");
CREATE INDEX "OrganizationMember_userId_idx" ON "OrganizationMember"("userId");
CREATE INDEX "OrganizationMember_orgId_role_idx" ON "OrganizationMember"("orgId", "role");

-- CreateTable: OrganizationInvitation
CREATE TABLE "OrganizationInvitation" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "OrgRole" NOT NULL DEFAULT 'MEMBER',
    "token" TEXT NOT NULL,
    "invitedById" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationInvitation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrganizationInvitation_token_key" ON "OrganizationInvitation"("token");
CREATE UNIQUE INDEX "OrganizationInvitation_orgId_email_key" ON "OrganizationInvitation"("orgId", "email");
CREATE INDEX "OrganizationInvitation_token_idx" ON "OrganizationInvitation"("token");
CREATE INDEX "OrganizationInvitation_orgId_acceptedAt_idx" ON "OrganizationInvitation"("orgId", "acceptedAt");

-- AddForeignKey: Organization.ownerId -> User.id
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey: OrganizationMember
ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrganizationMember" ADD CONSTRAINT "OrganizationMember_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey: OrganizationInvitation
ALTER TABLE "OrganizationInvitation" ADD CONSTRAINT "OrganizationInvitation_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "OrganizationInvitation" ADD CONSTRAINT "OrganizationInvitation_invitedById_fkey"
    FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── Add orgId columns to resource tables ──────────────────

ALTER TABLE "BotConfiguration"             ADD COLUMN "orgId" TEXT;
ALTER TABLE "WhatsappConnection"           ADD COLUMN "orgId" TEXT;
ALTER TABLE "WhatsappCallSession"          ADD COLUMN "orgId" TEXT;
ALTER TABLE "SocialChannelConnection"      ADD COLUMN "orgId" TEXT;
ALTER TABLE "SocialPost"                   ADD COLUMN "orgId" TEXT;
ALTER TABLE "SocialPublishJob"             ADD COLUMN "orgId" TEXT;
ALTER TABLE "WhatsappContact"              ADD COLUMN "orgId" TEXT;
ALTER TABLE "WhatsappContactListMembership" ADD COLUMN "orgId" TEXT;
ALTER TABLE "WhatsappTemplate"             ADD COLUMN "orgId" TEXT;
ALTER TABLE "WhatsappCampaign"             ADD COLUMN "orgId" TEXT;
ALTER TABLE "WhatsappSendEvent"            ADD COLUMN "orgId" TEXT;
ALTER TABLE "Conversation"                 ADD COLUMN "orgId" TEXT;

-- ─── Backfill: create personal org for every existing user ──

-- Step 1: insert one org per user (slug = user id, name = user name or email prefix)
INSERT INTO "Organization" ("id", "name", "slug", "ownerId", "createdAt", "updatedAt")
SELECT
    gen_random_uuid()::text,
    COALESCE(u.name, split_part(u.email, '@', 1), 'My Workspace'),
    u.id,  -- use userId as slug (guaranteed unique)
    u.id,
    NOW(),
    NOW()
FROM "User" u;

-- Step 2: add owner as OWNER member of their org
INSERT INTO "OrganizationMember" ("id", "orgId", "userId", "role", "joinedAt", "createdAt", "updatedAt")
SELECT
    gen_random_uuid()::text,
    o.id,
    o."ownerId",
    'OWNER'::"OrgRole",
    NOW(),
    NOW(),
    NOW()
FROM "Organization" o;

-- Step 3: backfill orgId on all resource tables using userId -> org lookup
UPDATE "BotConfiguration" r
SET "orgId" = o.id
FROM "Organization" o WHERE o."ownerId" = r."userId";

UPDATE "WhatsappConnection" r
SET "orgId" = o.id
FROM "Organization" o WHERE o."ownerId" = r."userId";

UPDATE "WhatsappCallSession" r
SET "orgId" = o.id
FROM "Organization" o WHERE o."ownerId" = r."userId";

UPDATE "SocialChannelConnection" r
SET "orgId" = o.id
FROM "Organization" o WHERE o."ownerId" = r."userId";

UPDATE "SocialPost" r
SET "orgId" = o.id
FROM "Organization" o WHERE o."ownerId" = r."userId";

UPDATE "SocialPublishJob" r
SET "orgId" = o.id
FROM "Organization" o WHERE o."ownerId" = r."userId";

UPDATE "WhatsappContact" r
SET "orgId" = o.id
FROM "Organization" o WHERE o."ownerId" = r."userId";

UPDATE "WhatsappContactListMembership" r
SET "orgId" = o.id
FROM "Organization" o WHERE o."ownerId" = r."userId";

UPDATE "WhatsappTemplate" r
SET "orgId" = o.id
FROM "Organization" o WHERE o."ownerId" = r."userId";

UPDATE "WhatsappCampaign" r
SET "orgId" = o.id
FROM "Organization" o WHERE o."ownerId" = r."userId";

UPDATE "WhatsappSendEvent" r
SET "orgId" = o.id
FROM "Organization" o WHERE o."ownerId" = r."userId";

-- Conversation has no userId — leave orgId null for now (set when webhook fires via connectionId->orgId lookup)

-- ─── Add indexes ────────────────────────────────────────────

CREATE INDEX "BotConfiguration_orgId_idx"              ON "BotConfiguration"("orgId");
CREATE INDEX "WhatsappConnection_orgId_idx"            ON "WhatsappConnection"("orgId");
CREATE INDEX "WhatsappCallSession_orgId_createdAt_idx" ON "WhatsappCallSession"("orgId", "createdAt");
CREATE INDEX "SocialChannelConnection_orgId_platform_idx" ON "SocialChannelConnection"("orgId", "platform");
CREATE INDEX "SocialPost_orgId_status_idx"             ON "SocialPost"("orgId", "status");
CREATE INDEX "SocialPublishJob_orgId_status_idx"       ON "SocialPublishJob"("orgId", "status");
CREATE INDEX "WhatsappContact_orgId_listLabel_idx"     ON "WhatsappContact"("orgId", "listLabel");
CREATE INDEX "WhatsappContactListMembership_orgId_listLabel_idx" ON "WhatsappContactListMembership"("orgId", "listLabel");
CREATE INDEX "WhatsappTemplate_orgId_status_idx"       ON "WhatsappTemplate"("orgId", "status");
CREATE INDEX "WhatsappCampaign_orgId_status_idx"       ON "WhatsappCampaign"("orgId", "status");
CREATE INDEX "WhatsappSendEvent_orgId_createdAt_idx"   ON "WhatsappSendEvent"("orgId", "createdAt");
CREATE INDEX "Conversation_orgId_lastMessageAt_idx"    ON "Conversation"("orgId", "lastMessageAt");

-- ─── Add foreign keys for orgId columns ─────────────────────

ALTER TABLE "BotConfiguration"             ADD CONSTRAINT "BotConfiguration_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WhatsappConnection"           ADD CONSTRAINT "WhatsappConnection_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WhatsappCallSession"          ADD CONSTRAINT "WhatsappCallSession_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SocialChannelConnection"      ADD CONSTRAINT "SocialChannelConnection_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SocialPost"                   ADD CONSTRAINT "SocialPost_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "SocialPublishJob"             ADD CONSTRAINT "SocialPublishJob_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WhatsappContact"              ADD CONSTRAINT "WhatsappContact_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WhatsappContactListMembership" ADD CONSTRAINT "WhatsappContactListMembership_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WhatsappTemplate"             ADD CONSTRAINT "WhatsappTemplate_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WhatsappCampaign"             ADD CONSTRAINT "WhatsappCampaign_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "WhatsappSendEvent"            ADD CONSTRAINT "WhatsappSendEvent_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "Conversation"                 ADD CONSTRAINT "Conversation_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "Organization"("id") ON DELETE SET NULL ON UPDATE CASCADE;
