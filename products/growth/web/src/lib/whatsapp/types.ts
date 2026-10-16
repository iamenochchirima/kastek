import type {
  WhatsappCampaign,
  WhatsappCampaignRecipient,
  WhatsappConnection,
  WhatsappContact,
  WhatsappTemplate,
} from "@kasitek/database";

export type MarketingVariableSource = "static" | "contact";

export type MarketingVariableMapping = {
  source: MarketingVariableSource;
  key: string;
};

export type WhatsappAudienceOptInStatus = "all" | "opted_in" | "not_opted_in";

export type WhatsappAudienceExcludedStatus = "all" | "active_only" | "excluded_only";

export type WhatsappAudienceCooldownStatus = "all" | "passed" | "recent";

export type WhatsappAudienceFilter = {
  tags?: string[];
  location?: string;
  search?: string;
  optInStatus?: WhatsappAudienceOptInStatus;
  excludedStatus?: WhatsappAudienceExcludedStatus;
  cooldownStatus?: WhatsappAudienceCooldownStatus;
};

export type CreateWhatsappCampaignInput = {
  name: string;
  description?: string;
  connectionId: string;
  templateId: string;
  recipientIds?: string[];
  audience?: WhatsappAudienceFilter;
  scheduledAt?: string;
  variableMappings?: MarketingVariableMapping[];
};

export type LaunchWhatsappCampaignInput = {
  scheduledAt?: string;
};

export type UpdateWhatsappCampaignAction =
  | "pause"
  | "resume"
  | "cancel"
  | "retry_failed";

export type CampaignEligibilitySummary = {
  eligibleContactIds: string[];
  skipped: {
    notOptedIn: number;
    excluded: number;
    cooldown: number;
  };
};

export type CreateCampaignResult = {
  campaign: WhatsappCampaign;
  createdRecipients: number;
  skipped: CampaignEligibilitySummary["skipped"];
};

export type WhatsappConnectionSafe = Omit<WhatsappConnection, "accessTokenEncrypted">;

export type CampaignWithDetails = WhatsappCampaign & {
  connection: WhatsappConnection;
  template: WhatsappTemplate | null;
  recipients: (WhatsappCampaignRecipient & {
    contact: WhatsappContact;
  })[];
};

export type SendMarketingTemplateInput = {
  phoneNumberId: string;
  accessToken: string;
  recipientPhone: string;
  templateName: string;
  language: string;
  bodyParameters?: string[];
};

export type SendMarketingTemplateResult = {
  messageId: string;
  raw: unknown;
};

export type QueueSendJobData = {
  campaignId: string;
  recipientId: string;
  userId: string;
};

export type QueueInboxSendJobData = {
  conversationId: string;
  userId: string;
  text?: string;
  media?: {
    kind: "image" | "video" | "audio" | "document";
    mediaId: string;
    mimeType?: string | null;
    caption?: string | null;
    filename?: string | null;
  };
  replyToMessageId?: string;
  replyPreview?: string;
  replyToWhatsappMessageId?: string;
};

export type QueueWebhookJobData = {
  field?: string;
  value: Record<string, unknown>;
};

export type WebhookStatusPayload = {
  id?: string;
  recipient_id?: string;
  status?: string;
  timestamp?: string;
  conversation?: {
    id?: string;
    expiration_timestamp?: string;
    origin?: {
      type?: string;
    };
  };
  pricing?: {
    billable?: boolean | string;
    pricing_model?: string;
    category?: string;
    type?: string;
  };
  errors?: Array<{
    code?: number;
    title?: string;
    message?: string;
  }>;
};

