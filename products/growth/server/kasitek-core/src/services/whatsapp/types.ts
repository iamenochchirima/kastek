import { wireInteger } from "@kasitek-labs/server-support/json";
export type Row = Record<string, any>;
export interface WhatsappConnectionRow {
  id: string;
  user_id: string;
  org_id: string | null;
  phone_number_id: string;
  phone_display_number: string | null;
  access_token_encrypted: string;
  waba_id: string;
  auth_method: string;
  provider_permissions: unknown | null;
  current_quality_rating: string;
  daily_limit_estimate: number | null;
  verified: boolean;
  created_at: Date;
  updated_at: Date;
}
export interface WhatsappConnectionPublic {
  id: string;
  user_id: string;
  phone_number_id: string;
  phone_display_number: string | null;
  waba_id: string;
  current_quality_rating: string;
  daily_limit_estimate: number | null;
  verified: boolean;
  created_at: Date;
  updated_at: Date;
}
export interface WhatsappTemplateRow {
  id: string;
  user_id: string;
  connection_id: string | null;
  template_name: string;
  language: string;
  category: string;
  header: string | null;
  body: string | null;
  footer: string | null;
  buttons: unknown | null;
  variables_count: number;
  status: string;
  last_synced: Date | null;
  created_at: Date;
  updated_at: Date;
}
export interface WhatsappConnectionCreateRequest {
  waba_id?: string | null;
  phone_number_id?: string | null;
  access_token?: string | null;
  phone_display_number?: string | null;
}
export interface WhatsappConnectionTokenRequest {
  access_token?: string | null;
}
export interface WhatsappTemplateCreateRequest {
  connection_id?: string | null;
  template_name?: string | null;
  language?: string | null;
  category?: string | null;
  header?: string | null;
  body?: string | null;
  footer?: string | null;
}
export interface WhatsappCampaignRow {
  id: string;
  user_id: string;
  org_id: string | null;
  connection_id: string;
  template_id: string | null;
  name: string;
  description: string | null;
  template_name: string;
  template_language: string;
  variable_mappings: unknown | null;
  template_header: string | null;
  template_body: string | null;
  template_footer: string | null;
  template_buttons: unknown | null;
  list_label: string | null;
  default_batch_size: number | null;
  status: string;
  scheduled_at: Date | null;
  launched_at: Date | null;
  completed_at: Date | null;
  total_recipients: number;
  sent_count: number;
  delivered_count: number;
  read_count: number;
  failed_count: number;
  blocked_count: number;
  unsubscribed_count: number;
  created_at: Date;
  updated_at: Date;
  connection_label: string | null;
  template_status: string | null;
}
export interface WhatsappCampaignRecipientRow {
  id: string;
  campaign_id: string;
  contact_id: string;
  snapshot_phone: string | null;
  snapshot_full_name: string | null;
  snapshot_location: string | null;
  snapshot_list_label: string | null;
  snapshot_metadata: unknown | null;
  status: string;
  wa_message_id: string | null;
  sent_at: Date | null;
  delivered_at: Date | null;
  read_at: Date | null;
  failed_at: Date | null;
  attempt_count: number;
  last_attempt_at: Date | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}
export interface WhatsappCampaignRecipientDetailRow {
  id: string;
  campaign_id: string;
  contact_id: string;
  snapshot_phone: string | null;
  snapshot_full_name: string | null;
  snapshot_location: string | null;
  snapshot_list_label: string | null;
  snapshot_metadata: unknown | null;
  status: string;
  wa_message_id: string | null;
  sent_at: Date | null;
  delivered_at: Date | null;
  read_at: Date | null;
  failed_at: Date | null;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
  contact_phone: string;
  contact_full_name: string | null;
  contact_location: string | null;
  contact_list_label: string;
  contact_metadata: unknown | null;
}
export interface WhatsappListContactRow {
  total_count: number | bigint | string;
  id: string;
  contact_id: string;
  customer_id: string | null;
  user_id: string;
  phone: string;
  full_name: string | null;
  tags: string[];
  location: string | null;
  list_label: string;
  metadata: unknown | null;
  opt_in: boolean;
  opt_in_source: string | null;
  opt_in_date: Date | null;
  last_marketing_sent: Date | null;
  excluded: boolean;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}
