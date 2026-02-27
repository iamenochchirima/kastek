import type {
  WhatsappCampaign,
  WhatsappCampaignRecipient,
  WhatsappConnection,
  WhatsappContact,
  WhatsappTemplate,
} from "@kasiai/database";

export type MarketingVariableSource = "static" | "contact";

export type MarketingVariableMapping = {
  source: MarketingVariableSource;
  key: string;
};

export type CreateWhatsappCampaignInput = {
  name: string;
  description?: string;
  connectionId: string;
  templateId: string;
  recipientIds?: string[];
  scheduledAt?: string;
  variableMappings?: MarketingVariableMapping[];
};

export type LaunchWhatsappCampaignInput = {
  scheduledAt?: string;
};

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

export type WebhookStatusPayload = {
  id?: string;
  recipient_id?: string;
  status?: string;
  timestamp?: string;
  errors?: Array<{
    code?: number;
    title?: string;
    message?: string;
  }>;
};
