function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown, maxLength = 100): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function platformLabel(value: unknown): string | undefined {
  const platform = text(value, 40)?.toLowerCase();
  if (!platform) return undefined;
  if (platform === "x" || platform === "twitter") return "X";
  return platform.charAt(0).toUpperCase() + platform.slice(1);
}

function postTarget(snapshot: Record<string, unknown> | null | undefined): {
  title?: string;
  platform?: string;
  mediaCount?: number;
} {
  const resource = record(snapshot?.resource);
  const request = record(snapshot?.request);
  const operation = record(resource?.operation);
  const channels = Array.isArray(resource?.channels) ? resource.channels : [];
  return {
    title: text(resource?.title, 80),
    platform: platformLabel(operation?.platform ?? request?.platform ?? channels[0]),
    mediaCount: typeof resource?.mediaCount === "number" && resource.mediaCount > 0
      ? Math.min(Math.floor(resource.mediaCount), 10)
      : undefined,
  };
}

function quotedPost(title?: string): string {
  return title ? `“${title}”` : "this post";
}

/** Product-facing approval copy shared by every conversational channel. */
export function buildChannelApprovalPrompt(
  capability: string,
  snapshot?: Record<string, unknown> | null,
): string {
  const { title, platform, mediaCount } = postTarget(snapshot);
  const post = quotedPost(title);
  const destination = platform ? ` to ${platform}` : "";
  const media = mediaCount ? ` with ${mediaCount} ${mediaCount === 1 ? "image" : "images"}` : "";

  switch (capability) {
    case "kasitek.core.content_post_publish":
      return `Publish ${post}${media}${destination}?`;
    case "kasitek.core.content_post_publish_batch": {
      const preflight = record(record(snapshot?.resource)?.batchPreflight);
      const targets = Array.isArray(preflight?.targets) ? preflight.targets : [];
      const destinations = targets
        .map((target) => {
          const item = record(target);
          const platform = platformLabel(item?.platform);
          const account = text(item?.accountName, 80);
          return platform ? `${platform}${account ? ` (${account})` : ""}` : undefined;
        })
        .filter((value): value is string => Boolean(value));
      return destinations.length
        ? `Publish ${post}${media} to ${destinations.join(", ")}?`
        : `Publish ${post}${media} to all configured destinations?`;
    }
    case "kasitek.core.content_post_publish_batch_retry": {
      const resource = record(snapshot?.resource);
      const targets = Array.isArray(resource?.targets) ? resource.targets : [];
      const failed = targets
        .map((target) => {
          const item = record(target);
          const platform = platformLabel(item?.platform);
          const account = text(item?.accountName, 80);
          const state = text(item?.state, 40)?.toUpperCase();
          return state === "FAILED" && platform ? `${platform}${account ? ` (${account})` : ""}` : undefined;
        })
        .filter((value): value is string => Boolean(value));
      return failed.length
        ? `Retry failed destinations for this post: ${failed.join(", ")}?`
        : "Retry the confirmed failed destinations for this post?";
    }
    case "kasitek.core.content_post_schedule":
      return `Schedule ${post}${destination}?`;
    case "kasitek.core.content_post_unschedule":
      return `Remove the schedule for ${post}?`;
    case "kasitek.core.content_post_delete":
      return `Delete ${post}?`;
    case "kasitek.core.content_post_delete_published":
      return platform ? `Delete ${post} from ${platform}?` : `Delete ${post} from its connected social platform?`;
    case "kasitek.core.channel_deliver":
      return "Send this message?";
    case "kasitek.core.contact_update":
      return "Update this contact?";
    case "kasitek.core.inbox_conversation_mark_read":
      return "Mark this conversation as read?";
    case "kasitek.core.booking_create":
      return "Create this booking?";
    case "kasitek.core.booking_update":
      return "Update this booking?";
    case "kasitek.core.booking_cancel":
      return "Cancel this booking?";
    case "kasitek.core.campaign_launch":
      return "Launch this campaign?";
    case "kasitek.core.campaign_pause":
      return "Pause this campaign?";
    case "kasitek.core.campaign_resume":
      return "Resume this campaign?";
    case "kasitek.core.campaign_cancel":
      return "Cancel this campaign?";
    case "kasitek.core.campaign_delete":
      return "Delete this campaign?";
    default:
      return "Approve this action?";
  }
}
