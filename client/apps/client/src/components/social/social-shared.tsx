"use client";

import {
  AlertTriangle,
  AtSign,
  CalendarRange,
  CheckCircle2,
  Clock3,
  Facebook,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Instagram,
  Layers3,
  Linkedin,
  MessageCircleMore,
  Send,
  Sparkles,
  X,
  type LucideIcon,
} from "lucide-react";

export type SocialPlatform =
  | "FACEBOOK"
  | "INSTAGRAM"
  | "THREADS"
  | "LINKEDIN"
  | "X"
  | "WHATSAPP_STATUS";

export type SocialChannelStatus = "CONNECTED" | "DISCONNECTED" | "NEEDS_REAUTH";
export type SocialPostStatus = "DRAFT" | "SCHEDULED" | "PROCESSING" | "PUBLISHED" | "FAILED";
export type SocialPublishJobStatus =
  | "PENDING"
  | "QUEUED"
  | "PROCESSING"
  | "PUBLISHED"
  | "FAILED"
  | "CANCELED";
export type SocialVariantStatus = "DRAFT" | "APPROVED" | "NEEDS_EDITS";

export type PlatformCapabilities = {
  canPublish: boolean;
  supportsManualPublish: boolean;
  supportsMediaUpload: boolean;
  supportsComments: boolean;
  supportsDMs: boolean;
  supportsAnalytics: boolean;
  supportsInbox: boolean;
  supportsVariants: boolean;
};

