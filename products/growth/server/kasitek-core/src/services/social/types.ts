export type Json = unknown;
export interface SocialChannel {
  id: string;
  user_id: string;
  platform: string;
  status: string;
  display_name: string;
  handle: string | null;
  external_account_id: string | null;
  metadata: Json;
  last_synced_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
export interface SocialPostRow {
  id: string;
  user_id: string;
  primary_channel_id: string | null;
  title: string | null;
  prompt: string | null;
  content: string;
  channels: string[];
  status: string;
  scheduled_for: Date | null;
  published_at: Date | null;
  metadata: Json;
  created_at: Date;
  updated_at: Date;
}
export interface SocialPostVariant {
  id: string;
  post_id: string;
  platform: string;
  content: string;
  status: string;
  ai_generated: boolean;
  metadata: Json;
  created_at: Date;
  updated_at: Date;
}
export interface SocialPostMedia {
  id: string;
  post_id: string;
  asset_id: string;
  kind: string;
  mime_type: string;
  file_name: string | null;
  byte_size: bigint | string | number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  sort_order: number;
  alt_text: string | null;
  processing_status: string;
  scan_status: string;
  metadata: Json;
}
export interface SocialPublishJob {
  id: string;
  user_id: string;
  post_id: string;
  variant_id: string | null;
  channel_connection_id: string | null;
  platform: string;
  status: string;
  scheduled_for: Date | null;
  published_at: Date | null;
  external_post_id: string | null;
  error_message: string | null;
  metadata: Json;
  deliverySnapshot: Json;
  created_at: Date;
  updated_at: Date;
}
export interface SocialPost extends SocialPostRow {
  primaryChannel: SocialChannel | null;
  variants: SocialPostVariant[];
  media: SocialPostMedia[];
  publishJobs: SocialPublishJob[];
}
export interface SocialVariantInput {
  platform: string;
  content: string;
  status?: string | null;
  aiGenerated?: boolean | null;
  metadata?: Json;
}
export interface SocialMediaInput {
  assetId: string;
  sortOrder?: number | null;
  altText?: string | null;
  metadata?: Json;
}
export interface SocialPostUpsertRequest {
  title?: string | null;
  prompt?: string | null;
  content?: string | null;
  channels?: string[] | null;
  status?: string | null;
  scheduledFor?: string | null;
  primaryChannelId?: string | null;
  channelSelections?: Record<string, string> | null;
  variants?: SocialVariantInput[] | null;
  media?: SocialMediaInput[] | null;
  metadata?: Json;
}