export interface WhatsappContactRow {
  id: string;
  user_id: string;
  phone: string;
  full_name: string | null;
  tags: string[];
  location: string | null;
  list_label: string;
  metadata: unknown | null;
  opt_in: boolean;
  opt_in_source: string | null;
  opt_in_date: Date | null;
  last_marketing_sent: Date | null;
  excluded: boolean;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}
export interface WhatsappContactListQuery {
  q?: string | null;
  opt_in?: string | null;
  excluded?: string | null;
  tag?: string | null;
  location?: string | null;
  list_label?: string | null;
  limit?: number | bigint | string | null;
  cursor?: number | bigint | string | null;
}
export interface WhatsappTemplateListQuery {
  status?: string | null;
}
export interface WhatsappAudienceFilterRequest {
  tags?: string[] | null;
  location?: string | null;
  search?: string | null;
  list_label?: string | null;
  opt_in_status?: string | null;
  excluded_status?: string | null;
  cooldown_status?: string | null;
}
export interface WhatsappCampaignCreateRequest {
  name?: string | null;
  description?: string | null;
  connection_id?: string | null;
  template_id?: string | null;
  recipient_ids?: string[] | null;
  excluded_contact_ids?: string[] | null;
  list_label?: string | null;
  batch_size?: number | null;
  scheduled_at?: string | null;
  variable_mappings?: unknown | null;
  audience?: WhatsappAudienceFilterRequest | null;
}
export interface WhatsappCampaignActionRequest {
  action?: string | null;
  batch_size?: number | null;
  excluded_contact_ids?: string[] | null;
  scheduled_at?: string | null;
}
export interface WhatsappStartConversationRequest {
  connection_id?: string | null;
  template_id?: string | null;
  phone?: string | null;
  customer_name?: string | null;
  body_parameters?: string[] | null;
}
export interface WhatsappSendMessageRequest {
  text?: string | null;
  reply_to_message_id?: string | null;
}
export interface WhatsappReactionRequest {
  emoji?: string | null;
  remove?: boolean | null;
}
export interface WhatsappContactUpdateRequest {
  full_name?: string | null;
  phone?: string | null;
  location?: string | null;
  tags?: string[] | null;
  notes?: string | null;
  list_label?: string | null;
  metadata?: unknown | null;
  opt_in?: boolean | null;
  excluded?: boolean | null;
}
export interface WhatsappContactListRenameRequest {
  next_label?: string | null;
}
export interface WhatsappContactImportInvalidRow {
  index: number | bigint | string;
  error: string;
  row: Row;
}
export interface WhatsappEmbeddedSignupRequest {
  code?: string | null;
  waba_id?: string | null;
  phone_number_id?: string | null;
}
const WIRE = {
  WhatsappConnectionRow: {
    id: ["id", false],
    user_id: ["user_id", false],
    org_id: ["orgId", false],
    phone_number_id: ["phone_number_id", false],
    phone_display_number: ["phone_display_number", false],
    access_token_encrypted: ["access_token_encrypted", false],
    waba_id: ["waba_id", false],
    auth_method: ["auth_method", false],
    provider_permissions: ["provider_permissions", false],
    current_quality_rating: ["current_quality_rating", false],
    daily_limit_estimate: ["daily_limit_estimate", false],
    verified: ["verified", false],
    created_at: ["created_at", false],
    updated_at: ["updated_at", false],
  },
  WhatsappTemplateRow: {
    id: ["id", false],
    user_id: ["user_id", false],
    connection_id: ["connection_id", false],
    template_name: ["template_name", false],
    language: ["language", false],
    category: ["category", false],
    header: ["header", false],
    body: ["body", false],
    footer: ["footer", false],
    buttons: ["buttons", false],
    variables_count: ["variables_count", false],
    status: ["status", false],
    last_synced: ["last_synced", false],
    created_at: ["created_at", false],
    updated_at: ["updated_at", false],
  },
  WhatsappCampaignRow: {
    id: ["id", false],
    user_id: ["user_id", false],
    org_id: ["orgId", false],
    connection_id: ["connection_id", false],
    template_id: ["template_id", false],
    name: ["name", false],
    description: ["description", false],
    template_name: ["template_name", false],
    template_language: ["template_language", false],
    variable_mappings: ["variableMappings", false],
    template_header: ["templateHeader", false],
    template_body: ["templateBody", false],
    template_footer: ["templateFooter", false],
    template_buttons: ["templateButtons", false],
    list_label: ["listLabel", false],
    default_batch_size: ["defaultBatchSize", false],
    status: ["status", false],
    scheduled_at: ["scheduled_at", false],
    launched_at: ["launched_at", false],
    completed_at: ["completed_at", false],
    total_recipients: ["total_recipients", false],
    sent_count: ["sent_count", false],
    delivered_count: ["delivered_count", false],
    read_count: ["read_count", false],
    failed_count: ["failed_count", false],
    blocked_count: ["blocked_count", false],
    unsubscribed_count: ["unsubscribed_count", false],
    created_at: ["created_at", false],
    updated_at: ["updated_at", false],
    connection_label: ["connectionLabel", false],
    template_status: ["templateStatus", false],
  },
  WhatsappCampaignRecipientRow: {
    id: ["id", false],
    campaign_id: ["campaign_id", false],
    contact_id: ["contact_id", false],
    snapshot_phone: ["snapshotPhone", false],
    snapshot_full_name: ["snapshotFullName", false],
    snapshot_location: ["snapshotLocation", false],
    snapshot_list_label: ["snapshotListLabel", false],
    snapshot_metadata: ["snapshotMetadata", false],
    status: ["status", false],
    wa_message_id: ["wa_message_id", false],
    sent_at: ["sent_at", false],
    delivered_at: ["delivered_at", false],
    read_at: ["read_at", false],
    failed_at: ["failed_at", false],
    attempt_count: ["attempt_count", false],
    last_attempt_at: ["last_attempt_at", false],
    error_code: ["error_code", false],
    error_message: ["error_message", false],
    created_at: ["created_at", false],
    updated_at: ["updated_at", false],
  },
  WhatsappCampaignRecipientDetailRow: {
    id: ["id", false],
    campaign_id: ["campaign_id", false],
    contact_id: ["contact_id", false],
    snapshot_phone: ["snapshotPhone", false],
    snapshot_full_name: ["snapshotFullName", false],
    snapshot_location: ["snapshotLocation", false],
    snapshot_list_label: ["snapshotListLabel", false],
    snapshot_metadata: ["snapshotMetadata", false],
    status: ["status", false],
    wa_message_id: ["waMessageId", false],
    sent_at: ["sentAt", false],
    delivered_at: ["deliveredAt", false],
    read_at: ["readAt", false],
    failed_at: ["failedAt", false],
    error_code: ["errorCode", false],
    error_message: ["errorMessage", false],
    created_at: ["createdAt", false],
    updated_at: ["updatedAt", false],
    contact_phone: ["contactPhone", false],
    contact_full_name: ["contactFullName", false],
    contact_location: ["contactLocation", false],
    contact_list_label: ["contactListLabel", false],
    contact_metadata: ["contactMetadata", false],
  },
  WhatsappListContactRow: {
    id: ["id", false],
    contact_id: ["contactId", false],
    customer_id: ["customerId", false],
    user_id: ["userId", false],
    phone: ["phone", false],
    full_name: ["fullName", false],
    tags: ["tags", false],
    location: ["location", false],
    list_label: ["listLabel", false],
    metadata: ["metadata", false],
    opt_in: ["optIn", false],
    opt_in_source: ["optInSource", false],
    opt_in_date: ["optInDate", false],
    last_marketing_sent: ["lastMarketingSent", false],
    excluded: ["excluded", false],
    notes: ["notes", false],
    created_at: ["createdAt", false],
    updated_at: ["updatedAt", false],
  },
  WhatsappContactRow: {
    id: ["id", false],
    user_id: ["userId", false],
    phone: ["phone", false],
    full_name: ["fullName", false],
    tags: ["tags", false],
    location: ["location", false],
    list_label: ["listLabel", false],
    metadata: ["metadata", false],
    opt_in: ["optIn", false],
    opt_in_source: ["optInSource", false],
    opt_in_date: ["optInDate", false],
    last_marketing_sent: ["lastMarketingSent", false],
    excluded: ["excluded", false],
    notes: ["notes", false],
    created_at: ["createdAt", false],
    updated_at: ["updatedAt", false],
  },
  WhatsappContactImportInvalidRow: {
    index: ["index", true],
    error: ["error", false],
    row: ["row", false],
  },
} as const;
export function rowView(name: keyof typeof WIRE, row: Row): Row {
  const result: Row = {};
  for (const [key, [wire, integer]] of Object.entries(WIRE[name]))
    result[wire] =
      integer && row[key] != null ? wireInteger(row[key]) : (row[key] ?? null);
  return result;
}
