-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "NotificationScopeType" AS ENUM ('USER', 'ADMIN', 'SYSTEM');

-- CreateEnum
CREATE TYPE "NotificationRecipientType" AS ENUM ('USER', 'ADMIN');

-- CreateEnum
CREATE TYPE "NotificationSeverity" AS ENUM ('INFO', 'SUCCESS', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'EMAIL');

-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'READ', 'DISMISSED');

-- CreateEnum
CREATE TYPE "NotificationFrequency" AS ENUM ('INSTANT', 'DIGEST', 'MUTE');

-- CreateEnum
CREATE TYPE "WhatsappConnectionQualityRating" AS ENUM ('UNKNOWN', 'GREEN', 'YELLOW', 'RED');

-- CreateEnum
CREATE TYPE "SocialPlatform" AS ENUM ('FACEBOOK', 'INSTAGRAM', 'LINKEDIN', 'X', 'WHATSAPP_STATUS');

-- CreateEnum
CREATE TYPE "SocialChannelStatus" AS ENUM ('CONNECTED', 'DISCONNECTED', 'NEEDS_REAUTH');

-- CreateEnum
CREATE TYPE "SocialPostStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'PROCESSING', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "SocialPublishJobStatus" AS ENUM ('PENDING', 'QUEUED', 'PROCESSING', 'PUBLISHED', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "SocialVariantStatus" AS ENUM ('DRAFT', 'APPROVED', 'NEEDS_EDITS');

-- CreateEnum
CREATE TYPE "WhatsappTemplateCategory" AS ENUM ('MARKETING', 'UTILITY', 'AUTHENTICATION');

-- CreateEnum
CREATE TYPE "WhatsappTemplateStatus" AS ENUM ('APPROVED', 'PENDING', 'REJECTED', 'DISABLED');

