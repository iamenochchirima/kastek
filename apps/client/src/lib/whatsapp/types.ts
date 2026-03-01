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