export type SocialChannelConnection = {
  id: string;
  userId: string;
  platform: SocialPlatform;
  status: SocialChannelStatus;
  displayName: string;
  handle: string | null;
  externalAccountId: string | null;
  metadata: Record<string, unknown> | null;
  lastSyncedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SocialPublishJob = {
  id: string;
  userId: string;
  postId: string;
  variantId: string | null;
  channelConnectionId: string | null;
  platform: SocialPlatform;
  status: SocialPublishJobStatus;
  scheduledFor: string | null;
  publishedAt: string | null;
  externalPostId: string | null;
  errorMessage: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

export type SocialPostVariant = {
  id: string;
  postId: string;
  platform: SocialPlatform;
  content: string;
  status: SocialVariantStatus;
  aiGenerated: boolean;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
};

export type SocialPost = {
  id: string;
  userId: string;
  primaryChannelId: string | null;
  title: string | null;
  prompt: string | null;
  content: string;
  channels: SocialPlatform[];
  status: SocialPostStatus;
  scheduledFor: string | null;
  publishedAt: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  primaryChannel?: SocialChannelConnection | null;
  variants?: SocialPostVariant[];
  publishJobs?: SocialPublishJob[];
};

export const SOCIAL_PLATFORM_ORDER: SocialPlatform[] = [
  "FACEBOOK",
  "INSTAGRAM",
  "THREADS",
  "LINKEDIN",
  "X",
  "WHATSAPP_STATUS",
];

const PLATFORM_CAPABILITIES: Record<SocialPlatform, PlatformCapabilities> = {
  FACEBOOK: {
    canPublish: true,
    supportsManualPublish: true,
    supportsMediaUpload: true,
    supportsComments: true,
    supportsDMs: true,
    supportsAnalytics: true,
    supportsInbox: true,
    supportsVariants: true,
  },
  INSTAGRAM: {
    canPublish: true,
    supportsManualPublish: false,
    supportsMediaUpload: true,
    supportsComments: true,
    supportsDMs: true,
    supportsAnalytics: true,
    supportsInbox: true,
    supportsVariants: true,
  },
  THREADS: {
    canPublish: true,
    supportsManualPublish: false,
    supportsMediaUpload: false,
    supportsComments: false,
    supportsDMs: false,
    supportsAnalytics: false,
    supportsInbox: false,
    supportsVariants: true,
  },
  LINKEDIN: {
    canPublish: true,
    supportsManualPublish: true,
    supportsMediaUpload: true,
    supportsComments: false,
    supportsDMs: false,
    supportsAnalytics: true,
    supportsInbox: false,
    supportsVariants: true,
  },
  X: {
    canPublish: true,
    supportsManualPublish: true,
    supportsMediaUpload: true,
    supportsComments: true,
    supportsDMs: false,
    supportsAnalytics: true,
    supportsInbox: false,
    supportsVariants: true,
  },
  WHATSAPP_STATUS: {
    canPublish: true,
    supportsManualPublish: false,
    supportsMediaUpload: true,
    supportsComments: false,
    supportsDMs: false,
    supportsAnalytics: false,
    supportsInbox: false,
    supportsVariants: false,
  },
};

export const SOCIAL_POST_STATUSES: SocialPostStatus[] = [
  "DRAFT",
  "SCHEDULED",
  "PROCESSING",
  "PUBLISHED",
  "FAILED",
];

export function getPlatformLabel(platform: SocialPlatform) {
  if (platform === "FACEBOOK") return "Facebook";
  if (platform === "INSTAGRAM") return "Instagram";
  if (platform === "THREADS") return "Threads";
  if (platform === "LINKEDIN") return "LinkedIn";
  if (platform === "X") return "X";
  return "WhatsApp Status";
}

export function getPlatformDescription(platform: SocialPlatform) {
  if (platform === "FACEBOOK") return "Community updates, offers, and local reach.";
  if (platform === "INSTAGRAM") return "Visual storytelling, reels, and product highlights.";
  if (platform === "THREADS") return "Conversation-led updates, perspective posts, and brand voice.";
  if (platform === "LINKEDIN") return "Professional updates and authority content.";
  if (platform === "X") return "Fast-moving commentary, launches, and live updates.";
  return "Short-form reminders and high-visibility status content.";
}

export function getPlatformIcon(platform: SocialPlatform): LucideIcon {
  if (platform === "FACEBOOK") return Facebook;
  if (platform === "INSTAGRAM") return Instagram;
  if (platform === "THREADS") return AtSign;
  if (platform === "LINKEDIN") return Linkedin;
  if (platform === "X") return X;
  return MessageCircleMore;
}

export function getPlatformTone(platform: SocialPlatform) {
  if (platform === "FACEBOOK" || platform === "LINKEDIN") return "border-status-info/30 bg-status-info-soft text-status-info";
  if (platform === "INSTAGRAM" || platform === "THREADS" || platform === "X") return "border-border bg-secondary text-muted-foreground";
  return "border-status-success/30 bg-status-success-soft text-status-success";
}

export function getPlatformCapabilities(platform: SocialPlatform): PlatformCapabilities {
  return PLATFORM_CAPABILITIES[platform];
}

export function getChannelCapabilities(channel: SocialChannelConnection): PlatformCapabilities {
  const metadata = channel.metadata;
  const raw = metadata && typeof metadata === "object" ? metadata.capabilities : null;
  if (raw && typeof raw === "object") {
    return {
      ...PLATFORM_CAPABILITIES[channel.platform],
      ...(raw as Partial<PlatformCapabilities>),
    };
  }
  return PLATFORM_CAPABILITIES[channel.platform];
}

export function getChannelStatusMeta(status: SocialChannelStatus) {
  if (status === "CONNECTED") {
    return {
      label: "Connected",
      className: "border-status-success/30 bg-status-success-soft text-status-success",
      actionLabel: "Reconnect",
    };
  }

  if (status === "NEEDS_REAUTH") {
    return {
      label: "Needs Reauth",
      className: "border-status-attention/30 bg-status-attention-soft text-status-attention",
      actionLabel: "Reconnect",
    };
  }

  return {
    label: "Disconnected",
    className: "border-border bg-background text-muted-foreground",
    actionLabel: "Connect",
  };
}

export function getPostStatusMeta(status: SocialPostStatus) {
  if (status === "DRAFT") {
    return {
      label: "Draft",
      className: "border-border bg-background text-muted-foreground",
      icon: FileText,
    };
  }

  if (status === "SCHEDULED") {
    return {
      label: "Scheduled",
      className: "border-primary/30 bg-primary/10 text-primary",
      icon: CalendarRange,
    };
  }

  if (status === "PROCESSING") {
    return {
      label: "Processing",
      className: "border-status-info/30 bg-status-info-soft text-status-info",
      icon: Sparkles,
    };
  }

  if (status === "PUBLISHED") {
    return {
      label: "Published",
      className: "border-status-success/30 bg-status-success-soft text-status-success",
      icon: Send,
    };
  }

  return {
    label: "Failed",
    className: "border-destructive/30 bg-status-danger-soft text-destructive",
    icon: Clock3,
  };
}

export function getPublishJobStatusMeta(status: SocialPublishJobStatus) {
  if (status === "PENDING") {
    return {
      label: "Pending",
      className: "border-border bg-background text-muted-foreground",
      icon: Clock3,
    };
  }

  if (status === "QUEUED") {
    return {
      label: "Queued",
      className: "border-primary/30 bg-primary/10 text-primary",
      icon: CalendarRange,
    };
  }

  if (status === "PROCESSING") {
    return {
      label: "Processing",
      className: "border-status-info/30 bg-status-info-soft text-status-info",
      icon: Sparkles,
    };
  }

  if (status === "PUBLISHED") {
    return {
      label: "Published",
      className: "border-status-success/30 bg-status-success-soft text-status-success",
      icon: Send,
    };
  }

  if (status === "FAILED") {
    return {
      label: "Failed",
      className: "border-destructive/30 bg-status-danger-soft text-destructive",
      icon: AlertTriangle,
    };
  }

  return {
    label: "Canceled",
    className: "border-border bg-background text-muted-foreground",
    icon: X,
  };
}

export function formatDateTime(value?: string | null) {
  if (!value) return "Not scheduled";

  const date = new Date(value);
  return date.toLocaleString("en-ZA", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDateInputValue(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const hour = `${date.getHours()}`.padStart(2, "0");
  const minute = `${date.getMinutes()}`.padStart(2, "0");
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

export function trimTrailingHandle(value: string) {
  return value.replace(/^@+/, "").trim();
}

export function groupPostsByStatus(posts: SocialPost[]) {
  return {
    ideas: posts.filter((post) => !post.content.trim() && post.prompt?.trim()),
    drafting: posts.filter((post) => post.status === "DRAFT"),
    approved: posts.filter((post) => post.status === "SCHEDULED"),
    published: posts.filter((post) => post.status === "PUBLISHED"),
  };
}

export function getScheduledPosts(posts: SocialPost[]) {
  return posts
    .filter((post) => post.scheduledFor)
    .sort((left, right) => {
      const leftTime = new Date(left.scheduledFor as string).valueOf();
      const rightTime = new Date(right.scheduledFor as string).valueOf();
      return leftTime - rightTime;
    });
}

export function getAnalyticsSnapshot(posts: SocialPost[], channels: SocialChannelConnection[]) {
  const published = posts.filter((post) => post.status === "PUBLISHED");
  const scheduled = posts.filter((post) => post.status === "SCHEDULED");
  const topPlatform = [...channels]
    .sort((left, right) => {
      const leftCount = posts.filter((post) => post.channels.includes(left.platform)).length;
      const rightCount = posts.filter((post) => post.channels.includes(right.platform)).length;
      return rightCount - leftCount;
    })[0];

  return {
    publishedCount: published.length,
    scheduledCount: scheduled.length,
    activeChannels: channels.filter((channel) => channel.status === "CONNECTED").length,
    topPlatform: topPlatform ? getPlatformLabel(topPlatform.platform) : "None yet",
  };
}

export function getReplyPreviewIcon(kind: "image" | "video" | "audio" | "document" | "sticker") {
  if (kind === "image" || kind === "sticker") return FileImage;
  if (kind === "video") return FileVideo;
  if (kind === "audio") return FileAudio;
  return FileText;
}

export const postStatusSummaryCards = [
  {
    key: "scheduled",
    label: "Scheduled",
    icon: CalendarRange,
  },
  {
    key: "published",
    label: "Published",
    icon: Send,
  },
  {
    key: "connected",
    label: "Connected",
    icon: CheckCircle2,
  },
  {
    key: "coverage",
    label: "Coverage",
    icon: Layers3,
  },
] as const;