-- CreateEnum
CREATE TYPE "WhatsappCampaignStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'SENDING', 'PAUSED', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "WhatsappRecipientStatus" AS ENUM ('PENDING', 'QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'BLOCKED', 'UNSUBSCRIBED', 'SKIPPED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "emailVerified" TIMESTAMP(3),
    "image" TEXT,
    "password" TEXT,
    "phone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "AdminUser" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'admin',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BusinessProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "businessName" TEXT NOT NULL,
    "businessType" TEXT NOT NULL,
    "industry" TEXT,
    "description" TEXT,
    "address" TEXT,
    "city" TEXT,
    "province" TEXT,
    "postalCode" TEXT,
    "country" TEXT NOT NULL DEFAULT 'ZA',
    "phone" TEXT,
    "whatsappNumber" TEXT,
    "website" TEXT,
    "operatingHours" JSONB,
    "onboardingCompleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotConfiguration" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "greetingMessage" TEXT,
    "personality" TEXT,
    "language" TEXT NOT NULL DEFAULT 'en',
    "capabilities" JSONB,
    "knowledgeBase" JSONB,
    "integrationConfig" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BotConfiguration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OnboardingConversation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "step" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "messages" JSONB NOT NULL DEFAULT '[]',
    "extractedData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnboardingConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuoteRequest" (
    "id" TEXT NOT NULL,
    "businessName" TEXT NOT NULL,
    "contactPerson" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "businessType" TEXT NOT NULL,
    "services" TEXT[],
    "description" TEXT,
    "source" TEXT NOT NULL DEFAULT 'website',
    "status" TEXT NOT NULL DEFAULT 'new',
    "quoteAmount" DOUBLE PRECISION,
    "followUpDate" TIMESTAMP(3),
    "notes" JSONB NOT NULL DEFAULT '[]',
    "assignedToId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuoteRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductWaitlistEntry" (
    "id" TEXT NOT NULL,
    "businessName" TEXT NOT NULL,
    "contactPerson" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT NOT NULL,
    "businessType" TEXT,
    "products" TEXT[],
    "notes" TEXT,
    "source" TEXT NOT NULL DEFAULT 'website',
    "status" TEXT NOT NULL DEFAULT 'new',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductWaitlistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Quotation" (
    "id" TEXT NOT NULL,
    "businessName" TEXT NOT NULL,
    "contactPerson" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "contactPhone" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "serviceType" TEXT NOT NULL DEFAULT 'website_agent',
    "title" TEXT NOT NULL,
    "introduction" TEXT,
    "scopeOfWork" JSONB NOT NULL DEFAULT '[]',
    "deliverables" JSONB NOT NULL DEFAULT '[]',
    "implementationSteps" JSONB NOT NULL DEFAULT '[]',
    "pricingItems" JSONB NOT NULL DEFAULT '[]',
    "maintenanceIncludes" JSONB NOT NULL DEFAULT '[]',
    "termsAndNotes" JSONB NOT NULL DEFAULT '[]',
    "includedFunctionality" JSONB NOT NULL DEFAULT '[]',
    "knowledgeBaseScope" JSONB NOT NULL DEFAULT '[]',
    "importantNotes" JSONB NOT NULL DEFAULT '[]',
    "supportIncludes" JSONB NOT NULL DEFAULT '[]',
    "setupFee" TEXT NOT NULL,
    "monthlyFee" TEXT NOT NULL,
    "deliveryTimeline" TEXT,
    "validityDays" INTEGER NOT NULL DEFAULT 14,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "quoteRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Quotation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "businessName" TEXT NOT NULL,
    "contactPerson" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "contactPhone" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "serviceType" TEXT NOT NULL DEFAULT 'website_agent',
    "title" TEXT NOT NULL,
    "introduction" TEXT,
    "scopeOfWork" JSONB NOT NULL DEFAULT '[]',
    "deliverables" JSONB NOT NULL DEFAULT '[]',
    "implementationSteps" JSONB NOT NULL DEFAULT '[]',
    "pricingItems" JSONB NOT NULL DEFAULT '[]',
    "maintenanceIncludes" JSONB NOT NULL DEFAULT '[]',
    "termsAndNotes" JSONB NOT NULL DEFAULT '[]',
    "includedFunctionality" JSONB NOT NULL DEFAULT '[]',
    "knowledgeBaseScope" JSONB NOT NULL DEFAULT '[]',
    "importantNotes" JSONB NOT NULL DEFAULT '[]',
    "supportIncludes" JSONB NOT NULL DEFAULT '[]',
    "setupFee" TEXT NOT NULL,
    "monthlyFee" TEXT NOT NULL,
    "deliveryTimeline" TEXT,
    "validityDays" INTEGER NOT NULL DEFAULT 14,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "quoteRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachCampaign" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "totalLeads" INTEGER NOT NULL DEFAULT 0,
    "emailsSent" INTEGER NOT NULL DEFAULT 0,
    "replies" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutreachCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachLead" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "businessName" TEXT NOT NULL,
    "website" TEXT,
    "address" TEXT,
    "bizbayUrl" TEXT,
    "category" TEXT NOT NULL,
    "phone" TEXT,
    "emailStatus" TEXT NOT NULL DEFAULT 'pending',
    "emailAddress" TEXT,
    "emailSentAt" TIMESTAMP(3),
    "emailTemplate" TEXT,
    "followUpCount" INTEGER NOT NULL DEFAULT 0,
    "lastFollowUp" TIMESTAMP(3),
    "nextFollowUp" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutreachLead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachEmailDeliveryLog" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT,
    "leadId" TEXT,
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "recipient" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'smtp',
    "providerMessageId" TEXT,
    "providerResponse" TEXT,
    "errorMessage" TEXT,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutreachEmailDeliveryLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebServiceLead" (
    "id" TEXT NOT NULL,
    "businessName" TEXT NOT NULL,
    "website" TEXT,
    "address" TEXT,
    "category" TEXT NOT NULL,
    "bizbayUrl" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "callStatus" TEXT NOT NULL DEFAULT 'pending',
    "notes" TEXT,
    "callbackDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebServiceLead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "customerIdentifier" TEXT NOT NULL,
    "customerName" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReadAt" TIMESTAMP(3),
    "unreadCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "whatsappMessageId" TEXT,
    "whatsappStatus" TEXT,
    "whatsappConversationId" TEXT,
    "whatsappConversationOrigin" TEXT,
    "whatsappConversationExpires" TIMESTAMP(3),
    "whatsappPricingBillable" BOOLEAN,
    "whatsappPricingCategory" TEXT,
    "whatsappPricingModel" TEXT,
    "whatsappPricingType" TEXT,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationEvent" (
    "id" TEXT NOT NULL,
    "scopeType" "NotificationScopeType" NOT NULL,
    "scopeId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "severity" "NotificationSeverity" NOT NULL DEFAULT 'INFO',
    "entityType" TEXT,
    "entityId" TEXT,
    "actorType" TEXT,
    "actorId" TEXT,
    "payload" JSONB,
    "dedupeKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "recipientType" "NotificationRecipientType" NOT NULL,
    "recipientId" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING',
    "readAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationPreference" (
    "id" TEXT NOT NULL,
    "recipientType" "NotificationRecipientType" NOT NULL,
    "recipientId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "channel" "NotificationChannel" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "frequency" "NotificationFrequency" NOT NULL DEFAULT 'INSTANT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationDeliveryLog" (
    "id" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "provider" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "status" "NotificationStatus" NOT NULL,
    "responsePayload" JSONB,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationDeliveryLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsappConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "phoneNumberId" TEXT NOT NULL,
    "phoneDisplayNumber" TEXT,
    "accessTokenEncrypted" TEXT NOT NULL,
    "wabaId" TEXT NOT NULL,
    "currentQualityRating" "WhatsappConnectionQualityRating" NOT NULL DEFAULT 'UNKNOWN',
    "dailyLimitEstimate" INTEGER,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsappConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialChannelConnection" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "status" "SocialChannelStatus" NOT NULL DEFAULT 'CONNECTED',
    "displayName" TEXT NOT NULL,
    "handle" TEXT,
    "externalAccountId" TEXT,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "metadata" JSONB,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialChannelConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialPost" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "primaryChannelId" TEXT,
    "title" TEXT,
    "prompt" TEXT,
    "content" TEXT NOT NULL,
    "channels" "SocialPlatform"[],
    "status" "SocialPostStatus" NOT NULL DEFAULT 'DRAFT',
    "scheduledFor" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialPostVariant" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "platform" "SocialPlatform" NOT NULL,
    "content" TEXT NOT NULL,
    "status" "SocialVariantStatus" NOT NULL DEFAULT 'DRAFT',
    "aiGenerated" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialPostVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SocialPublishJob" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "variantId" TEXT,
    "channelConnectionId" TEXT,
    "platform" "SocialPlatform" NOT NULL,
    "status" "SocialPublishJobStatus" NOT NULL DEFAULT 'PENDING',
    "scheduledFor" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "externalPostId" TEXT,
    "errorMessage" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SocialPublishJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsappContact" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "fullName" TEXT,
    "tags" TEXT[],
    "location" TEXT,
    "listLabel" TEXT NOT NULL DEFAULT 'default',
    "metadata" JSONB,
    "optIn" BOOLEAN NOT NULL DEFAULT false,
    "optInSource" TEXT,
    "optInDate" TIMESTAMP(3),
    "lastMarketingSent" TIMESTAMP(3),
    "excluded" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsappContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsappTemplate" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectionId" TEXT,
    "templateName" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "category" "WhatsappTemplateCategory" NOT NULL DEFAULT 'MARKETING',
    "header" TEXT,
    "body" TEXT,
    "footer" TEXT,
    "buttons" JSONB,
    "variablesCount" INTEGER NOT NULL DEFAULT 0,
    "status" "WhatsappTemplateStatus" NOT NULL DEFAULT 'PENDING',
    "lastSynced" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsappTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsappCampaign" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "templateId" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "templateName" TEXT NOT NULL,
    "templateLanguage" TEXT NOT NULL,
    "variableMappings" JSONB,
    "listLabel" TEXT,
    "defaultBatchSize" INTEGER,
    "status" "WhatsappCampaignStatus" NOT NULL DEFAULT 'DRAFT',
    "scheduledAt" TIMESTAMP(3),
    "launchedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "totalRecipients" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "deliveredCount" INTEGER NOT NULL DEFAULT 0,
    "readCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "blockedCount" INTEGER NOT NULL DEFAULT 0,
    "unsubscribedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsappCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsappCampaignRecipient" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "status" "WhatsappRecipientStatus" NOT NULL DEFAULT 'PENDING',
    "waMessageId" TEXT,
    "sentAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WhatsappCampaignRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WhatsappSendEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "campaignId" TEXT,
    "recipientId" TEXT,
    "contactId" TEXT,
    "phone" TEXT NOT NULL,
    "templateName" TEXT NOT NULL,
    "status" "WhatsappRecipientStatus" NOT NULL,
    "whatsappMessageId" TEXT,
    "whatsappConversationId" TEXT,
    "whatsappConversationOrigin" TEXT,
    "whatsappConversationExpires" TIMESTAMP(3),
    "whatsappPricingBillable" BOOLEAN,
    "whatsappPricingCategory" TEXT,
    "whatsappPricingModel" TEXT,
    "whatsappPricingType" TEXT,
    "requestPayload" JSONB,
    "responsePayload" JSONB,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsappSendEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_email_key" ON "AdminUser"("email");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessProfile_userId_key" ON "BusinessProfile"("userId");

-- CreateIndex
CREATE INDEX "BotConfiguration_userId_idx" ON "BotConfiguration"("userId");

-- CreateIndex
CREATE INDEX "OnboardingConversation_userId_idx" ON "OnboardingConversation"("userId");

-- CreateIndex
CREATE INDEX "QuoteRequest_status_idx" ON "QuoteRequest"("status");

-- CreateIndex
CREATE INDEX "QuoteRequest_source_idx" ON "QuoteRequest"("source");

-- CreateIndex
CREATE INDEX "QuoteRequest_assignedToId_idx" ON "QuoteRequest"("assignedToId");

-- CreateIndex
CREATE INDEX "ProductWaitlistEntry_status_idx" ON "ProductWaitlistEntry"("status");

-- CreateIndex
CREATE INDEX "ProductWaitlistEntry_source_idx" ON "ProductWaitlistEntry"("source");

-- CreateIndex
CREATE INDEX "Quotation_status_idx" ON "Quotation"("status");

-- CreateIndex
CREATE INDEX "Quotation_quoteRequestId_idx" ON "Quotation"("quoteRequestId");

-- CreateIndex
CREATE INDEX "Invoice_status_idx" ON "Invoice"("status");

-- CreateIndex
CREATE INDEX "Invoice_quoteRequestId_idx" ON "Invoice"("quoteRequestId");

-- CreateIndex
CREATE INDEX "OutreachLead_campaignId_idx" ON "OutreachLead"("campaignId");

-- CreateIndex
CREATE INDEX "OutreachLead_emailStatus_idx" ON "OutreachLead"("emailStatus");

-- CreateIndex
CREATE INDEX "OutreachEmailDeliveryLog_campaignId_attemptedAt_idx" ON "OutreachEmailDeliveryLog"("campaignId", "attemptedAt");

-- CreateIndex
CREATE INDEX "OutreachEmailDeliveryLog_leadId_attemptedAt_idx" ON "OutreachEmailDeliveryLog"("leadId", "attemptedAt");

-- CreateIndex
CREATE INDEX "OutreachEmailDeliveryLog_status_idx" ON "OutreachEmailDeliveryLog"("status");

-- CreateIndex
CREATE INDEX "OutreachEmailDeliveryLog_isTest_attemptedAt_idx" ON "OutreachEmailDeliveryLog"("isTest", "attemptedAt");

-- CreateIndex
CREATE INDEX "WebServiceLead_callStatus_idx" ON "WebServiceLead"("callStatus");

-- CreateIndex
CREATE INDEX "WebServiceLead_category_idx" ON "WebServiceLead"("category");

-- CreateIndex
CREATE INDEX "Conversation_channel_idx" ON "Conversation"("channel");

-- CreateIndex
CREATE INDEX "Conversation_lastMessageAt_idx" ON "Conversation"("lastMessageAt");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_channel_customerIdentifier_key" ON "Conversation"("channel", "customerIdentifier");

-- CreateIndex
CREATE INDEX "Message_conversationId_idx" ON "Message"("conversationId");

-- CreateIndex
CREATE INDEX "Message_whatsappMessageId_idx" ON "Message"("whatsappMessageId");

-- CreateIndex
CREATE INDEX "Message_whatsappStatus_idx" ON "Message"("whatsappStatus");

-- CreateIndex
CREATE INDEX "NotificationEvent_scopeType_scopeId_createdAt_idx" ON "NotificationEvent"("scopeType", "scopeId", "createdAt");

-- CreateIndex
CREATE INDEX "NotificationEvent_eventType_createdAt_idx" ON "NotificationEvent"("eventType", "createdAt");

-- CreateIndex
CREATE INDEX "NotificationEvent_dedupeKey_idx" ON "NotificationEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "Notification_recipientType_recipientId_channel_createdAt_idx" ON "Notification"("recipientType", "recipientId", "channel", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_recipientType_recipientId_channel_readAt_idx" ON "Notification"("recipientType", "recipientId", "channel", "readAt");

-- CreateIndex
CREATE INDEX "Notification_status_channel_createdAt_idx" ON "Notification"("status", "channel", "createdAt");

-- CreateIndex
CREATE INDEX "NotificationPreference_recipientType_recipientId_idx" ON "NotificationPreference"("recipientType", "recipientId");

-- CreateIndex
CREATE UNIQUE INDEX "NotificationPreference_recipientType_recipientId_eventType__key" ON "NotificationPreference"("recipientType", "recipientId", "eventType", "channel");

-- CreateIndex
CREATE INDEX "NotificationDeliveryLog_notificationId_createdAt_idx" ON "NotificationDeliveryLog"("notificationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappConnection_phoneNumberId_key" ON "WhatsappConnection"("phoneNumberId");

-- CreateIndex
CREATE INDEX "WhatsappConnection_userId_idx" ON "WhatsappConnection"("userId");

-- CreateIndex
CREATE INDEX "WhatsappConnection_wabaId_idx" ON "WhatsappConnection"("wabaId");

-- CreateIndex
CREATE INDEX "SocialChannelConnection_userId_platform_idx" ON "SocialChannelConnection"("userId", "platform");

-- CreateIndex
CREATE INDEX "SocialChannelConnection_userId_status_idx" ON "SocialChannelConnection"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SocialChannelConnection_userId_platform_externalAccountId_key" ON "SocialChannelConnection"("userId", "platform", "externalAccountId");

-- CreateIndex
CREATE INDEX "SocialPost_userId_status_idx" ON "SocialPost"("userId", "status");

-- CreateIndex
CREATE INDEX "SocialPost_scheduledFor_idx" ON "SocialPost"("scheduledFor");

-- CreateIndex
CREATE INDEX "SocialPost_primaryChannelId_idx" ON "SocialPost"("primaryChannelId");

-- CreateIndex
CREATE INDEX "SocialPostVariant_platform_status_idx" ON "SocialPostVariant"("platform", "status");

-- CreateIndex
CREATE UNIQUE INDEX "SocialPostVariant_postId_platform_key" ON "SocialPostVariant"("postId", "platform");

-- CreateIndex
CREATE INDEX "SocialPublishJob_userId_status_idx" ON "SocialPublishJob"("userId", "status");

-- CreateIndex
CREATE INDEX "SocialPublishJob_postId_platform_idx" ON "SocialPublishJob"("postId", "platform");

-- CreateIndex
CREATE INDEX "SocialPublishJob_variantId_idx" ON "SocialPublishJob"("variantId");

-- CreateIndex
CREATE INDEX "SocialPublishJob_channelConnectionId_idx" ON "SocialPublishJob"("channelConnectionId");

-- CreateIndex
CREATE INDEX "SocialPublishJob_scheduledFor_idx" ON "SocialPublishJob"("scheduledFor");

-- CreateIndex
CREATE INDEX "WhatsappContact_userId_optIn_excluded_idx" ON "WhatsappContact"("userId", "optIn", "excluded");

-- CreateIndex
CREATE INDEX "WhatsappContact_userId_listLabel_idx" ON "WhatsappContact"("userId", "listLabel");

-- CreateIndex
CREATE INDEX "WhatsappContact_lastMarketingSent_idx" ON "WhatsappContact"("lastMarketingSent");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappContact_userId_phone_key" ON "WhatsappContact"("userId", "phone");

-- CreateIndex
CREATE INDEX "WhatsappTemplate_userId_status_category_idx" ON "WhatsappTemplate"("userId", "status", "category");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappTemplate_userId_templateName_language_key" ON "WhatsappTemplate"("userId", "templateName", "language");

-- CreateIndex
CREATE INDEX "WhatsappCampaign_userId_status_idx" ON "WhatsappCampaign"("userId", "status");

-- CreateIndex
CREATE INDEX "WhatsappCampaign_userId_listLabel_idx" ON "WhatsappCampaign"("userId", "listLabel");

-- CreateIndex
CREATE INDEX "WhatsappCampaign_connectionId_idx" ON "WhatsappCampaign"("connectionId");

-- CreateIndex
CREATE INDEX "WhatsappCampaign_templateId_idx" ON "WhatsappCampaign"("templateId");

-- CreateIndex
CREATE INDEX "WhatsappCampaign_scheduledAt_idx" ON "WhatsappCampaign"("scheduledAt");

-- CreateIndex
CREATE INDEX "WhatsappCampaignRecipient_campaignId_status_idx" ON "WhatsappCampaignRecipient"("campaignId", "status");

-- CreateIndex
CREATE INDEX "WhatsappCampaignRecipient_contactId_idx" ON "WhatsappCampaignRecipient"("contactId");

-- CreateIndex
CREATE INDEX "WhatsappCampaignRecipient_waMessageId_idx" ON "WhatsappCampaignRecipient"("waMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsappCampaignRecipient_campaignId_contactId_key" ON "WhatsappCampaignRecipient"("campaignId", "contactId");

-- CreateIndex
CREATE INDEX "WhatsappSendEvent_userId_createdAt_idx" ON "WhatsappSendEvent"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "WhatsappSendEvent_campaignId_idx" ON "WhatsappSendEvent"("campaignId");

-- CreateIndex
CREATE INDEX "WhatsappSendEvent_recipientId_idx" ON "WhatsappSendEvent"("recipientId");

-- CreateIndex
CREATE INDEX "WhatsappSendEvent_contactId_idx" ON "WhatsappSendEvent"("contactId");

-- CreateIndex
CREATE INDEX "WhatsappSendEvent_status_idx" ON "WhatsappSendEvent"("status");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessProfile" ADD CONSTRAINT "BusinessProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotConfiguration" ADD CONSTRAINT "BotConfiguration_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingConversation" ADD CONSTRAINT "OnboardingConversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuoteRequest" ADD CONSTRAINT "QuoteRequest_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "AdminUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Quotation" ADD CONSTRAINT "Quotation_quoteRequestId_fkey" FOREIGN KEY ("quoteRequestId") REFERENCES "QuoteRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_quoteRequestId_fkey" FOREIGN KEY ("quoteRequestId") REFERENCES "QuoteRequest"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachLead" ADD CONSTRAINT "OutreachLead_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "OutreachCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachEmailDeliveryLog" ADD CONSTRAINT "OutreachEmailDeliveryLog_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "OutreachCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachEmailDeliveryLog" ADD CONSTRAINT "OutreachEmailDeliveryLog_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "OutreachLead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "NotificationEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationDeliveryLog" ADD CONSTRAINT "NotificationDeliveryLog_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappConnection" ADD CONSTRAINT "WhatsappConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialChannelConnection" ADD CONSTRAINT "SocialChannelConnection_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPost" ADD CONSTRAINT "SocialPost_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPost" ADD CONSTRAINT "SocialPost_primaryChannelId_fkey" FOREIGN KEY ("primaryChannelId") REFERENCES "SocialChannelConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPostVariant" ADD CONSTRAINT "SocialPostVariant_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SocialPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPublishJob" ADD CONSTRAINT "SocialPublishJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPublishJob" ADD CONSTRAINT "SocialPublishJob_postId_fkey" FOREIGN KEY ("postId") REFERENCES "SocialPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPublishJob" ADD CONSTRAINT "SocialPublishJob_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "SocialPostVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPublishJob" ADD CONSTRAINT "SocialPublishJob_channelConnectionId_fkey" FOREIGN KEY ("channelConnectionId") REFERENCES "SocialChannelConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappContact" ADD CONSTRAINT "WhatsappContact_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappTemplate" ADD CONSTRAINT "WhatsappTemplate_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappTemplate" ADD CONSTRAINT "WhatsappTemplate_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "WhatsappConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappCampaign" ADD CONSTRAINT "WhatsappCampaign_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappCampaign" ADD CONSTRAINT "WhatsappCampaign_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "WhatsappConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappCampaign" ADD CONSTRAINT "WhatsappCampaign_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "WhatsappTemplate"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappCampaignRecipient" ADD CONSTRAINT "WhatsappCampaignRecipient_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "WhatsappCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappCampaignRecipient" ADD CONSTRAINT "WhatsappCampaignRecipient_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "WhatsappContact"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappSendEvent" ADD CONSTRAINT "WhatsappSendEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappSendEvent" ADD CONSTRAINT "WhatsappSendEvent_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "WhatsappConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappSendEvent" ADD CONSTRAINT "WhatsappSendEvent_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "WhatsappCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappSendEvent" ADD CONSTRAINT "WhatsappSendEvent_recipientId_fkey" FOREIGN KEY ("recipientId") REFERENCES "WhatsappCampaignRecipient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WhatsappSendEvent" ADD CONSTRAINT "WhatsappSendEvent_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "WhatsappContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
