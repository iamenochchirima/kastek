import type { SocialChannel, SocialPost } from "../services/social/types.js";

export function socialChannelResponse(channel: SocialChannel) {
  return {
    id: channel.id, userId: channel.user_id, platform: channel.platform, status: channel.status,
    displayName: channel.display_name, handle: channel.handle, externalAccountId: channel.external_account_id,
    metadata: channel.metadata, lastSyncedAt: channel.last_synced_at, createdAt: channel.created_at, updatedAt: channel.updated_at,
  };
}

/** The human Content UI uses camelCase; domain rows retain their SQL field names. */
export function socialPostResponse(post: SocialPost) {
  const channel = post.primaryChannel;
  return {
    id: post.id, userId: post.user_id, primaryChannelId: post.primary_channel_id,
    title: post.title, prompt: post.prompt, content: post.content, channels: post.channels,
    status: post.status, scheduledFor: post.scheduled_for, publishedAt: post.published_at,
    metadata: post.metadata, createdAt: post.created_at, updatedAt: post.updated_at,
    primaryChannel: channel ? socialChannelResponse(channel) : null,
    variants: post.variants.map(variant => ({
      id: variant.id, postId: variant.post_id, platform: variant.platform, content: variant.content,
      status: variant.status, aiGenerated: variant.ai_generated, metadata: variant.metadata,
      createdAt: variant.created_at, updatedAt: variant.updated_at,
    })),
    media: post.media.map(item => ({
      id: item.id, postId: item.post_id, assetId: item.asset_id, kind: item.kind,
      mimeType: item.mime_type, fileName: item.file_name, byteSize: item.byte_size,
      width: item.width, height: item.height, durationMs: item.duration_ms, sortOrder: item.sort_order,
      altText: item.alt_text, processingStatus: item.processing_status, scanStatus: item.scan_status, metadata: item.metadata,
    })),
    publishJobs: post.publishJobs.map(job => ({
      id: job.id, userId: job.user_id, postId: job.post_id, variantId: job.variant_id,
      channelConnectionId: job.channel_connection_id, platform: job.platform, status: job.status,
      scheduledFor: job.scheduled_for, publishedAt: job.published_at, externalPostId: job.external_post_id,
      errorMessage: job.error_message, metadata: job.metadata, deliverySnapshot: job.deliverySnapshot,
      createdAt: job.created_at, updatedAt: job.updated_at,
    })),
  };
}