export type WhatsappRealtimeEvent =
  | {
      type: "message.created";
      conversationId: string;
      conversation?: {
        channel?: "whatsapp" | "facebook" | "instagram";
        customerName: string | null;
        phone?: string;
        connectionId?: string | null;
        connectionLabel?: string | null;
        unreadCount?: number;
        lastMessageAt?: string;
      };
      message: {
        id: string;
        sender: "customer" | "bot";
        content: string;
        timestamp: string;
        status?: "PROCESSING" | "SENT" | "DELIVERED" | "READ" | "FAILED" | "BLOCKED";
        whatsappStatus?: "SENT" | "DELIVERED" | "READ" | "FAILED" | "BLOCKED";
        providerStatus?: "PROCESSING" | "SENT" | "DELIVERED" | "READ" | "FAILED";
        providerMessageId?: string | null;
        contentType?: string;
        attachments?: Array<{
          id: string;
          kind: "image" | "video" | "audio" | "document" | "sticker" | "file";
          mimeType?: string | null;
          fileName?: string | null;
          byteSize?: number | null;
          providerMediaId?: string | null;
          downloadStatus?: string | null;
          scanStatus?: string | null;
          metadata?: Record<string, unknown> | null;
        }>;
        reference?: {
          messageId?: string | null;
          providerMessageId?: string | null;
          kind?: string;
          previewText?: string | null;
          previewKind?: "image" | "video" | "audio" | "document" | "sticker" | "file" | null;
        } | null;
        reactions?: Array<{
          id: string;
          actorIdentifier: string;
          emoji?: string | null;
          active?: boolean;
          occurredAt?: string;
        }>;
      };
    }
  | {
      type: "message.updated";
      conversationId: string;
      message: {
        id: string;
        whatsappStatus?: "SENT" | "DELIVERED" | "READ" | "FAILED" | "BLOCKED";
        providerStatus?: "PROCESSING" | "SENT" | "DELIVERED" | "READ" | "FAILED";
        errorCode?: string | null;
        errorMessage?: string | null;
      };
    }
  | {
      type: "message.reactions_updated";
      conversationId: string;
      message: {
        id: string;
        reactions: Array<{
          id: string;
          actorIdentifier: string;
          emoji?: string | null;
          active?: boolean;
          occurredAt?: string;
        }>;
      };
    }
  | {
      type: "conversation.updated";
      conversationId: string;
      conversation: {
        id: string;
        channel?: "whatsapp" | "facebook" | "instagram";
        customerName: string | null;
        phone: string;
        connectionId?: string | null;
        connectionLabel?: string | null;
        lastMessageAt: string;
        unreadCount: number;
        starred?: boolean;
      };
    }
  | {
      type: "campaign.updated";
      campaignId: string;
      campaign: {
        id: string;
        status: string;
        totalRecipients: number;
        sentCount: number;
        deliveredCount: number;
        readCount: number;
        failedCount: number;
        blockedCount: number;
        unsubscribedCount: number;
        updatedAt?: string;
      };
    }
  | {
      type: "message.send_failed";
      conversationId: string;
      error: string;
      text?: string;
    }
  | {
      type: "call.created";
      callId: string;
      call: {
        id: string;
        connectionId: string;
        conversationId?: string | null;
        direction: string;
        status: string;
        fromPhone: string;
        toPhone: string;
        agentLabel?: string | null;
        connectionLabel?: string | null;
        conversationCustomerName?: string | null;
        startedAt?: string | null;
        answeredAt?: string | null;
        endedAt?: string | null;
      };
    }
  | {
      type: "call.updated";
      callId: string;
      action?: string;
      call: {
        id: string;
        connectionId: string;
        conversationId?: string | null;
        direction: string;
        status: string;
        fromPhone: string;
        toPhone: string;
        agentLabel?: string | null;
        connectionLabel?: string | null;
        conversationCustomerName?: string | null;
        startedAt?: string | null;
        answeredAt?: string | null;
        endedAt?: string | null;
      };
    }
  | {
      type: "call.signal";
      callId: string;
      kind: string;
      source?: string;
      signal: unknown;
      call: {
        id: string;
        connectionId: string;
        conversationId?: string | null;
        direction: string;
        status: string;
        fromPhone: string;
        toPhone: string;
        agentLabel?: string | null;
        connectionLabel?: string | null;
        conversationCustomerName?: string | null;
        startedAt?: string | null;
        answeredAt?: string | null;
        endedAt?: string | null;
      };
    };
