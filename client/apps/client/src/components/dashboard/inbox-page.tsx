"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import Picker from "@emoji-mart/react";
import emojiData from "@emoji-mart/data";
import type { EmojiMartData } from "@emoji-mart/data";
import { motion } from "framer-motion";
import {
  ArrowLeft,
  Archive,
  Check,
  ChevronDown,
  Clock,
  Copy,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Filter,
  Mail,
  MessageCircle,
  MoreHorizontal,
  MoreVertical,
  Paperclip,
  Phone,
  RotateCcw,
  Search,
  Send,
  Smile,
  Star,
  Tag,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { getPlatformBrandColor, getPlatformBrandIcon } from "@/lib/platform-icons";
import { apiUrl } from "@/lib/server-api";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  PageHeader,
  PageHeaderActions,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@/components/ui/page-header";
import { useConfirmationDialog } from "@/components/ui/confirmation-provider";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { resolveTheme, useAppearance } from "@/lib/appearance";

function inboxPlatformKey(channel: string) {
  return channel.toLowerCase() === "facebook" ? "MESSENGER" : channel.toUpperCase();
}

function inboxChannelIcon(channel: string) {
  return getPlatformBrandIcon(inboxPlatformKey(channel)) ?? MessageCircle;
}

function inboxChannelIconClass(channel: string) {
  return getPlatformBrandColor(inboxPlatformKey(channel));
}
import { useWhatsappRealtimeSubscription } from "@/components/dashboard/whatsapp-realtime-provider";

function markConversationRead(conversationId: string) {
  return fetch(apiUrl(`/api/inbox/${conversationId}/read`), {
    method: "POST",
    credentials: "include",
  });
}

type InboxConversation = {
  id: string;
  name: string;
  handle: string;
  lastMessage: string;
  time: string;
  unread: boolean;
  starred: boolean;
  channel: "whatsapp" | "facebook" | "instagram" | "email";
  connectionId: string | null;
  connectionLabel: string;
  emailSubject?: string;
  emailFrom?: string | null;
  avatar: string;
  status: "online" | "offline";
  tags: string[];
};

type InboxConversationPayload = {
  id: string;
  channel: "whatsapp" | "facebook" | "instagram" | "email";
  customerName: string | null;
  phone: string;
  lastMessage: string;
  lastMessageAt: string;
  unreadCount: number;
  starred: boolean;
  connectionId: string | null;
  connectionLabel: string | null;
  subject?: string | null;
  from?: string | null;
};

function mapInboxConversation(conversation: InboxConversationPayload): InboxConversation {
  const name = conversation.customerName || conversation.phone || "Unknown contact";

  return {
    id: conversation.id,
    name,
    handle: conversation.phone,
    lastMessage: conversation.lastMessage || "No messages yet",
    time: conversation.lastMessageAt,
    unread: conversation.unreadCount > 0,
    starred: conversation.starred,
    channel: conversation.channel,
    connectionId: conversation.connectionId,
    connectionLabel:
      conversation.connectionLabel || conversation.phone || "Unknown number",
    emailSubject: conversation.subject || undefined,
    emailFrom: conversation.from || null,
    avatar: buildConversationAvatar(name),
    status: "offline",
    tags: [],
  };
}

type WhatsappConnectionView = {
  id: string;
  phoneNumberId: string;
  phoneDisplayNumber: string | null;
  wabaId: string;
  currentQualityRating: string;
  dailyLimitEstimate: number | null;
  verified: boolean;
  createdAt: string;
};

type ChannelConnectionView = {
  id: string;
  label: string;
  handle: string | null;
};

type MetaConnections = {
  instagram: ChannelConnectionView[];
  facebook: ChannelConnectionView[];
};

type ChannelCounts = {
  whatsapp: {
    connected: boolean;
    connectionCount: number;
    unreadCount: number;
    conversationCount: number;
  };
  instagram: {
    connected: boolean;
    connectionCount: number;
    unreadCount: number;
    conversationCount: number;
  };
  facebook: {
    connected: boolean;
    connectionCount: number;
    unreadCount: number;
    conversationCount: number;
  };
  email: {
    connected: boolean;
    connectionCount: number;
    unreadCount: number;
    conversationCount: number;
  };
};

type EmailConnectionView = {
  id: string;
  provider: "GOOGLE" | "MICROSOFT" | string;
  emailAddress: string;
  displayName: string;
  status: string;
  healthStatus: string;
  syncStatus: string;
  inboxStatus: string;
  inboundStatus: string;
  outboundStatus: string;
};

function emailInboxReady(connection: EmailConnectionView) {
  return (
    connection.status === "CONNECTED" &&
    connection.inboxStatus === "ACTIVE" &&
    connection.inboundStatus === "READY"
  );
}

function emailConnectionStatus(connection: EmailConnectionView) {
  if (connection.status !== "CONNECTED") return "Disconnected";
  if (connection.healthStatus !== "HEALTHY" || connection.inboundStatus === "RETRYABLE_FAILURE") {
    return "Needs attention";
  }
  if (connection.inboundStatus === "SYNCING" || connection.inboundStatus === "PENDING") {
    return "Syncing";
  }
  if (emailInboxReady(connection)) return "Ready";
  return "Setting up";
}

function logCallMediaEvent(callId: string, event: string, details?: Record<string, unknown>) {
  console.info("[call-media]", {
    callId,
    event,
    ...(details || {}),
  });
}

type ConversationMessage = {
  id: string;
  sender: "customer" | "bot";
  content: string;
  text: string;
  time: string;
  timestamp?: string;
  whatsappMessageId?: string | null;
  providerMessageId?: string | null;
  status?: "pending" | "failed" | "READ" | "DELIVERED" | "SENT" | "BLOCKED";
  canReply?: boolean;
  canReact?: boolean;
  errorMessage?: string | null;
  contentType?: "TEXT" | "MEDIA" | string;
  editedAt?: string | null;
  deletedAt?: string | null;
  attachments?: MessageAttachment[];
  reference?: MessageReference | null;
  reactions?: MessageReaction[];
};

type ConversationCapabilities = {
  version: number;
  text: boolean;
  reply: boolean;
  reaction: boolean;
  attachments: {
    image: boolean;
    video: boolean;
    audio: boolean;
    document: boolean;
    sticker: boolean;
  };
  providerDelete: boolean;
  deliveryReceipts: boolean;
  readReceipts: boolean;
};

const unsupportedCapabilities: ConversationCapabilities = {
  version: 1,
  text: false,
  reply: false,
  reaction: false,
  attachments: { image: false, video: false, audio: false, document: false, sticker: false },
  providerDelete: false,
  deliveryReceipts: false,
  readReceipts: false,
};

type MessageAttachmentKind = "image" | "video" | "audio" | "document" | "sticker" | "file";

type MessageAttachment = {
  id: string;
  kind: MessageAttachmentKind;
  mimeType?: string | null;
  fileName?: string | null;
  byteSize?: number | null;
  providerMediaId?: string | null;
  downloadStatus?: string | null;
  scanStatus?: string | null;
  metadata?: Record<string, unknown> | null;
};

type MessageReference = {
  messageId?: string | null;
  providerMessageId?: string | null;
  kind?: string;
  previewText?: string | null;
  previewKind?: MessageAttachmentKind | null;
};

type MessageReaction = {
  id: string;
  actorIdentifier: string;
  emoji?: string | null;
  active?: boolean;
  occurredAt?: string;
};

const legacyAttachmentPlaceholders = new Set(["[attachment]", "attachment", "sticker"]);

const fluentEmojiAssetVersion = "1.1.0";
const fluentEmojiAssetBaseUrl = `https://unpkg.com/@lobehub/fluent-emoji-3d@${fluentEmojiAssetVersion}/assets`;

const fluentEmojiSequences = new Set(
  Object.values((emojiData as EmojiMartData).emojis).flatMap((emoji) =>
    emoji.skins.map((skin) => skin.native),
  ),
);

type GraphemeSegmenter = {
  segment(input: string): Iterable<{ segment: string }>;
};

type IntlWithSegmenter = typeof Intl & {
  Segmenter?: new (
    locales?: string | string[],
    options?: { granularity: "grapheme" },
  ) => GraphemeSegmenter;
};

function createGraphemeSegmenter() {
  if (typeof Intl === "undefined") return null;

  const Segmenter = (Intl as IntlWithSegmenter).Segmenter;
  return Segmenter ? new Segmenter(undefined, { granularity: "grapheme" }) : null;
}

const graphemeSegmenter = createGraphemeSegmenter();

function getEmojiPresentationSequence(segment: string) {
  if (fluentEmojiSequences.has(segment)) return segment;

  // U+2764 (❤), for example, is text-presenting in some Linux font stacks.
  // Prefer the equivalent emoji-presentation sequence only when Emoji Mart
  // recognises it, so ordinary text and unsupported characters stay untouched.
  const emojiPresentation = segment.includes("\uFE0E")
    ? segment.replace(/\uFE0E/g, "\uFE0F")
    : `${segment}\uFE0F`;

  return fluentEmojiSequences.has(emojiPresentation) ? emojiPresentation : null;
}

function getFluentEmojiAssetUrl(emoji: string) {
  const codepoints = Array.from(emoji)
    .map((character) => character.codePointAt(0)?.toString(16))
    .filter((codepoint): codepoint is string => Boolean(codepoint))
    .join("-");

  return `${fluentEmojiAssetBaseUrl}/${codepoints}.webp`;
}

function FluentEmojiGlyph({ emoji }: { emoji: string }) {
  const [assetFailed, setAssetFailed] = useState(false);

  if (assetFailed) {
    return <>{emoji}</>;
  }

  return (
    // Fluent Emoji is Microsoft's MIT-licensed emoji artwork. Pinning the
    // version makes each exact Unicode sequence stable and long-cacheable.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={getFluentEmojiAssetUrl(emoji)}
      alt={emoji}
      title={emoji}
      className="inline-block h-[1.2em] w-[1.2em] align-[-0.22em] object-contain"
      onError={() => setAssetFailed(true)}
    />
  );
}

function EmojiText({ value }: { value: string }) {
  const segments = graphemeSegmenter
    ? Array.from(graphemeSegmenter.segment(value), ({ segment }) => segment)
    : Array.from(value);

  return (
    <>
      {segments.map((segment, index) => {
        const emoji = getEmojiPresentationSequence(segment);
        return emoji ? (
          <FluentEmojiGlyph key={`${index}-${emoji}`} emoji={emoji} />
        ) : (
          <span key={`${index}-${segment}`}>{segment}</span>
        );
      })}
    </>
  );
}

function isStickerAttachment(attachment: MessageAttachment) {
  if (attachment.kind === "sticker" || attachment.providerMediaId?.startsWith("sticker_")) {
    return true;
  }

  const metadata = attachment.metadata;
  if (!metadata || typeof metadata !== "object") return false;

  const sticker = metadata.sticker;
  if (sticker && typeof sticker === "object") return true;

  const providerPayload = metadata.providerPayload;
  if (!providerPayload || typeof providerPayload !== "object") return false;
  const payload = providerPayload as Record<string, unknown>;

  return (
    payload.render_as_sticker === true ||
    payload.sticker_id != null ||
    (
      typeof payload.id === "string" &&
      payload.id.startsWith("sticker_")
    )
  );
}

function getMeaningfulMessageContent(message: Pick<ConversationMessage, "content" | "attachments">) {
  const content = message.content?.trim() || "";
  if (
    message.attachments?.length &&
    legacyAttachmentPlaceholders.has(content.toLowerCase())
  ) {
    return "";
  }
  return content;
}

function isStickerOnlyMessage(message: ConversationMessage) {
  return Boolean(message.attachments?.length) &&
    message.attachments!.every(isStickerAttachment) &&
    !getMeaningfulMessageContent(message) &&
    !message.reference;
}

function getMessageAttachment(message: ConversationMessage) {
  return message.attachments?.[0] || null;
}

function getMessageDisplayText(message: Pick<ConversationMessage, "content" | "deletedAt" | "attachments">) {
  if (message.deletedAt) return "Message deleted";
  const content = getMeaningfulMessageContent(message);
  if (content) return content;

  const attachment = message.attachments?.[0];
  if (!attachment) return "No message content";
  return attachment.fileName || getMediaLabel(
    isStickerAttachment(attachment) ? "sticker" : attachment.kind,
  );
}

function getMessagePreview(message: Pick<ConversationMessage, "content" | "deletedAt" | "attachments">) {
  return getMessageDisplayText(message).replace(/\s+/g, " ").trim().slice(0, 120);
}

type WhatsappCallSession = {
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

type WhatsappCallSignalEvent = {
  id: string;
  eventType: string;
  createdAt: string;
  payload?: {
    kind?: string;
    source?: string;
    payload?: unknown;
  } | null;
};

type CallMediaSession = {
  provider?: string;
  callId: string;
  waCallId?: string | null;
  conversationId?: string | null;
  roomName?: string;
  agentRole?: string;
  canAccept?: boolean;
  canEnd?: boolean;
  webrtc?: {
    sdpType: string;
    sdp: string;
  } | null;
};

type ReactionPickerState = {
  messageId: string;
  top: number;
  left: number;
};

type MediaLightboxState = {
  url: string;
  kind: MessageAttachmentKind;
  caption?: string | null;
};

function formatConversationTime(value: string) {
  const date = new Date(value);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();

  if (sameDay) {
    return date.toLocaleTimeString("en-ZA", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  return date.toLocaleDateString("en-ZA", { day: "2-digit", month: "2-digit" });
}

function buildConversationAvatar(label: string) {
  return (
    label
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() || "")
      .join("")
      .slice(0, 2) || "?"
  );
}

function upsertConversationByRecentActivity(
  current: InboxConversation[],
  nextConversation: InboxConversation,
) {
  return [nextConversation, ...current.filter((conversation) => conversation.id !== nextConversation.id)];
}

function upsertCallSession(
  current: WhatsappCallSession[],
  nextCall: WhatsappCallSession,
) {
  return [nextCall, ...current.filter((call) => call.id !== nextCall.id)];
}

function isLiveCallStatus(status: string) {
  return status === "RINGING" || status === "CONNECTING" || status === "ACTIVE";
}

function formatCallStatus(status: string) {
  return status.toLowerCase().replace(/_/g, " ");
}

function formatCallTimestamp(value?: string | null) {
  if (!value) return "Just now";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Just now";
  return date.toLocaleString("en-ZA", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function isMetaDirectWebRtcMediaSession(
  mediaSession: CallMediaSession | null | undefined,
): mediaSession is CallMediaSession & {
  webrtc: {
    sdpType: string;
    sdp: string;
  };
} {
  return Boolean(
    mediaSession?.provider === "meta-direct-webrtc" &&
      mediaSession.webrtc?.sdp &&
      mediaSession.webrtc?.sdpType,
  );
}

function formatCallDuration(startedAt?: string | null, endedAt?: string | null) {
  if (!startedAt || !endedAt) return null;
  const started = new Date(startedAt).getTime();
  const ended = new Date(endedAt).getTime();
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended <= started) return null;
  const seconds = Math.round((ended - started) / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  if (minutes <= 0) return `${remainder}s`;
  return `${minutes}m ${remainder}s`;
}

async function requestPreferredAudioStream() {
  const audioConstraints: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };

  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
      video: false,
    });
  } catch (error) {
    const mediaError = error instanceof DOMException ? error : null;
    const recoverable =
      mediaError?.name === "NotFoundError" ||
      mediaError?.name === "DevicesNotFoundError" ||
      mediaError?.name === "OverconstrainedError";

    if (!recoverable || !navigator.mediaDevices.enumerateDevices) {
      throw error;
    }

    const devices = await navigator.mediaDevices.enumerateDevices();
    const firstAudioInput = devices.find((device) => device.kind === "audioinput" && device.deviceId);
    if (!firstAudioInput) {
      throw new Error("No microphone is available on this device");
    }

    return navigator.mediaDevices.getUserMedia({
      audio: {
        ...audioConstraints,
        deviceId: { exact: firstAudioInput.deviceId },
      },
      video: false,
    });
  }
}

function InboxMessagesSkeleton() {
  return (
    <div className="space-y-4 py-2">
      {[
        { align: "start", width: "w-52" },
        { align: "end", width: "w-40" },
        { align: "start", width: "w-64" },
        { align: "end", width: "w-56" },
      ].map((item, index) => (
        <div
          key={index}
          className={cn("flex", item.align === "end" ? "justify-end" : "justify-start")}
        >
          <div
            className={cn(
              "max-w-[85%] space-y-2 rounded-2xl p-3 sm:max-w-[70%]",
              item.align === "end"
                ? "border border-primary/15 bg-primary/5"
                : "border border-border/60 bg-secondary/40",
              item.width,
            )}
          >
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-5/6" />
            <div className="flex justify-end">
              <Skeleton className="h-3 w-12" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

export default function InboxPageClient({
  whatsappConnections,
  conversations,
  channelCounts,
  metaConnections,
  emailConnections,
}: {
  whatsappConnections: WhatsappConnectionView[];
  conversations: InboxConversation[];
  channelCounts: ChannelCounts;
  metaConnections: MetaConnections;
  emailConnections: EmailConnectionView[];
}) {
  const searchParams = useSearchParams();
  const { confirm } = useConfirmationDialog();
  const appearance = useAppearance();
  const emojiTheme = resolveTheme(appearance.theme);
  const [liveConversations, setLiveConversations] = useState(conversations);
  const [liveEmailConnections, setLiveEmailConnections] = useState(emailConnections);
  const [selectedChannel, setSelectedChannel] = useState<
    "all" | "whatsapp" | "email" | "sms" | "instagram" | "facebook"
  >("all");
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [messagesByConversationId, setMessagesByConversationId] = useState<
    Record<string, ConversationMessage[]>
  >({});
  const [capabilitiesByConversationId, setCapabilitiesByConversationId] = useState<
    Record<string, ConversationCapabilities>
  >({});
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [composerLoading, setComposerLoading] = useState(false);
  const [retryingMessageId, setRetryingMessageId] = useState<string | null>(null);
  const [composerError, setComposerError] = useState("");
  const [filter, setFilter] = useState("all");
  const [messageInput, setMessageInput] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [replyDraft, setReplyDraft] = useState<{ messageId: string; text: string } | null>(null);
  const [openActionsMessageId, setOpenActionsMessageId] = useState<string | null>(null);
  const [reactionPicker, setReactionPicker] = useState<ReactionPickerState | null>(null);
  const [selfReactionOverridesByMessageId, setSelfReactionOverridesByMessageId] = useState<Record<string, string>>({});
  const [showChannelPanel, setShowChannelPanel] = useState(false);
  const [showEmailConnectDialog, setShowEmailConnectDialog] = useState(false);
  const [emailConnectProvider, setEmailConnectProvider] = useState<"google" | "microsoft" | null>(null);
  const [emailConnectError, setEmailConnectError] = useState<string | null>(null);
  const [mobileConversationOpen, setMobileConversationOpen] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [lightbox, setLightbox] = useState<MediaLightboxState | null>(null);
  const [copiedConversationId, setCopiedConversationId] = useState<string | null>(null);
  const [callSessions, setCallSessions] = useState<WhatsappCallSession[]>([]);
  const [callSignalsByCallId, setCallSignalsByCallId] = useState<Record<string, WhatsappCallSignalEvent[]>>({});
  const [callMediaSessionsByCallId, setCallMediaSessionsByCallId] = useState<Record<string, CallMediaSession>>({});
  const [callsLoading, setCallsLoading] = useState(false);
  const [callActionLoading, setCallActionLoading] = useState<string | null>(null);
  const [callError, setCallError] = useState<string>("");
  const [callMediaLoading, setCallMediaLoading] = useState<string | null>(null);
  const [callMediaState, setCallMediaState] = useState<"idle" | "requesting" | "connecting" | "connected" | "failed">("idle");
  const [callMediaError, setCallMediaError] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const emojiPickerRef = useRef<HTMLDivElement | null>(null);
  const reactionPickerRef = useRef<HTMLDivElement | null>(null);
  const reactionTriggerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const copyFeedbackTimerRef = useRef<number | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const activeWebRtcCallIdRef = useRef<string | null>(null);

  useEffect(() => {
    setLiveConversations(conversations);
  }, [conversations]);

  useEffect(() => {
    setLiveEmailConnections(emailConnections);
  }, [emailConnections]);

  useEffect(() => {
    let cancelled = false;

    const refreshConversations = async () => {
      if (document.visibilityState === "hidden") return;

      try {
        const [conversationResponse, emailResponse] = await Promise.all([
          fetch(apiUrl("/api/inbox/conversations"), {
            cache: "no-store",
            credentials: "include",
          }),
          fetch(apiUrl("/api/email/connections"), {
            cache: "no-store",
            credentials: "include",
          }),
        ]);
        if (cancelled) return;

        if (conversationResponse.ok) {
          const payload = (await conversationResponse.json()) as {
            conversations?: InboxConversationPayload[];
          };
          if (Array.isArray(payload.conversations)) {
            setLiveConversations(payload.conversations.map(mapInboxConversation));
          }
        }
        if (emailResponse.ok) {
          const payload = (await emailResponse.json()) as {
            connections?: EmailConnectionView[];
          };
          if (Array.isArray(payload.connections)) setLiveEmailConnections(payload.connections);
        }
      } catch {
        // Keep the current Inbox state if a foreground refresh fails.
      }
    };

    const onVisibleOrFocused = () => {
      if (document.visibilityState === "visible") {
        void refreshConversations();
      }
    };

    window.addEventListener("focus", onVisibleOrFocused);
    document.addEventListener("visibilitychange", onVisibleOrFocused);
    const refreshTimer = window.setInterval(() => {
      void refreshConversations();
    }, 30_000);

    return () => {
      cancelled = true;
      window.clearInterval(refreshTimer);
      window.removeEventListener("focus", onVisibleOrFocused);
      document.removeEventListener("visibilitychange", onVisibleOrFocused);
    };
  }, []);

  const whatsappUnreadCount = useMemo(
    () =>
      liveConversations.filter(
        (conversation) => conversation.channel === "whatsapp" && conversation.unread,
      ).length,
    [liveConversations],
  );

  const startEmailConnection = async (provider: "google" | "microsoft") => {
    setEmailConnectProvider(provider);
    setEmailConnectError(null);
    try {
      const response = await fetch(apiUrl(`/api/email/oauth/${provider}/start?returnTo=/inbox`), {
        credentials: "include",
        cache: "no-store",
      });
      const payload = (await response.json().catch(() => ({}))) as { authorizationUrl?: string; error?: string };
      if (!response.ok || !payload.authorizationUrl) {
        throw new Error(payload.error || `Unable to connect ${provider === "google" ? "Google" : "Microsoft"}`);
      }
      window.location.assign(payload.authorizationUrl);
    } catch (error) {
      setEmailConnectError(error instanceof Error ? error.message : "Unable to start email connection");
      setEmailConnectProvider(null);
    }
  };

  const emailConnectedConnections = liveEmailConnections.filter(
    (connection) => connection.status === "CONNECTED" && connection.inboxStatus === "ACTIVE",
  );
  const emailReadyConnections = liveEmailConnections.filter(emailInboxReady);
  const emailConnectionFilters = useMemo(
    () => [
      { id: null as string | null, label: "All mailboxes", status: "", conversationCount: liveConversations.filter((conversation) => conversation.channel === "email").length, unreadCount: liveConversations.filter((conversation) => conversation.channel === "email" && conversation.unread).length },
      ...liveEmailConnections.map((connection) => ({
        id: connection.id,
        label: `${connection.provider === "MICROSOFT" ? "Microsoft" : "Google"} · ${connection.emailAddress}`,
        status: emailConnectionStatus(connection),
        conversationCount: liveConversations.filter((conversation) => conversation.channel === "email" && conversation.connectionId === connection.id).length,
        unreadCount: liveConversations.filter((conversation) => conversation.channel === "email" && conversation.connectionId === connection.id && conversation.unread).length,
      })),
    ],
    [liveEmailConnections, liveConversations],
  );

  const channels = useMemo(
    () => [
      {
        id: "all" as const,
        name: "All Channels",
        icon: MessageCircle,
        color: "text-foreground",
        bgColor: "bg-foreground/10",
        count: liveConversations.length,
        unreadCount: liveConversations.filter((conversation) => conversation.unread).length,
        disabled: false,
        connected: true,
      },
      {
        id: "whatsapp" as const,
        name: "WhatsApp",
        icon: inboxChannelIcon("whatsapp"),
        color: inboxChannelIconClass("whatsapp"),
        bgColor: "bg-status-success-soft",
        count: liveConversations.filter((conversation) => conversation.channel === "whatsapp").length,
        unreadCount: whatsappUnreadCount,
        disabled: false,
        connected: channelCounts.whatsapp.connected,
      },
      {
        id: "email" as const,
        name: "Email",
        icon: Mail,
        color: "text-blue-400",
        bgColor: "bg-blue-500/10",
        count: liveConversations.filter((conversation) => conversation.channel === "email").length,
        unreadCount: liveConversations.filter((conversation) => conversation.channel === "email" && conversation.unread).length,
        disabled: false,
        connected: emailConnectedConnections.length > 0,
      },
      {
        id: "sms" as const,
        name: "SMS",
        icon: MessageCircle,
        color: "text-muted-foreground",
        bgColor: "bg-secondary",
        count: 0,
        unreadCount: 0,
        disabled: true,
        connected: false,
      },
      {
        id: "instagram" as const,
        name: "Instagram",
        icon: inboxChannelIcon("instagram"),
        color: inboxChannelIconClass("instagram"),
        bgColor: "bg-fuchsia-500/10",
        count: liveConversations.filter((conversation) => conversation.channel === "instagram").length,
        unreadCount: liveConversations.filter(
          (conversation) => conversation.channel === "instagram" && conversation.unread,
        ).length,
        disabled:
          !channelCounts.instagram.connected &&
          !liveConversations.some((conversation) => conversation.channel === "instagram"),
        connected: channelCounts.instagram.connected,
      },
      {
        id: "facebook" as const,
        name: "Messenger",
        icon: inboxChannelIcon("facebook"),
        color: inboxChannelIconClass("facebook"),
        bgColor: "bg-blue-500/10",
        count: liveConversations.filter((conversation) => conversation.channel === "facebook").length,
        unreadCount: liveConversations.filter(
          (conversation) => conversation.channel === "facebook" && conversation.unread,
        ).length,
        disabled:
          !channelCounts.facebook.connected &&
          !liveConversations.some((conversation) => conversation.channel === "facebook"),
        connected: channelCounts.facebook.connected,
      },
    ],
    [channelCounts, emailConnectedConnections.length, liveConversations, whatsappUnreadCount],
  );

  const whatsappConnectionFilters = useMemo(
    () => [
      {
        id: null as string | null,
        label: "All numbers",
        conversationCount: liveConversations.filter(
          (conversation) => conversation.channel === "whatsapp",
        ).length,
        unreadCount: liveConversations.filter(
          (conversation) => conversation.channel === "whatsapp" && conversation.unread,
        ).length,
      },
      ...whatsappConnections.map((connection) => {
        const connectionConversations = liveConversations.filter(
          (conversation) =>
            conversation.channel === "whatsapp" && conversation.connectionId === connection.id,
        );

        return {
          id: connection.id,
          label: connection.phoneDisplayNumber || connection.phoneNumberId,
          conversationCount: connectionConversations.length,
          unreadCount: connectionConversations.filter((conversation) => conversation.unread).length,
        };
      }),
    ],
    [liveConversations, whatsappConnections],
  );

  const metaConnectionFilters = useMemo(() => {
    const buildFilters = (
      channel: "instagram" | "facebook",
      connections: ChannelConnectionView[],
      allLabel: string,
    ) => [
      {
        id: null as string | null,
        label: allLabel,
        handle: null as string | null,
        conversationCount: liveConversations.filter(
          (conversation) => conversation.channel === channel,
        ).length,
        unreadCount: liveConversations.filter(
          (conversation) => conversation.channel === channel && conversation.unread,
        ).length,
      },
      ...connections.map((connection) => {
        const connectionConversations = liveConversations.filter(
          (conversation) =>
            conversation.channel === channel && conversation.connectionId === connection.id,
        );

        return {
          id: connection.id,
          label: connection.label,
          handle: connection.handle,
          conversationCount: connectionConversations.length,
          unreadCount: connectionConversations.filter((conversation) => conversation.unread).length,
        };
      }),
    ];

    return {
      instagram: buildFilters(
        "instagram",
        metaConnections.instagram,
        "All Instagram accounts",
      ),
      facebook: buildFilters("facebook", metaConnections.facebook, "All Pages"),
    };
  }, [liveConversations, metaConnections]);

  const activeConnectionFilters =
    selectedChannel === "whatsapp"
      ? whatsappConnectionFilters
      : selectedChannel === "instagram"
        ? metaConnectionFilters.instagram
        : selectedChannel === "facebook"
          ? metaConnectionFilters.facebook
          : selectedChannel === "email"
            ? emailConnectionFilters
          : [];
  const selectedConnectionFilter =
    activeConnectionFilters.find((connection) => connection.id === selectedConnectionId) ??
    activeConnectionFilters[0];
  const supportsConnectionFilter =
    selectedChannel === "whatsapp" ||
    selectedChannel === "instagram" ||
    selectedChannel === "facebook" ||
    selectedChannel === "email";

  const filteredConversations = liveConversations.filter((conversation) => {
    const channelMatch = selectedChannel === "all" || conversation.channel === selectedChannel;
    const connectionMatch =
      !supportsConnectionFilter ||
      !selectedConnectionId ||
      conversation.connectionId === selectedConnectionId;
    const filterMatch =
      filter === "all" ||
      (filter === "unread" && conversation.unread) ||
      (filter === "starred" && conversation.starred);
    return channelMatch && connectionMatch && filterMatch;
  });

  const selectedChannelConversationCount =
    selectedChannel === "all"
      ? liveConversations.length
      : liveConversations.filter((conversation) => conversation.channel === selectedChannel).length;
  const selectedChannelConnected =
    selectedChannel === "all"
      ? true
      : selectedChannel === "sms"
        ? false
        : channelCounts[selectedChannel].connected;
  const emptyConversationCopy =
    selectedChannel === "instagram"
      ? {
          title: selectedConnectionId
            ? `No conversations for ${selectedConnectionFilter?.label || "this Instagram account"}`
            : "No Instagram conversations yet",
          description:
            filter === "all"
              ? "New messages will appear here after someone messages a connected Instagram account."
              : "No Instagram conversations match this filter.",
        }
      : selectedChannel === "facebook"
        ? {
            title: selectedConnectionId
              ? `No conversations for ${selectedConnectionFilter?.label || "this Page"}`
              : "No Messenger conversations yet",
            description:
              filter === "all"
                ? "New messages will appear here after someone messages a connected Facebook Page."
                : "No Messenger conversations match this filter.",
          }
      : selectedChannel === "email"
          ? {
              title: "No email conversations yet",
              description: filter === "all" ? "Connect Google or Microsoft to receive email here." : "No email conversations match this filter.",
            }
      : selectedChannel === "whatsapp"
          ? {
              title: selectedConnectionId
                ? `No conversations for ${selectedConnectionFilter?.label || "this number"}`
                : "No WhatsApp conversations yet",
              description:
                filter === "all"
                  ? "New messages will appear here after someone messages a connected number."
                  : "No WhatsApp conversations match this filter.",
            }
          : {
              title: "No conversations yet",
              description: "New customer messages will appear here.",
            };

  const selectedConversation =
    filteredConversations.find((conversation) => conversation.id === selectedConversationId) ?? null;

  useEffect(() => {
    if (selectedConversation?.channel === "whatsapp") return;
    setSelectedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [selectedConversation?.channel]);
  const preferredConversationId = searchParams.get("conversation")?.trim() || null;

  useEffect(() => {
    if (!preferredConversationId) return;
    const exists = liveConversations.some((conversation) => conversation.id === preferredConversationId);
    if (!exists || selectedConversationId === preferredConversationId) return;
    setSelectedConversationId(preferredConversationId);
    setMobileConversationOpen(true);
  }, [liveConversations, preferredConversationId, selectedConversationId]);

  useEffect(() => {
    if (
      selectedConversationId &&
      !filteredConversations.some((conversation) => conversation.id === selectedConversationId)
    ) {
      setSelectedConversationId(null);
    }
  }, [filteredConversations, selectedConversationId]);

  const currentChannel =
    channels.find((channel) => channel.id === (selectedConversation?.channel ?? selectedChannel)) ??
    channels[0];
  const ChannelIcon = currentChannel.icon;
  const selectedMessages = useMemo(
    () => (selectedConversationId ? messagesByConversationId[selectedConversationId] || [] : []),
    [messagesByConversationId, selectedConversationId],
  );
  const selectedConversationCapabilities = selectedConversationId
    ? capabilitiesByConversationId[selectedConversationId] || unsupportedCapabilities
    : unsupportedCapabilities;
  const activeCallsByConversationId = useMemo(() => {
    const next: Record<string, WhatsappCallSession> = {};
    for (const call of callSessions) {
      if (!call.conversationId || !isLiveCallStatus(call.status)) continue;
      next[call.conversationId] ||= call;
    }
    return next;
  }, [callSessions]);
  const selectedConversationCall =
    selectedConversationId ? activeCallsByConversationId[selectedConversationId] || null : null;
  const selectedCallSignals = selectedConversationCall
    ? callSignalsByCallId[selectedConversationCall.id] || []
    : [];
  const latestSelectedCallSignal = selectedCallSignals[selectedCallSignals.length - 1] || null;
  const selectedCallMediaSession = selectedConversationCall
    ? callMediaSessionsByCallId[selectedConversationCall.id] || null
    : null;
  const conversationCallHistory = useMemo(
    () =>
      selectedConversationId
        ? callSessions
            .filter((call) => call.conversationId === selectedConversationId)
            .slice(0, 5)
        : [],
    [callSessions, selectedConversationId],
  );
  const latestIncomingCall = useMemo(
    () =>
      callSessions.find(
        (call) => call.direction === "INBOUND" && isLiveCallStatus(call.status),
      ) || null,
    [callSessions],
  );
  const persistedSelfReactionsByMessageId = useMemo(() => {
    const next: Record<string, string> = {};

    for (const message of selectedMessages) {
      const reaction = message.reactions?.find((candidate) =>
        candidate.active !== false && candidate.actorIdentifier.startsWith("bot:"),
      );
      if (!reaction?.emoji) continue;
      next[message.id] = reaction.emoji.trim();
    }

    return next;
  }, [selectedMessages]);

  const reactionDisplayByMessageId = useMemo(() => {
    const next: Record<string, { emojis: string[]; total: number }> = {};
    const latestByActorTarget = new Map<string, { targetMessageId: string; emoji: string }>();

    for (const message of selectedMessages) {
      for (const reaction of message.reactions || []) {
        if (reaction.active === false || !reaction.emoji?.trim()) continue;
        latestByActorTarget.set(`${reaction.actorIdentifier}:${message.id}`, {
          targetMessageId: message.id,
          emoji: reaction.emoji.trim(),
        });
      }
    }

    for (const [targetMessageId, override] of Object.entries(selfReactionOverridesByMessageId)) {
      for (const key of [...latestByActorTarget.keys()]) {
        if (key.startsWith("bot:") && key.endsWith(`:${targetMessageId}`)) {
          latestByActorTarget.delete(key);
        }
      }
      if (override.trim()) {
        latestByActorTarget.set(`local-self:${targetMessageId}`, {
          targetMessageId,
          emoji: override.trim(),
        });
      }
    }

    const countsByTarget: Record<string, Record<string, number>> = {};
    for (const entry of latestByActorTarget.values()) {
      if (!entry.emoji) continue;
      countsByTarget[entry.targetMessageId] ||= {};
      countsByTarget[entry.targetMessageId][entry.emoji] =
        (countsByTarget[entry.targetMessageId][entry.emoji] || 0) + 1;
    }

    for (const [messageId, counts] of Object.entries(countsByTarget)) {
      const sorted = Object.entries(counts).sort((left, right) => right[1] - left[1]);
      const total = sorted.reduce((sum, [, count]) => sum + count, 0);
      if (!total) continue;
      next[messageId] = {
        emojis: sorted.map(([emoji]) => emoji).slice(0, 3),
        total,
      };
    }

    return next;
  }, [selectedMessages, selfReactionOverridesByMessageId]);

  const renderedMessages = selectedMessages;

  const openConversation = (conversationId: string) => {
    setSelectedConversationId(conversationId);
    setMobileConversationOpen(true);
  };

  const copyConversationPhone = async (conversationId: string, phone: string) => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(phone);
      } else {
        const input = document.createElement("textarea");
        input.value = phone;
        input.setAttribute("readonly", "");
        input.style.position = "absolute";
        input.style.left = "-9999px";
        document.body.appendChild(input);
        input.select();
        document.execCommand("copy");
        document.body.removeChild(input);
      }

      setCopiedConversationId(conversationId);
      if (copyFeedbackTimerRef.current) {
        window.clearTimeout(copyFeedbackTimerRef.current);
      }
      copyFeedbackTimerRef.current = window.setTimeout(() => {
        setCopiedConversationId((current) => (current === conversationId ? null : current));
      }, 1600);
    } catch (error) {
      console.error("Failed to copy conversation phone", error);
    }
  };

  useEffect(
    () => () => {
      if (copyFeedbackTimerRef.current) {
        window.clearTimeout(copyFeedbackTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;

    async function loadCalls() {
      setCallsLoading(true);
      try {
        const response = await fetch(apiUrl("/api/whatsapp/calls"), {
          cache: "no-store",
          credentials: "include",
        });
        const payload = (await response.json()) as { calls?: WhatsappCallSession[] };
        if (!response.ok) {
          throw new Error("Failed to load call sessions");
        }
        if (!cancelled) {
          setCallSessions(payload.calls || []);
          setCallError("");
        }
      } catch (error) {
        if (!cancelled) {
          setCallError(error instanceof Error ? error.message : "Failed to load call sessions");
        }
      } finally {
        if (!cancelled) {
          setCallsLoading(false);
        }
      }
    }

    void loadCalls();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedConversationCall) return;
    let cancelled = false;

    const loadSignals = async () => {
      try {
        const response = await fetch(apiUrl(`/api/whatsapp/calls/${selectedConversationCall.id}/signals`), {
          cache: "no-store",
          credentials: "include",
        });
        const payload = (await response.json()) as { signals?: WhatsappCallSignalEvent[] };
        if (!response.ok) {
          throw new Error("Failed to load call signals");
        }
        if (!cancelled) {
          setCallSignalsByCallId((current) => ({
            ...current,
            [selectedConversationCall.id]: payload.signals || [],
          }));
        }
      } catch {
        // Ignore missing signals while the transport is still being wired.
      }
    };

    void loadSignals();

    return () => {
      cancelled = true;
    };
  }, [selectedConversationCall]);

  useEffect(() => {
    if (!selectedConversationCall) return;
    let cancelled = false;

    const loadMediaSession = async () => {
      try {
        const response = await fetch(
          apiUrl(`/api/whatsapp/calls/${selectedConversationCall.id}/media-session`),
          {
            cache: "no-store",
            credentials: "include",
          },
        );
        const payload = (await response.json()) as { mediaSession?: CallMediaSession };
      if (!response.ok || !payload.mediaSession) {
        throw new Error("Failed to load call media session");
      }
      if (!cancelled) {
        setCallMediaSessionsByCallId((current) => ({
          ...current,
          [selectedConversationCall.id]: payload.mediaSession!,
        }));
      }
    } catch {
      // Ignore transient media-session load failures while the call is initializing.
    }
    };

    void loadMediaSession();

    return () => {
      cancelled = true;
    };
  }, [selectedConversationCall]);

  useEffect(() => {
    const stopActiveCallMedia = () => {
      peerConnectionRef.current?.close();
      peerConnectionRef.current = null;

      if (localStreamRef.current) {
        for (const track of localStreamRef.current.getTracks()) {
          track.stop();
        }
      }
      localStreamRef.current = null;
      activeWebRtcCallIdRef.current = null;

      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = null;
      }
    };

    return () => {
      stopActiveCallMedia();
    };
  }, []);

  useEffect(() => {
    const stopActiveCallMedia = () => {
      peerConnectionRef.current?.close();
      peerConnectionRef.current = null;

      if (localStreamRef.current) {
        for (const track of localStreamRef.current.getTracks()) {
          track.stop();
        }
      }
      localStreamRef.current = null;
      activeWebRtcCallIdRef.current = null;

      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = null;
      }
    };

    if (!selectedConversationCall && activeWebRtcCallIdRef.current) {
      stopActiveCallMedia();
      setCallMediaState("idle");
      setCallMediaError("");
      return;
    }

    if (
      selectedConversationCall &&
      !isLiveCallStatus(selectedConversationCall.status) &&
      activeWebRtcCallIdRef.current === selectedConversationCall.id
    ) {
      stopActiveCallMedia();
      setCallMediaState("idle");
    }
  }, [selectedConversationCall]);

  const renderChannelPanelContent = () => (
    <>
      <div className="border-b border-border px-5 py-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-foreground">Manage channels</h2>
            <p className="mt-1 text-sm text-muted-foreground">Choose which connected channels appear in Inbox.</p>
          </div>
          <Button variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground" onClick={() => setShowChannelPanel(false)}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="space-y-6 p-5">
          <section>
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Connected</p>
            <div className="rounded-lg border border-border bg-card">
              <div className="flex items-center gap-3 px-4 py-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-md bg-status-success-soft text-status-success">
                  {(() => { const Icon = inboxChannelIcon("whatsapp"); return <Icon className={inboxChannelIconClass("whatsapp")} />; })()}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">WhatsApp</p>
                  <p className="text-xs text-muted-foreground">
                    {channelCounts.whatsapp.connected
                      ? `${channelCounts.whatsapp.connectionCount} connected number${channelCounts.whatsapp.connectionCount === 1 ? "" : "s"}`
                      : "Not connected"}
                  </p>
                </div>
                {channelCounts.whatsapp.connected ? <Badge variant="outline">Connected</Badge> : null}
              </div>
              {channelCounts.whatsapp.connected ? (
                <div className="border-t border-border p-2">
                  {whatsappConnectionFilters.map((connectionFilter) => (
                    <button
                      key={connectionFilter.id || "all"}
                      type="button"
                      onClick={() => {
                        setSelectedChannel("whatsapp");
                        setSelectedConnectionId(connectionFilter.id);
                        setShowChannelPanel(false);
                        setMobileConversationOpen(false);
                      }}
                      className={cn(
                        "flex min-h-9 w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-secondary",
                        selectedChannel === "whatsapp" &&
                          selectedConnectionId === connectionFilter.id &&
                          "bg-secondary text-foreground",
                      )}
                    >
                      <span className="truncate">{connectionFilter.label}</span>
                      <span className="ml-3 shrink-0 text-xs tabular-nums text-muted-foreground">
                        {connectionFilter.conversationCount}
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="border-t border-border p-3">
                  <Button asChild size="sm"><Link href="/connections#whatsapp-setup">Connect WhatsApp</Link></Button>
                </div>
              )}
            </div>
          </section>

          <section>
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Meta messaging</p>
            <div className="divide-y divide-border rounded-lg border border-border bg-card">
                {[
                { key: "instagram" as const, label: "Instagram", icon: inboxChannelIcon("instagram"), color: inboxChannelIconClass("instagram") },
                { key: "facebook" as const, label: "Facebook Messenger", icon: inboxChannelIcon("facebook"), color: inboxChannelIconClass("facebook") },
              ].map((channel) => {
                const Icon = channel.icon;
                const state = channelCounts[channel.key];
                return (
                  <div key={channel.key} className="flex items-center gap-3 px-4 py-3">
                    <Icon className={`h-4 w-4 ${channel.color}`} />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium text-foreground">{channel.label}</p>
                      <p className="text-xs text-muted-foreground">
                        {state.connected
                          ? `${state.connectionCount} connected account${state.connectionCount === 1 ? "" : "s"}`
                          : "Not connected"}
                      </p>
                    </div>
                    {state.connected ? <Badge variant="outline">Connected</Badge> : null}
                  </div>
                );
              })}
              <div className="p-3">
                <Button asChild size="sm" variant="outline"><Link href="/connections">Manage Meta connections</Link></Button>
              </div>
            </div>
          </section>

          <section>
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Email</p>
            <div className="divide-y divide-border rounded-lg border border-border bg-card">
              <div className="flex items-center gap-3 px-4 py-3">
                <Mail className="h-4 w-4 text-blue-400" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-foreground">
                    {emailConnectedConnections.length > 0 ? "Email" : "No mailbox connected"}
                  </p>
                  <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                    {emailConnectedConnections.length > 0
                      ? `${emailConnectedConnections.length} connected mailbox${emailConnectedConnections.length === 1 ? "" : "es"}`
                      : "Google and Microsoft"}
                  </p>
                </div>
                {emailConnectedConnections.length > 0 ? (
                  <Badge variant="outline">
                    {emailReadyConnections.length === emailConnectedConnections.length
                      ? "Ready"
                      : emailConnectedConnections.some((connection) => emailConnectionStatus(connection) === "Needs attention")
                        ? "Needs attention"
                        : "Syncing"}
                  </Badge>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => setShowEmailConnectDialog(true)}>Connect</Button>
                )}
              </div>
              {emailConnectedConnections.length > 0 ? (
                <div className="border-t border-border p-2">
                  {emailConnectionFilters.map((connectionFilter) => (
                    <button
                      key={connectionFilter.id || "all-email"}
                      type="button"
                      onClick={() => {
                        setSelectedChannel("email");
                        setSelectedConnectionId(connectionFilter.id);
                        setShowChannelPanel(false);
                        setMobileConversationOpen(false);
                      }}
                      className={cn(
                        "flex min-h-9 w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-secondary",
                        selectedChannel === "email" && selectedConnectionId === connectionFilter.id && "bg-secondary text-foreground",
                      )}
                    >
                      <span className="min-w-0 truncate">{connectionFilter.label}</span>
                      <span className="ml-3 flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                        {connectionFilter.status ? <span>{connectionFilter.status}</span> : null}
                        <span className="tabular-nums">{connectionFilter.conversationCount}</span>
                      </span>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          </section>

          <section>
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Available next</p>
            <div className="divide-y divide-border rounded-lg border border-border bg-card"><div className="flex items-start gap-3 px-4 py-3 opacity-70"><MessageCircle className="mt-0.5 h-4 w-4 text-muted-foreground" /><div><p className="text-sm font-medium text-foreground">SMS</p><p className="mt-0.5 text-xs leading-5 text-muted-foreground">Manage text-message conversations alongside WhatsApp</p></div></div></div>
          </section>
        </div>
      </ScrollArea>
    </>
  );

  useEffect(() => {
    if (!selectedConversationId || messagesByConversationId[selectedConversationId]) {
      return;
    }

    const conversationId = selectedConversationId;
    let cancelled = false;

    async function loadMessages() {
      setMessagesLoading(true);

      try {
        const response = await fetch(apiUrl(`/api/inbox/${conversationId}/messages`), {
          cache: "no-store",
          credentials: "include",
        });
        const payload = (await response.json()) as {
          messages?: ConversationMessage[];
          capabilities?: ConversationCapabilities;
        };

        if (!response.ok) {
          throw new Error("Failed to load messages");
        }

        if (cancelled) return;

        setMessagesByConversationId((current) => ({
          ...current,
          [conversationId]: (payload.messages || []).map((message) => ({
            ...message,
            time: new Date(message.time).toLocaleTimeString("en-ZA", {
              hour: "2-digit",
              minute: "2-digit",
            }),
            timestamp: message.time,
            status: normalizeRealtimeStatus(
              message.status as
                | "PROCESSING"
                | "SENT"
                | "DELIVERED"
                | "READ"
                | "FAILED"
                | "BLOCKED"
                | undefined,
            ),
          })),
        }));
        if (payload.capabilities) {
          setCapabilitiesByConversationId((current) => ({
            ...current,
            [conversationId]: payload.capabilities!,
          }));
        }
      } catch {
        if (cancelled) return;
        setMessagesByConversationId((current) => ({
          ...current,
          [conversationId]: [],
        }));
      } finally {
        if (!cancelled) {
          setMessagesLoading(false);
        }
      }
    }

    void loadMessages();

    return () => {
      cancelled = true;
    };
  }, [messagesByConversationId, selectedConversationId]);

  useEffect(() => {
    if (!selectedConversationId) return;

    const conversationId = selectedConversationId;
    let cancelled = false;

    const refreshMessages = async () => {
      if (document.visibilityState === "hidden") return;

      try {
        const response = await fetch(apiUrl(`/api/inbox/${conversationId}/messages`), {
          cache: "no-store",
          credentials: "include",
        });
        if (!response.ok) return;

        const payload = (await response.json()) as {
          messages?: ConversationMessage[];
          capabilities?: ConversationCapabilities;
        };
        if (cancelled || !Array.isArray(payload.messages)) return;
        const messages = payload.messages;

        setMessagesByConversationId((current) => ({
          ...current,
          [conversationId]: messages.map((message) => ({
            ...message,
            time: new Date(message.time).toLocaleTimeString("en-ZA", {
              hour: "2-digit",
              minute: "2-digit",
            }),
            timestamp: message.time,
            status: normalizeRealtimeStatus(
              message.status as
                | "PROCESSING"
                | "SENT"
                | "DELIVERED"
                | "READ"
                | "FAILED"
                | "BLOCKED"
                | undefined,
            ),
          })),
        }));
        if (payload.capabilities) {
          setCapabilitiesByConversationId((current) => ({
            ...current,
            [conversationId]: payload.capabilities!,
          }));
        }
      } catch {
        // Keep the last known messages if a foreground refresh fails.
      }
    };

    const onVisibleOrFocused = () => {
      if (document.visibilityState === "visible") {
        void refreshMessages();
      }
    };

    window.addEventListener("focus", onVisibleOrFocused);
    document.addEventListener("visibilitychange", onVisibleOrFocused);

    return () => {
      cancelled = true;
      window.removeEventListener("focus", onVisibleOrFocused);
      document.removeEventListener("visibilitychange", onVisibleOrFocused);
    };
  }, [selectedConversationId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [renderedMessages.length, selectedConversationId]);

  useEffect(() => {
    if (!reactionPicker) return;

    const onPointerDown = (event: PointerEvent) => {
      if (reactionPickerRef.current?.contains(event.target as Node)) return;
      if (reactionTriggerRefs.current[reactionPicker.messageId]?.contains(event.target as Node)) return;
      setReactionPicker(null);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setReactionPicker(null);
      }
    };

    const updatePlacement = () => {
      setReactionPicker((current) => {
        if (!current) return current;
        const trigger = reactionTriggerRefs.current[current.messageId];
        if (!trigger) return null;
        return calculateReactionPickerPosition(current.messageId, trigger);
      });
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", updatePlacement);
    window.addEventListener("scroll", updatePlacement, true);

    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", updatePlacement);
      window.removeEventListener("scroll", updatePlacement, true);
    };
  }, [reactionPicker]);

  useEffect(() => {
    if (!selectedConversationId) return;

    setLiveConversations((current) =>
      current.map((conversation) =>
        conversation.id === selectedConversationId
          ? { ...conversation, unread: false }
          : conversation,
      ),
    );

    void markConversationRead(selectedConversationId);
  }, [selectedConversationId]);

  useEffect(() => {
    const input = composerInputRef.current;
    if (!input) return;

    input.style.height = "0px";
    const nextHeight = Math.min(input.scrollHeight, 160);
    input.style.height = `${Math.max(nextHeight, 40)}px`;
    input.style.overflowY = input.scrollHeight > 160 ? "auto" : "hidden";
  }, [messageInput, selectedConversationId]);

  useEffect(() => {
    if (!showEmojiPicker) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!emojiPickerRef.current) return;
      if (!emojiPickerRef.current.contains(event.target as Node)) {
        setShowEmojiPicker(false);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setShowEmojiPicker(false);
      }
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [showEmojiPicker]);

  useWhatsappRealtimeSubscription((payload) => {
    if (payload.type === "call.created") {
      setCallSessions((current) => upsertCallSession(current, payload.call));
      setCallError("");

      if (payload.call.conversationId) {
        setSelectedConversationId(payload.call.conversationId);
        setMobileConversationOpen(true);
      }
      return;
    }

    if (payload.type === "call.updated") {
      setCallSessions((current) => upsertCallSession(current, payload.call));
      setCallError("");
      return;
    }

    if (payload.type === "call.signal") {
      setCallSignalsByCallId((current) => {
        const currentSignals = current[payload.callId] || [];
        const nextSignal: WhatsappCallSignalEvent = {
          id: `${payload.callId}:${payload.kind}:${currentSignals.length + 1}`,
          eventType: `call.signal.${payload.kind}`,
          createdAt: new Date().toISOString(),
          payload: {
            kind: payload.kind,
            source: payload.source,
            payload: payload.signal,
          },
        };
        return {
          ...current,
          [payload.callId]: [...currentSignals, nextSignal],
        };
      });
      handleRealtimeCallSignal(payload.callId, payload.kind, payload.source);
      return;
    }

    if (payload.type === "message.created") {
      const conversationId = payload.conversationId;
      const isVisibleCustomerMessage =
        payload.message.sender === "customer" &&
        conversationId === selectedConversationId &&
        document.visibilityState === "visible";

      if (isVisibleCustomerMessage) {
        void markConversationRead(conversationId);
      }

      setLiveConversations((current) => {
        const existing = current.find((conversation) => conversation.id === conversationId);
        const fallbackName =
          payload.conversation?.customerName || payload.conversation?.phone || "Unknown contact";

        if (!existing) {
          return upsertConversationByRecentActivity(current, {
            id: conversationId,
            name: fallbackName,
            handle: payload.conversation?.phone || "Unknown contact",
            lastMessage: getMessagePreview(payload.message),
            time: payload.message.timestamp,
            unread: payload.message.sender === "customer" && conversationId !== selectedConversationId,
            starred: false,
            channel: payload.conversation?.channel || "whatsapp",
            connectionId: payload.conversation?.connectionId || null,
            connectionLabel:
              payload.conversation?.connectionLabel || payload.conversation?.phone || "Unknown number",
            avatar: buildConversationAvatar(fallbackName),
            status: "offline" as const,
            tags: [],
          });
        }

        return upsertConversationByRecentActivity(current, {
          ...existing,
          time: payload.message.timestamp,
          lastMessage: getMessagePreview(payload.message),
          unread:
            payload.message.sender === "customer"
              ? existing.id !== selectedConversationId
              : existing.unread,
        });
      });

      setMessagesByConversationId((current) => {
        const existing = current[conversationId];
        if (!existing) return current;

        const confirmedMessage: ConversationMessage = {
          id: payload.message.id,
          sender: payload.message.sender,
          content: payload.message.content,
          text: getMessageDisplayText(payload.message),
          time: new Date(payload.message.timestamp).toLocaleTimeString("en-ZA", {
            hour: "2-digit",
            minute: "2-digit",
          }),
          timestamp: payload.message.timestamp,
          providerMessageId: payload.message.providerMessageId,
          contentType: payload.message.contentType,
          attachments: payload.message.attachments || [],
          reference: payload.message.reference || null,
          reactions: payload.message.reactions || [],
          status: normalizeRealtimeStatus(
            payload.message.status || payload.message.providerStatus || payload.message.whatsappStatus,
          ),
        };

        const existingMessageIndex = existing.findIndex(
          (message) => message.id === payload.message.id,
        );
        if (existingMessageIndex !== -1) {
          const next = [...existing];
          next[existingMessageIndex] = {
            ...next[existingMessageIndex],
            ...confirmedMessage,
          };
          return { ...current, [conversationId]: next };
        }

        const next = [...existing];
        const optimisticIndex =
          payload.message.sender === "bot"
            ? next.findIndex(
                (message) =>
                  message.sender === "bot" &&
                  message.status === "pending" &&
                  message.content === payload.message.content,
              )
            : -1;

        if (optimisticIndex !== -1) {
          next[optimisticIndex] = confirmedMessage;

          return {
            ...current,
            [conversationId]: next.sort(
              (left, right) =>
                new Date(left.timestamp || 0).getTime() -
                new Date(right.timestamp || 0).getTime(),
            ),
          };
        }

        return {
          ...current,
          [conversationId]: [...next, confirmedMessage].sort(
            (left, right) =>
              new Date(left.timestamp || 0).getTime() -
              new Date(right.timestamp || 0).getTime(),
          ),
        };
      });
      return;
    }

    if (payload.type === "conversation.updated") {
      setLiveConversations((current) => {
        const existing = current.find((conversation) => conversation.id === payload.conversationId);
        const nextConversation: InboxConversation = existing
          ? {
              ...existing,
              name: payload.conversation.customerName || existing.name,
              handle: payload.conversation.phone,
              time: payload.conversation.lastMessageAt,
              unread: payload.conversation.unreadCount > 0,
              starred: payload.conversation.starred ?? existing.starred,
              connectionId: payload.conversation.connectionId || existing.connectionId,
              connectionLabel:
                payload.conversation.connectionLabel ||
                existing.connectionLabel ||
                payload.conversation.phone ||
                "Unknown number",
              avatar: buildConversationAvatar(
                payload.conversation.customerName || payload.conversation.phone || existing.name,
              ),
            }
          : {
              id: payload.conversationId,
              name: payload.conversation.customerName || payload.conversation.phone || "Unknown contact",
              handle: payload.conversation.phone,
              lastMessage: "New conversation",
              time: payload.conversation.lastMessageAt,
              unread: payload.conversation.unreadCount > 0,
              starred: payload.conversation.starred ?? false,
              channel: payload.conversation.channel || "whatsapp",
              connectionId: payload.conversation.connectionId || null,
              connectionLabel:
                payload.conversation.connectionLabel || payload.conversation.phone || "Unknown number",
              avatar: buildConversationAvatar(
                payload.conversation.customerName || payload.conversation.phone || "?",
              ),
              status: "offline" as const,
              tags: [],
            };

        return upsertConversationByRecentActivity(current, nextConversation);
      });
      return;
    }

    if (payload.type === "message.reactions_updated") {
      const conversationId = payload.conversationId;
      setMessagesByConversationId((current) => {
        const existing = current[conversationId];
        if (!existing) return current;
        return {
          ...current,
          [conversationId]: existing.map((message) =>
            message.id === payload.message.id
              ? { ...message, reactions: payload.message.reactions }
              : message,
          ),
        };
      });
      return;
    }

    if (payload.type === "message.updated") {
      const conversationId = payload.conversationId;
      setMessagesByConversationId((current) => {
        const existing = current[conversationId];
        if (!existing) return current;

        return {
          ...current,
          [conversationId]: existing.map((message) =>
            message.id === payload.message.id
              ? {
                  ...message,
                  status: normalizeRealtimeStatus(
                    payload.message.providerStatus || payload.message.whatsappStatus,
                  ),
                  errorMessage: payload.message.errorMessage || null,
                }
              : message,
          ),
        };
      });
      return;
    }

    if (payload.type === "message.send_failed") {
      const conversationId = payload.conversationId;
      setComposerError(payload.error);
      setMessagesByConversationId((current) => {
        const existing = current[conversationId];
        if (!existing) return current;

        return {
          ...current,
          [conversationId]: existing.map((message) =>
            message.sender === "bot" &&
            message.status === "pending" &&
            payload.text &&
            message.text === payload.text
              ? {
                  ...message,
                  status: "failed",
                  errorMessage: payload.error || "Failed to send WhatsApp message",
                }
              : message,
          ),
        };
      });
    }
  });

  async function ensureCallMediaSession(callId: string) {
    const existing = callMediaSessionsByCallId[callId];
    if (existing) return existing;

    logCallMediaEvent(callId, "media-session.load.start");
    const response = await fetch(apiUrl(`/api/whatsapp/calls/${callId}/media-session`), {
      cache: "no-store",
      credentials: "include",
    });
    const payload = (await response.json()) as { mediaSession?: CallMediaSession; error?: string };
    if (!response.ok || !payload.mediaSession) {
      throw new Error(payload.error || "Failed to load media session");
    }
    logCallMediaEvent(callId, "media-session.load.success", {
      provider: payload.mediaSession.provider || "unknown",
    });
    setCallMediaSessionsByCallId((current) => ({
      ...current,
      [callId]: payload.mediaSession!,
    }));
    return payload.mediaSession!;
  }

  async function postCallSignal(callId: string, kind: string, payload: unknown) {
    logCallMediaEvent(callId, "signal.post", { kind });
    const response = await fetch(apiUrl(`/api/whatsapp/calls/${callId}/signals`), {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        kind,
        source: "agent-ui",
        payload,
      }),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error || `Failed to send ${kind} signal`);
    }
  }

  function waitForIceGatheringComplete(peerConnection: RTCPeerConnection) {
    if (peerConnection.iceGatheringState === "complete") {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const onStateChange = () => {
        if (peerConnection.iceGatheringState === "complete") {
          peerConnection.removeEventListener("icegatheringstatechange", onStateChange);
          resolve();
        }
      };
      peerConnection.addEventListener("icegatheringstatechange", onStateChange);
    });
  }

  async function createMetaPeerConnection(callId: string) {
    if (peerConnectionRef.current && activeWebRtcCallIdRef.current === callId) {
      return peerConnectionRef.current;
    }

    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    if (localStreamRef.current) {
      for (const track of localStreamRef.current.getTracks()) {
        track.stop();
      }
      localStreamRef.current = null;
    }

    setCallMediaState("requesting");
    const localStream = await requestPreferredAudioStream();
    localStreamRef.current = localStream;

    const peerConnection = new RTCPeerConnection();
    for (const track of localStream.getTracks()) {
      peerConnection.addTrack(track, localStream);
    }

    peerConnection.ontrack = (event) => {
      const [remoteStream] = event.streams;
      if (remoteAudioRef.current && remoteStream) {
        logCallMediaEvent(callId, "webrtc.remote-track");
        setCallMediaState("connected");
        remoteAudioRef.current.srcObject = remoteStream;
        void remoteAudioRef.current.play().catch(() => {
          // Some browsers still require user interaction for playback.
        });
      }
    };

    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection.connectionState;
      logCallMediaEvent(callId, "webrtc.connection-state", { state });
      if (state === "connected") {
        setCallMediaState("connected");
      } else if (state === "connecting") {
        setCallMediaState("connecting");
      } else if (state === "failed" || state === "disconnected" || state === "closed") {
        setCallMediaState("failed");
      }
    };

    peerConnectionRef.current = peerConnection;
    activeWebRtcCallIdRef.current = callId;
    return peerConnection;
  }

  async function startMetaDirectWebRtcForCall(
    callId: string,
    mediaSession: CallMediaSession & { webrtc: { sdpType: string; sdp: string } },
  ) {
    if (typeof window === "undefined" || !("RTCPeerConnection" in window) || !navigator.mediaDevices?.getUserMedia) {
      throw new Error("This browser does not support WebRTC audio calling");
    }

    setCallMediaLoading(callId);
    setCallMediaError("");

    try {
      const peerConnection = await createMetaPeerConnection(callId);
      logCallMediaEvent(callId, "webrtc.offer.received", {
        sdpType: mediaSession.webrtc.sdpType,
      });
      await peerConnection.setRemoteDescription(
        new RTCSessionDescription({
          type: mediaSession.webrtc.sdpType as RTCSdpType,
          sdp: mediaSession.webrtc.sdp,
        }),
      );
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      await waitForIceGatheringComplete(peerConnection);
      const localDescription = peerConnection.localDescription;
      if (!localDescription?.sdp) {
        throw new Error("Browser failed to generate an SDP answer");
      }
      await postCallSignal(callId, "answer", {
        type: localDescription.type,
        sdp: localDescription.sdp,
      });
      setCallMediaState("connecting");
    } catch (error) {
      setCallMediaState("failed");
      setCallMediaError(
        error instanceof Error
          ? error.message
          : "Failed to start direct Meta WebRTC audio. Check microphone permission and device availability.",
      );
      throw error;
    } finally {
      setCallMediaLoading(null);
    }
  }

  function handleRealtimeCallSignal(callId: string, kind: string, source?: string | null) {
    logCallMediaEvent(callId, "signal.receive.ignored", {
      kind,
      source: source || null,
      reason: "legacy-webrtc-path-removed",
    });
  }

  async function applyCallAction(callId: string, action: "accept" | "reject" | "end") {
    setCallActionLoading(action);
    setCallError("");

    try {
      const response = await fetch(apiUrl(`/api/whatsapp/calls/${callId}/action`), {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action }),
      });
      const payload = (await response.json()) as { call?: WhatsappCallSession; error?: string };
      if (!response.ok || !payload.call) {
        throw new Error(payload.error || "Failed to update call state");
      }
      setCallSessions((current) => upsertCallSession(current, payload.call as WhatsappCallSession));
      if (action === "accept") {
        logCallMediaEvent(callId, "action.accepted-by-api", {
          status: payload.call.status,
        });
        const mediaSession = await ensureCallMediaSession(callId);
        if (isMetaDirectWebRtcMediaSession(mediaSession)) {
          await startMetaDirectWebRtcForCall(callId, mediaSession);
        } else {
          throw new Error("Received a call without a valid Meta WebRTC session.");
        }
      }
      if (action === "end" || action === "reject") {
        const mediaSession = callMediaSessionsByCallId[callId];
        if (isMetaDirectWebRtcMediaSession(mediaSession)) {
          peerConnectionRef.current?.close();
          peerConnectionRef.current = null;
          activeWebRtcCallIdRef.current = null;
          if (localStreamRef.current) {
            for (const track of localStreamRef.current.getTracks()) {
              track.stop();
            }
          }
          localStreamRef.current = null;
          setCallMediaState("idle");
        }
      }
    } catch (error) {
      setCallError(error instanceof Error ? error.message : "Failed to update call state");
    } finally {
      setCallActionLoading(null);
    }
  }

  async function sendReaction(messageId: string, emoji: string, remove = false) {
    if (!selectedConversationId) return;

    const nextEmoji = remove ? "" : emoji.trim();
    const previousReaction =
      selfReactionOverridesByMessageId[messageId] ?? persistedSelfReactionsByMessageId[messageId] ?? "";

    setSelfReactionOverridesByMessageId((current) => ({
      ...current,
      [messageId]: nextEmoji,
    }));
    setReactionPicker(null);

    const response = await fetch(
      apiUrl(`/api/whatsapp/inbox/${selectedConversationId}/messages/${messageId}/reaction`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(remove ? { remove: true } : { emoji: nextEmoji }),
      },
    );

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      setSelfReactionOverridesByMessageId((current) => ({
        ...current,
        [messageId]: previousReaction,
      }));
      setComposerError(payload.error || "Failed to send reaction");
      return;
    }

    setComposerError("");
  }

  async function deleteMessage(messageId: string) {
    if (!selectedConversationId) return;
    const conversationId = selectedConversationId;

    const response = await fetch(
      apiUrl(`/api/whatsapp/inbox/${conversationId}/messages/${messageId}`),
      { method: "DELETE", credentials: "include" },
    );

    if (!response.ok) return;

    setMessagesByConversationId((current) => ({
      ...current,
      [conversationId]: (current[conversationId] || []).filter(
        (message) => message.id !== messageId,
      ),
    }));
  }

  async function toggleConversationStar() {
    if (!selectedConversationId || !selectedConversation) return;

    const nextStarred = !selectedConversation.starred;
    const response = await fetch(apiUrl(`/api/whatsapp/inbox/${selectedConversationId}`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ starred: nextStarred }),
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      setComposerError(payload.error || "Failed to update conversation");
      return;
    }

    setLiveConversations((current) =>
      current.map((conversation) =>
        conversation.id === selectedConversationId
          ? { ...conversation, starred: nextStarred }
          : conversation,
      ),
    );
  }

  async function deleteSelectedConversation() {
    if (!selectedConversationId || !selectedConversation) return;
    if (!await confirm({ title: `Delete conversation with ${selectedConversation.name}?`, confirmLabel: "Delete", variant: "destructive" })) return;

    const deletedConversationId = selectedConversationId;
    const response = await fetch(apiUrl(`/api/whatsapp/inbox/${deletedConversationId}`), {
      method: "DELETE",
      credentials: "include",
    });

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      setComposerError(payload.error || "Failed to delete conversation");
      return;
    }

    setLiveConversations((current) =>
      current.filter((conversation) => conversation.id !== deletedConversationId),
    );
    setMessagesByConversationId((current) => {
      const next = { ...current };
      delete next[deletedConversationId];
      return next;
    });
    setSelectedConversationId(null);
  }

  async function sendMessage() {
    if (!selectedConversationId) return;
    const conversationId = selectedConversationId;

    const trimmed = messageInput.trim();
    if (!trimmed && !selectedFile) return;

    setComposerLoading(true);
    setComposerError("");

    const optimisticId = `optimistic:${Date.now()}`;
    if (trimmed && !selectedFile) {
      setMessagesByConversationId((current) => ({
        ...current,
        [conversationId]: [
          ...(current[conversationId] || []),
          {
            id: optimisticId,
            sender: "bot",
            content: trimmed,
            text: trimmed,
            time: new Date().toLocaleTimeString("en-ZA", {
              hour: "2-digit",
              minute: "2-digit",
            }),
            timestamp: new Date().toISOString(),
            status: "pending",
            contentType: "TEXT",
            attachments: [],
            reactions: [],
            reference: replyDraft
              ? {
                  messageId: replyDraft.messageId,
                  kind: "REPLY",
                  previewText: replyDraft.text,
                }
              : null,
          },
        ],
      }));
    }

    const response = selectedFile && selectedConversation?.channel === "whatsapp"
      ? await (async () => {
          const formData = new FormData();
          formData.append("file", selectedFile);
          if (trimmed) {
            formData.append("caption", trimmed);
          }
          if (replyDraft?.messageId) {
            formData.append("replyToMessageId", replyDraft.messageId);
          }
          return fetch(apiUrl(`/api/whatsapp/inbox/${conversationId}/messages/media`), {
            method: "POST",
            credentials: "include",
            body: formData,
          });
        })()
      : await fetch(apiUrl(`/api/inbox/${conversationId}/messages`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({
            text: trimmed || undefined,
            replyToMessageId: replyDraft?.messageId,
          }),
        });

    if (!response.ok) {
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      setComposerError(payload.error || "Failed to send message");
      setMessagesByConversationId((current) => ({
        ...current,
        [conversationId]: (current[conversationId] || []).filter(
          (message) => message.id !== optimisticId,
        ),
      }));
    } else {
      const payload = (await response.json().catch(() => ({}))) as {
        messageId?: string;
        queued?: boolean;
        status?: "SENT";
      };
      if (payload.messageId && optimisticId.startsWith("optimistic:")) {
        setMessagesByConversationId((current) => ({
          ...current,
          [conversationId]: (current[conversationId] || []).map((message) =>
            message.id === optimisticId
              ? {
                  ...message,
                  id: payload.messageId!,
                  status: payload.queued ? "pending" : (payload.status || "SENT"),
                }
              : message,
          ),
        }));
      }
      setMessageInput("");
      setSelectedFile(null);
      setReplyDraft(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }

    setComposerLoading(false);
  }

  async function retryMessage(message: ConversationMessage) {
    if (!selectedConversationId || message.sender === "customer" || message.status !== "failed") {
      return;
    }

    const conversationId = selectedConversationId;
    setRetryingMessageId(message.id);
    setComposerError("");
    setMessagesByConversationId((current) => ({
      ...current,
      [conversationId]: (current[conversationId] || []).map((candidate) =>
        candidate.id === message.id
          ? { ...candidate, status: "pending", errorMessage: null }
          : candidate,
      ),
    }));

    try {
      const response = await fetch(
        apiUrl(`/api/inbox/${conversationId}/messages/${message.id}/retry`),
        {
          method: "POST",
          credentials: "include",
        },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        error?: string;
        status?: "SENT";
      };

      if (!response.ok) {
        throw new Error(payload.error || "Failed to retry message");
      }

      setMessagesByConversationId((current) => ({
        ...current,
        [conversationId]: (current[conversationId] || []).map((candidate) =>
          candidate.id === message.id
            ? { ...candidate, status: payload.status || "SENT", errorMessage: null }
            : candidate,
        ),
      }));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Failed to retry message";
      setMessagesByConversationId((current) => ({
        ...current,
        [conversationId]: (current[conversationId] || []).map((candidate) =>
          candidate.id === message.id
            ? { ...candidate, status: "failed", errorMessage }
            : candidate,
        ),
      }));
    } finally {
      setRetryingMessageId(null);
    }
  }

  function insertEmojiAtCursor(emoji: string) {
    if (!emoji) return;
    const input = composerInputRef.current;
    const start = input?.selectionStart ?? messageInput.length;
    const end = input?.selectionEnd ?? messageInput.length;
    const nextText = `${messageInput.slice(0, start)}${emoji}${messageInput.slice(end)}`;
    setMessageInput(nextText);
    setShowEmojiPicker(false);

    requestAnimationFrame(() => {
      if (!input) return;
      input.focus();
      const cursor = start + emoji.length;
      input.setSelectionRange(cursor, cursor);
    });
  }

  function toggleReactionPicker(messageId: string) {
    setReactionPicker((current) => {
      if (current?.messageId === messageId) {
        return null;
      }

      const trigger = reactionTriggerRefs.current[messageId];
      if (!trigger) return current;

      return calculateReactionPickerPosition(messageId, trigger);
    });
  }

  return (
    <TooltipProvider>
      <div className="relative flex h-[calc(100dvh-4rem)] min-h-0 flex-col overflow-hidden bg-background lg:h-[100dvh]">
        <Sheet open={showChannelPanel} onOpenChange={setShowChannelPanel}>
        <SheetContent side="left" className="flex w-[min(360px,100vw)] flex-col p-0">
            {renderChannelPanelContent()}
          </SheetContent>
        </Sheet>

        <Dialog open={showEmailConnectDialog} onOpenChange={(open) => { setShowEmailConnectDialog(open); if (!open) { setEmailConnectError(null); setEmailConnectProvider(null); } }}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Connect email</DialogTitle>
              <DialogDescription>Choose a mailbox provider.</DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              {[
                { id: "google" as const, name: "Google", description: "Gmail and Google Workspace mail" },
                { id: "microsoft" as const, name: "Microsoft", description: "Outlook and Microsoft 365 mail" },
              ].map((provider) => (
                <Button key={provider.id} type="button" variant="outline" className="h-auto w-full justify-between px-4 py-3 text-left" onClick={() => void startEmailConnection(provider.id)} disabled={Boolean(emailConnectProvider)}>
                  <span><span className="block font-medium">{provider.name}</span><span className="mt-0.5 block text-xs text-muted-foreground">{provider.description}</span></span>
                  {emailConnectProvider === provider.id ? <span className="text-xs text-muted-foreground">Opening…</span> : null}
                </Button>
              ))}
              <div className="flex items-center justify-between rounded-md border border-dashed border-border px-4 py-3 text-left opacity-60">
                <span><span className="block text-sm font-medium">Custom Email</span><span className="mt-0.5 block text-xs text-muted-foreground">IMAP/SMTP</span></span>
                <Badge variant="outline">Coming soon</Badge>
              </div>
            </div>
            {emailConnectError ? <p className="text-sm text-destructive" role="alert">{emailConnectError}</p> : null}
          </DialogContent>
        </Dialog>

        <header className="shrink-0 border-b border-border bg-card px-4 pt-4 sm:px-6 sm:pt-5">
          <PageHeader className="items-center">
            <PageHeaderContent>
              <PageHeaderTitle>Inbox</PageHeaderTitle>
              <PageHeaderDescription>
                {selectedChannel === "email" ? "Email inbox." : "Customer conversations."}
              </PageHeaderDescription>
            </PageHeaderContent>
            <PageHeaderActions>
            <Button variant="outline" size="sm" className="h-9 gap-2" onClick={() => setShowChannelPanel(true)}>
              <Filter className="h-4 w-4" />
              Manage channels
            </Button>
            </PageHeaderActions>
          </PageHeader>

          <div className="mt-4 flex gap-1 overflow-x-auto pb-0" role="tablist" aria-label="Inbox channels">
            {channels.map((channel) => {
              const Icon = channel.icon;
              const isActive = selectedChannel === channel.id;
              return (
                <button
                  key={channel.id}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  aria-disabled={channel.disabled}
                  onClick={() => {
                    if (channel.disabled) return;
                    setSelectedChannel(channel.id);
                    setSelectedConnectionId(null);
                    setSelectedConversationId(null);
                    setMobileConversationOpen(false);
                  }}
                  className={cn(
                    "inline-flex min-h-9 shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-sm font-medium transition-colors",
                    isActive
                      ? "border-foreground text-foreground"
                      : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
                    channel.disabled && "cursor-not-allowed opacity-45 hover:border-transparent hover:text-muted-foreground",
                  )}
                >
                  <Icon className={cn("h-4 w-4", channel.id === "whatsapp" && "text-status-success")} />
                  {channel.id === "all" ? "All conversations" : channel.name}
                  {channel.unreadCount > 0 ? (
                    <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[11px] tabular-nums text-foreground">
                      {channel.unreadCount}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </header>

        <div className="min-h-0 flex flex-1 overflow-hidden">

        <div
          className={cn(
            "min-h-0 shrink-0 flex-col border-r border-border bg-card",
            mobileConversationOpen ? "hidden md:flex" : "flex w-full",
            selectedChannel === "email"
              ? "md:w-[680px] lg:w-[760px]"
              : "md:w-[340px] lg:w-[380px]",
          )}
        >
          <div className="flex min-h-0 flex-1">
            {selectedChannel === "email" ? (
              <aside className="hidden w-40 shrink-0 flex-col border-r border-border bg-background/30 p-2 md:flex">
                <p className="px-2 py-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                  Mailbox
                </p>
                {[
                  { id: "all", label: "Inbox", count: liveConversations.filter((conversation) => conversation.channel === "email").length },
                  { id: "unread", label: "Unread", count: liveConversations.filter((conversation) => conversation.channel === "email" && conversation.unread).length },
                  { id: "starred", label: "Starred", count: liveConversations.filter((conversation) => conversation.channel === "email" && conversation.starred).length },
                ].map((folder) => (
                  <button
                    key={folder.id}
                    type="button"
                    onClick={() => {
                      setFilter(folder.id);
                      setSelectedConversationId(null);
                      setMobileConversationOpen(false);
                    }}
                    className={cn(
                      "flex items-center justify-between rounded-md px-2 py-2 text-left text-xs transition-colors",
                      filter === folder.id
                        ? "bg-secondary font-medium text-foreground"
                        : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                    )}
                  >
                    <span>{folder.label}</span>
                    {folder.count > 0 ? <span className="tabular-nums">{folder.count}</span> : null}
                  </button>
                ))}
                <div className="mt-4 border-t border-border pt-3">
                  <p className="px-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    Mailboxes
                  </p>
                  <div className="mt-2 space-y-1">
                    {emailConnectedConnections.map((connection) => (
                      <button
                        key={connection.id}
                        type="button"
                        onClick={() => {
                          setSelectedConnectionId(connection.id);
                          setSelectedConversationId(null);
                          setMobileConversationOpen(false);
                        }}
                        className={cn(
                          "w-full truncate rounded-md px-2 py-1.5 text-left text-[11px] text-muted-foreground hover:bg-secondary hover:text-foreground",
                          selectedConnectionId === connection.id && "bg-secondary text-foreground",
                        )}
                        title={connection.emailAddress}
                      >
                        {connection.emailAddress}
                      </button>
                    ))}
                  </div>
                </div>
              </aside>
            ) : null}
            <div className="flex min-w-0 flex-1 flex-col">
          <div className="border-b border-border p-3 sm:p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <p className="text-sm font-semibold text-foreground">
                {selectedChannel === "email" ? "Mail" : "Conversations"}
              </p>
              <span className="text-xs tabular-nums text-muted-foreground">
                {filteredConversations.length} {selectedChannel === "email" ? "messages" : "total"}
              </span>
            </div>

            {supportsConnectionFilter && selectedChannelConnected ? (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="mb-3 h-9 max-w-full gap-2 text-xs">
                    {(() => { const Icon = inboxChannelIcon(selectedChannel); return <Icon className={`h-3.5 w-3.5 ${inboxChannelIconClass(selectedChannel)}`} />; })()}
                    <span className="truncate">{selectedConnectionFilter?.label}</span>
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-56">
                  {activeConnectionFilters.map((connectionFilter) => (
                    <DropdownMenuItem
                      key={connectionFilter.id || "all"}
                      onClick={() => {
                        setSelectedConnectionId(connectionFilter.id);
                        setSelectedConversationId(null);
                        setMobileConversationOpen(false);
                      }}
                      className={cn(
                        "flex items-center justify-between gap-4",
                        selectedConnectionId === connectionFilter.id && "bg-secondary",
                      )}
                    >
                      <span className="truncate">{connectionFilter.label}</span>
                      <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                        {connectionFilter.conversationCount}
                      </span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}

            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder={selectedChannel === "email" ? "Search mail..." : "Search conversations..."}
                className="border-border bg-secondary pl-9"
              />
            </div>

            <div
              className={cn(
                "mt-3 flex items-center gap-1 overflow-x-auto",
                selectedChannel === "email" && "md:hidden",
              )}
              aria-label="Conversation filters"
            >
              {[
                { id: "all", label: selectedChannel === "email" ? "Inbox" : "All" },
                { id: "unread", label: "Unread" },
                { id: "starred", label: "Starred" },
              ].map((filterItem) => (
                <button
                  key={filterItem.id}
                  type="button"
                  onClick={() => {
                    setFilter(filterItem.id);
                    setSelectedConversationId(null);
                    setMobileConversationOpen(false);
                  }}
                  className={cn(
                    "flex min-h-9 shrink-0 items-center rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
                    filter === filterItem.id
                      ? "bg-secondary text-foreground"
                      : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                  )}
                >
                  {filterItem.label}
                </button>
              ))}
            </div>
          </div>

          <ScrollArea className="min-h-0 flex-1">
            <div className="p-2">
              {supportsConnectionFilter && !selectedChannelConnected ? (
                <div className="flex flex-col items-center justify-center py-14 text-center">
                  <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
                    {(() => { const Icon = inboxChannelIcon(selectedChannel); return <Icon className={`h-6 w-6 ${inboxChannelIconClass(selectedChannel)}`} />; })()}
                  </div>
                  <p className="text-sm text-foreground">
                    Connect {selectedChannel === "facebook" ? "Facebook" : selectedChannel} to start using inbox
                  </p>
                </div>
              ) : filteredConversations.length === 0 ? (
                <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
                  <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
                    {(() => { const Icon = inboxChannelIcon(selectedChannel); return <Icon className={`h-6 w-6 ${inboxChannelIconClass(selectedChannel)}`} />; })()}
                  </div>
                  <p className="text-sm text-foreground">{emptyConversationCopy.title}</p>
                  <p className="mt-1 max-w-[260px] text-xs leading-5 text-muted-foreground">
                    {emptyConversationCopy.description}
                  </p>
                  {selectedChannel === "email" && !selectedChannelConnected ? (
                    <Button variant="outline" size="sm" className="mt-4" onClick={() => setShowEmailConnectDialog(true)}>
                      Connect email
                    </Button>
                  ) : null}
                  {selectedChannelConversationCount === 0 &&
                  (selectedChannel === "instagram" || selectedChannel === "facebook") ? (
                    <Button asChild variant="outline" size="sm" className="mt-4">
                      <Link href="/connections">Manage connections</Link>
                    </Button>
                  ) : null}
                </div>
              ) : (
                filteredConversations.map((conversation) => {
                  const channelInfo = channels.find((channel) => channel.id === conversation.channel) ?? channels[0];
                  const ConversationChannelIcon = channelInfo.icon;

                  if (conversation.channel === "email") {
                    return (
                      <div
                        key={conversation.id}
                        className={cn(
                          "group flex w-full items-center gap-2 border-b border-border/70 px-2.5 py-2 text-left transition-colors",
                          selectedConversation?.id === conversation.id
                            ? "bg-primary/10"
                            : "hover:bg-secondary/70",
                        )}
                      >
                        <span className="h-4 w-4 shrink-0 rounded border border-muted-foreground/50" />
                        <span
                          aria-hidden="true"
                          className="shrink-0 rounded p-1 text-muted-foreground"
                        >
                          <Star className={cn("h-4 w-4", conversation.starred && "fill-primary text-primary")} />
                        </span>
                        <button
                          type="button"
                          onClick={() => openConversation(conversation.id)}
                          className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        >
                          <span
                            className={cn(
                              "w-[30%] min-w-[110px] truncate text-sm",
                              conversation.unread ? "font-semibold text-foreground" : "text-foreground",
                            )}
                          >
                            {conversation.emailFrom || conversation.name}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-sm">
                            <span className={conversation.unread ? "font-semibold text-foreground" : "text-foreground"}>
                              {conversation.emailSubject || "(no subject)"}
                            </span>
                            <span className="text-muted-foreground"> — {conversation.lastMessage}</span>
                          </span>
                          <span className="shrink-0 text-[11px] text-muted-foreground">
                            {formatConversationTime(conversation.time)}
                          </span>
                        </button>
                      </div>
                    );
                  }

                  return (
                    <div
                      key={conversation.id}
                      className={cn(
                        "mb-1 flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-all duration-200",
                        selectedConversation?.id === conversation.id
                          ? "border-primary/20 bg-primary/10"
                          : "border-transparent hover:bg-secondary",
                      )}
                    >
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            className="relative shrink-0 rounded-full outline-none ring-offset-background transition-transform hover:scale-[1.02] focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                            aria-label={`View quick contact info for ${conversation.name}`}
                          >
                            <Avatar className="h-10 w-10 bg-secondary">
                              <AvatarFallback className="bg-secondary text-sm text-foreground">
                                {conversation.avatar}
                              </AvatarFallback>
                            </Avatar>
                            <div
                              className={cn(
                                "absolute -bottom-0.5 -right-0.5 rounded-full p-0.5",
                                channelInfo.bgColor,
                              )}
                            >
                              <ConversationChannelIcon className={cn("h-3 w-3", channelInfo.color)} />
                            </div>
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="start"
                          side="right"
                          className="w-72 rounded-xl border border-border bg-card p-0"
                        >
                          <div className="border-b border-border px-4 py-3">
                            <div className="flex items-start gap-3">
                              <Avatar className="h-11 w-11 bg-secondary">
                                <AvatarFallback className="bg-secondary text-sm text-foreground">
                                  {conversation.avatar}
                                </AvatarFallback>
                              </Avatar>
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-semibold text-foreground">
                                  {conversation.name}
                                </p>
                                <p className="truncate text-xs text-muted-foreground">
                                  {conversation.handle}
                                </p>
                                <div className="mt-2 flex flex-wrap gap-2">
                                  {conversation.unread ? (
                                    <Badge className="border-0 bg-primary/10 text-[10px] text-primary">
                                      Unread
                                    </Badge>
                                  ) : null}
                                  {conversation.starred ? (
                                    <Badge className="border-0 bg-status-attention-soft text-[10px] text-status-attention">
                                      Starred
                                    </Badge>
                                  ) : null}
                                  <Badge className="border-0 bg-secondary text-[10px] text-muted-foreground">
                                    {channelInfo.name}
                                  </Badge>
                                </div>
                              </div>
                            </div>
                          </div>

                          <div className="space-y-3 px-4 py-3">
                            <div>
                              <p className="mb-1 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                                {conversation.channel === "whatsapp" ? "Phone" : "Customer ID"}
                              </p>
                              <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
                                <Phone className="h-4 w-4 text-muted-foreground" />
                                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                                  {conversation.handle}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => void copyConversationPhone(conversation.id, conversation.handle)}
                                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                                >
                                  {copiedConversationId === conversation.id ? (
                                    <>
                                      <Check className="h-3.5 w-3.5 text-primary" />
                                      Copied
                                    </>
                                  ) : (
                                    <>
                                      <Copy className="h-3.5 w-3.5" />
                                      Copy
                                    </>
                                  )}
                                </button>
                              </div>
                            </div>

                            <div>
                              <p className="mb-1 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                                Connected account
                              </p>
                              <p className="truncate text-sm text-foreground">
                                {conversation.connectionLabel}
                              </p>
                            </div>

                            <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
                              <span>Last activity</span>
                              <span className="shrink-0">{formatConversationTime(conversation.time)}</span>
                            </div>
                          </div>
                        </DropdownMenuContent>
                      </DropdownMenu>

                      <button
                        type="button"
                        onClick={() => openConversation(conversation.id)}
                        className="flex min-w-0 flex-1 items-start gap-3 text-left"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="mb-0.5 flex min-w-0 items-start gap-2">
                            <span
                              title={conversation.name}
                              className={cn(
                                "min-w-0 flex-1 truncate text-sm",
                                conversation.unread ? "font-semibold text-foreground" : "text-foreground",
                              )}
                            >
                              {conversation.name}
                            </span>
                            <span className="shrink-0 pt-0.5 text-xs text-muted-foreground">
                              {formatConversationTime(conversation.time)}
                            </span>
                          </div>
                          <p className="mb-1 truncate text-xs text-muted-foreground">
                            {conversation.handle}
                            {(conversation.channel === "whatsapp"
                              ? whatsappConnections.length
                              : conversation.channel === "instagram"
                                ? metaConnections.instagram.length
                                : metaConnections.facebook.length) > 1
                              ? ` · ${conversation.connectionLabel}`
                              : ""}
                          </p>
                          {activeCallsByConversationId[conversation.id] ? (
                            <div className="mb-1">
                              <Badge className="border-0 bg-status-info-soft text-[10px] text-status-info">
                                {activeCallsByConversationId[conversation.id].status === "RINGING"
                                  ? "Incoming call"
                                  : activeCallsByConversationId[conversation.id].status === "ACTIVE"
                                    ? "On call"
                                    : formatCallStatus(activeCallsByConversationId[conversation.id].status)}
                              </Badge>
                            </div>
                          ) : null}
                          <p
                            className={cn(
                              "truncate text-sm",
                              conversation.unread ? "text-foreground" : "text-muted-foreground",
                            )}
                          >
                            <EmojiText value={conversation.lastMessage} />
                          </p>
                        </div>
                        {conversation.unread ? (
                          <div className="mt-2 h-2 w-2 shrink-0 rounded-full bg-primary" />
                        ) : null}
                      </button>
                    </div>
                  );
                })
              )}
            </div>
          </ScrollArea>
            </div>
          </div>
        </div>

        <div
          className={cn(
            "min-h-0 flex flex-1 flex-col bg-background",
            mobileConversationOpen ? "flex" : "hidden md:flex",
          )}
        >
          <div
            className={cn(
              "flex h-16 items-center justify-between gap-2 border-b border-border bg-card px-3 sm:px-6",
              !selectedConversation && "hidden",
            )}
          >
            {selectedConversation ? (
              <>
                <div className="flex min-w-0 items-center gap-2 sm:gap-3">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 shrink-0 text-muted-foreground md:hidden"
                    onClick={() => setMobileConversationOpen(false)}
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </Button>
                  <div className="relative shrink-0">
                    <Avatar className="h-10 w-10 bg-secondary">
                      <AvatarFallback className="bg-secondary text-foreground">
                        {selectedConversation.avatar}
                      </AvatarFallback>
                    </Avatar>
                    <div
                      className={cn(
                        "absolute -bottom-0.5 -right-0.5 rounded-full p-0.5",
                        currentChannel.bgColor,
                      )}
                    >
                      <ChannelIcon className={cn("h-3 w-3", currentChannel.color)} />
                    </div>
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="truncate text-sm font-semibold text-foreground">
                        {selectedConversation.channel === "email"
                          ? selectedConversation.emailSubject || "(no subject)"
                          : selectedConversation.name}
                      </h2>
                      <Badge
                        variant="outline"
                        className={cn(
                          "hidden border-0 px-1.5 py-0 text-[10px] sm:inline-flex",
                          currentChannel.bgColor,
                          currentChannel.color,
                        )}
                      >
                        {currentChannel.name}
                      </Badge>
                    </div>
                    <p className="truncate text-xs text-muted-foreground">
                      <span>
                        {selectedConversation.channel === "email"
                          ? selectedConversation.emailFrom || selectedConversation.handle
                          : selectedConversation.handle}
                      </span>
                      {selectedConversation.channel === "email" ? (
                        <span className="ml-2">{selectedConversation.connectionLabel}</span>
                      ) : null}
                      {selectedConversation.status === "online" ? (
                        <span className="ml-1 hidden items-center gap-1 text-status-success sm:inline-flex">
                          <span className="v-live-dot h-1.5 w-1.5" />
                          Online
                        </span>
                      ) : null}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon" className="hidden h-9 w-9 text-muted-foreground sm:inline-flex">
                        <Tag className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Add Tag</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-9 w-9 text-muted-foreground"
                        onClick={() => void toggleConversationStar()}
                      >
                        <Star
                          className={cn(
                            "h-4 w-4",
                            selectedConversation.starred && "fill-primary text-primary",
                          )}
                        />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Star Conversation</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon" className="hidden h-9 w-9 text-muted-foreground sm:inline-flex">
                        <Archive className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Archive</TooltipContent>
                  </Tooltip>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-9 w-9 text-muted-foreground">
                        <MoreVertical className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-48">
                      <DropdownMenuItem>
                        <Users className="mr-2 h-4 w-4" />
                        View Contact
                      </DropdownMenuItem>
                      <DropdownMenuItem>
                        <Tag className="mr-2 h-4 w-4" />
                        Manage Tags
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-destructive focus:text-destructive"
                        onClick={() => void deleteSelectedConversation()}
                      >
                        <Trash2 className="mr-2 h-4 w-4" />
                        Delete Conversation
                      </DropdownMenuItem>
                      <DropdownMenuItem className="text-destructive">
                        Block Contact
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </>
            ) : null}
          </div>

          {latestIncomingCall && !selectedConversationCall ? (
            <div className="border-b border-border bg-card/90 px-3 py-3 sm:px-6">
              <div className="mx-auto flex max-w-3xl flex-col gap-3 rounded-2xl border border-status-info/20 bg-status-info-soft/40 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-foreground">Incoming WhatsApp call</p>
                  <p className="mt-1 truncate text-sm text-muted-foreground">
                    {latestIncomingCall.conversationCustomerName || latestIncomingCall.fromPhone}
                    {latestIncomingCall.connectionLabel ? ` via ${latestIncomingCall.connectionLabel}` : ""}
                  </p>
                </div>
                <div className="grid gap-2 sm:flex sm:flex-wrap">
                  <Button
                    variant="outline"
                    className="w-full sm:w-auto"
                    disabled={callActionLoading !== null}
                    onClick={() => void applyCallAction(latestIncomingCall.id, "reject")}
                  >
                    Decline
                  </Button>
                  <Button
                    className="w-full sm:w-auto"
                    disabled={callActionLoading !== null}
                    onClick={() => {
                      if (latestIncomingCall.conversationId) {
                        setSelectedConversationId(latestIncomingCall.conversationId);
                        setMobileConversationOpen(true);
                      }
                      void applyCallAction(latestIncomingCall.id, "accept");
                    }}
                  >
                    Answer
                  </Button>
                </div>
              </div>
            </div>
          ) : null}

          <ScrollArea className="min-h-0 flex-1">
            <div className="p-3 sm:p-6">
            {selectedConversation ? (
            <div className="mx-auto max-w-3xl space-y-4">
              {selectedConversationCall ? (
                <div className="rounded-2xl border border-status-info/20 bg-status-info-soft/40 p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-status-info-soft text-status-info">
                          <Phone className="h-4 w-4" />
                        </div>
                        <div>
                          <p className="text-sm font-semibold text-foreground">
                            {selectedConversationCall.status === "RINGING"
                              ? "Incoming WhatsApp call"
                              : selectedConversationCall.status === "ACTIVE"
                                ? "WhatsApp call in progress"
                                : `Call ${formatCallStatus(selectedConversationCall.status)}`}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">
                            {selectedConversationCall.connectionLabel || selectedConversationCall.toPhone}
                          </p>
                        </div>
                      </div>
                    </div>
                    <div className="grid gap-2 sm:flex sm:flex-wrap">
                      {selectedConversationCall.status === "RINGING" ? (
                        <>
                          <Button
                            variant="outline"
                            className="w-full sm:w-auto"
                            disabled={callActionLoading !== null}
                            onClick={() => void applyCallAction(selectedConversationCall.id, "reject")}
                          >
                            Decline
                          </Button>
                          <Button
                            className="w-full sm:w-auto"
                            disabled={callActionLoading !== null}
                            onClick={() => void applyCallAction(selectedConversationCall.id, "accept")}
                          >
                            Answer
                          </Button>
                        </>
                      ) : null}
                      {selectedConversationCall.status === "ACTIVE" ? (
                        <Button
                          variant="destructive"
                          className="w-full sm:w-auto"
                          disabled={callActionLoading !== null}
                          onClick={() => void applyCallAction(selectedConversationCall.id, "end")}
                        >
                          End call
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  {latestSelectedCallSignal ? (
                    <div className="mt-3 rounded-xl border border-border/60 bg-background/40 px-3 py-2 text-xs text-muted-foreground">
                      Latest signal:{" "}
                      <span className="font-medium text-foreground">
                        {latestSelectedCallSignal.payload?.kind || latestSelectedCallSignal.eventType}
                      </span>
                      {latestSelectedCallSignal.payload?.source
                        ? ` from ${latestSelectedCallSignal.payload.source}`
                        : ""}
                    </div>
                  ) : null}
                  {selectedCallMediaSession?.provider ? (
                    <div className="mt-2 rounded-xl border border-border/60 bg-background/40 px-3 py-2 text-xs text-muted-foreground">
                      Media provider:{" "}
                      <span className="font-medium text-foreground">{selectedCallMediaSession.provider}</span>
                      {selectedCallMediaStateLabel(callMediaState, callMediaLoading === selectedConversationCall.id)
                        ? ` • ${selectedCallMediaStateLabel(callMediaState, callMediaLoading === selectedConversationCall.id)}`
                        : ""}
                    </div>
                  ) : null}
                  {callMediaError ? (
                    <div className="mt-2 rounded-lg border border-destructive/30 bg-status-danger-soft px-3 py-2 text-xs text-destructive">
                      {callMediaError}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {callError ? (
                <div className="rounded-lg border border-destructive/30 bg-status-danger-soft px-3 py-2 text-xs text-destructive">
                  {callError}
                </div>
              ) : null}

              {conversationCallHistory.length > 0 ? (
                <details className="rounded-lg border border-border bg-card [&_summary::-webkit-details-marker]:hidden">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3">
                    <div>
                      <p className="text-sm font-semibold text-foreground">Recent calls</p>
                      <p className="text-xs text-muted-foreground">WhatsApp call activity for this conversation</p>
                    </div>
                    <Badge variant="outline" className="text-[10px]">
                      {conversationCallHistory.length} recent
                    </Badge>
                  </summary>
                  <div className="space-y-2 border-t border-border px-4 py-3">
                    {conversationCallHistory.map((call) => {
                      const duration = formatCallDuration(call.answeredAt, call.endedAt);
                      return (
                        <div
                          key={call.id}
                          className="flex flex-col gap-1 rounded-xl border border-border/60 bg-secondary/20 px-3 py-2 sm:flex-row sm:items-center sm:justify-between"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-2">
                              <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
                                {call.direction}
                              </Badge>
                              <span className="text-sm font-medium capitalize text-foreground">
                                {formatCallStatus(call.status)}
                              </span>
                            </div>
                            <p className="mt-1 truncate text-xs text-muted-foreground">
                              {formatCallTimestamp(call.endedAt || call.answeredAt || call.startedAt)}
                            </p>
                          </div>
                          <div className="text-xs text-muted-foreground">
                            {duration ? `Duration ${duration}` : call.fromPhone || call.toPhone}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </details>
              ) : null}

              <div className="flex items-center gap-4 py-2">
                <div className="h-px flex-1 bg-border" />
                <span className="text-xs text-muted-foreground">Today</span>
                <div className="h-px flex-1 bg-border" />
              </div>

              {messagesLoading && renderedMessages.length === 0 ? (
                <InboxMessagesSkeleton />
              ) : renderedMessages.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">No messages yet.</div>
              ) : (
                renderedMessages.map((message) => {
                  const stickerOnly = isStickerOnlyMessage(message);

                  return (
                  <motion.div
                  key={message.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={cn(
                    "flex",
                    selectedConversation?.channel === "email"
                      ? "justify-start"
                      : message.sender === "customer"
                        ? "justify-start"
                        : "justify-end",
                  )}
                >
                  <div
                    className={cn(
                      "group relative text-foreground",
                      selectedConversation?.channel === "email"
                        ? "w-full rounded-xl border border-border bg-card p-4"
                        : stickerOnly
                        ? "p-0"
                        : cn(
                            "rounded-lg p-3",
                            message.sender === "customer"
                              ? "bg-secondary"
                              : "border border-primary/20 bg-primary/10",
                          ),
                    )}
                  >
                    {selectedConversation?.channel === "email" ? (
                      <div className="mb-3 flex items-start gap-3 border-b border-border/70 pb-3">
                        <Avatar className="h-8 w-8 shrink-0 bg-secondary">
                          <AvatarFallback className="bg-secondary text-xs text-foreground">
                            {message.sender === "customer"
                              ? selectedConversation.avatar
                              : "ME"}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-foreground">
                            {message.sender === "customer"
                              ? selectedConversation.emailFrom || selectedConversation.name
                              : "You"}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">
                            {message.sender === "customer"
                              ? "to " + selectedConversation.connectionLabel
                              : "from " + selectedConversation.connectionLabel}
                            <span className="mx-1.5">·</span>
                            {message.time}
                          </p>
                        </div>
                      </div>
                    ) : null}
                    <div className="absolute -top-2 right-2 opacity-0 transition-opacity group-hover:opacity-100">
                      <div className="flex items-center gap-0.5 rounded-md border border-border bg-card p-0.5 shadow-lg">
                        <Button
                          ref={(node) => {
                            reactionTriggerRefs.current[message.id] = node;
                          }}
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => toggleReactionPicker(message.id)}
                        >
                          <Smile className="h-3 w-3" />
                        </Button>
                        <DropdownMenu
                          open={openActionsMessageId === message.id}
                          onOpenChange={(open) => setOpenActionsMessageId(open ? message.id : null)}
                        >
                          <DropdownMenuTrigger asChild>
                            <Button variant="ghost" size="icon" className="h-6 w-6">
                              <MoreHorizontal className="h-3 w-3" />
                            </Button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end" className="w-40">
                            <DropdownMenuItem
                              disabled={!message.canReply || !selectedConversationCapabilities.reply}
                              onClick={() =>
                                setReplyDraft({
                                  messageId: message.id,
                                  text: getMessageDisplayText(message).slice(0, 120),
                                })
                              }
                            >
                              Reply
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={!message.canReact || !selectedConversationCapabilities.reaction}
                              onClick={() => toggleReactionPicker(message.id)}
                            >
                              React
                            </DropdownMenuItem>
                            {selectedConversationCapabilities.providerDelete ? (
                              <>
                                <DropdownMenuSeparator />
                                <DropdownMenuItem onClick={() => void deleteMessage(message.id)}>
                                  Delete
                                </DropdownMenuItem>
                              </>
                            ) : null}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>
                    <DashboardMessageContent
                      message={message}
                      replyTargetMessage={
                        message.reference?.messageId
                          ? selectedMessages.find(
                              (candidate) => candidate.id === message.reference?.messageId,
                            ) || null
                          : null
                      }
                      contactLabel={selectedConversation?.handle || selectedConversation?.name || "Contact"}
                      channel={selectedConversation?.channel || "whatsapp"}
                      onOpenMedia={(url, kind, caption) => setLightbox({ url, kind, caption })}
                    />
                    <div className={cn("space-y-1", stickerOnly ? "mt-0.5" : "mt-1.5")}>
                      {message.status === "failed" && message.errorMessage ? (
                        <div className="flex max-w-[240px] flex-col items-end gap-1">
                          <p className="text-right text-[10px] leading-snug text-destructive">
                            {message.errorMessage}
                          </p>
                          {message.sender !== "customer" &&
                          message.contentType === "TEXT" &&
                          selectedConversation?.channel !== "whatsapp" ? (
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-6 gap-1 px-2 text-[10px] text-destructive hover:text-destructive"
                              disabled={retryingMessageId !== null}
                              onClick={() => void retryMessage(message)}
                            >
                              <RotateCcw
                                className={cn(
                                  "h-3 w-3",
                                  retryingMessageId === message.id && "animate-spin",
                                )}
                              />
                              {retryingMessageId === message.id ? "Retrying" : "Retry"}
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                      <div className="flex items-center justify-end gap-1.5">
                        {reactionDisplayByMessageId[message.id] ? (
                          <button
                            type="button"
                            className={cn(
                              "mr-auto inline-flex items-center gap-1 rounded-full border border-border/60 bg-card/70 px-2 py-0.5 text-xs",
                              (
                                selfReactionOverridesByMessageId[message.id] ??
                                persistedSelfReactionsByMessageId[message.id]
                              )?.trim() && message.canReact && selectedConversationCapabilities.reaction
                                ? "cursor-pointer hover:bg-card"
                                : "cursor-default",
                            )}
                            onClick={() => {
                              if (
                                !(
                                  (
                                    selfReactionOverridesByMessageId[message.id] ??
                                    persistedSelfReactionsByMessageId[message.id]
                                    )?.trim() && message.canReact && selectedConversationCapabilities.reaction
                                )
                              ) {
                                return;
                              }
                              void sendReaction(message.id, "", true);
                            }}
                          >
                            <EmojiText value={reactionDisplayByMessageId[message.id].emojis.join(" ")} />
                            {reactionDisplayByMessageId[message.id].total > 1 ? (
                              <span className="text-[11px] text-muted-foreground">
                                {reactionDisplayByMessageId[message.id].total}
                              </span>
                            ) : null}
                          </button>
                        ) : null}
                        <span className="text-[10px] text-muted-foreground">
                          {message.time}
                        </span>
                        {message.sender !== "customer" ? renderOutgoingMessageState(message.status) : null}
                      </div>
                    </div>
                  </div>
                </motion.div>
                  );
                })
              )}
              <div ref={messagesEndRef} />
            </div>
            ) : (
              <div className="flex min-h-full items-center justify-center px-6 py-16 text-center">
                <div className="max-w-xs">
                  <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full border border-border bg-secondary/60">
                    <MessageCircle className="h-6 w-6 text-muted-foreground" />
                  </div>
                  <p className="text-sm font-medium text-foreground">Select a conversation</p>
                  <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
                    Choose a conversation from the list to view messages and reply.
                  </p>
                </div>
              </div>
            )}
            </div>
          </ScrollArea>
          {reactionPicker ? (
            <div
              ref={reactionPickerRef}
              className="fixed z-[var(--z-popover)] overflow-hidden rounded-xl border border-border/70 shadow-[var(--shadow-floating)]"
              style={{ top: reactionPicker.top, left: reactionPicker.left }}
            >
              <Picker
                data={emojiData}
                previewPosition="none"
                theme={emojiTheme}
                perLine={9}
                maxFrequentRows={1}
                onEmojiSelect={(payload: { native?: string }) => {
                  void sendReaction(reactionPicker.messageId, payload.native || "");
                }}
              />
            </div>
          ) : null}
          {lightbox ? (
            <MediaLightbox
              url={lightbox.url}
              kind={lightbox.kind}
              caption={lightbox.caption}
              onClose={() => setLightbox(null)}
            />
          ) : null}

          {selectedConversation ? (
          <div className="border-t border-border bg-card p-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] sm:p-4">
            <div className="mx-auto max-w-3xl">
              {composerError ? (
                <div className="mb-3 rounded-lg border border-destructive/30 bg-status-danger-soft px-3 py-2 text-xs text-destructive">
                  {composerError}
                </div>
              ) : null}
              {callsLoading ? (
                <div className="mb-3 rounded-lg border border-border bg-secondary/30 px-3 py-2 text-xs text-muted-foreground">
                  Loading call sessions...
                </div>
              ) : null}
              {replyDraft ? (
                <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">
                  <span className="truncate">Replying to: {replyDraft.text}</span>
                  <button type="button" onClick={() => setReplyDraft(null)} className="text-foreground">
                    Cancel
                  </button>
                </div>
              ) : null}
              {selectedFile ? (
                <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-border bg-secondary/40 px-3 py-2 text-xs text-muted-foreground">
                  <span className="truncate">Attached: {selectedFile.name}</span>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedFile(null);
                      if (fileInputRef.current) fileInputRef.current.value = "";
                    }}
                    className="text-foreground"
                  >
                    Remove
                  </button>
                </div>
              ) : null}
              <div className="mb-3 flex items-center gap-2">
                <Button variant="ghost" size="sm" className="hidden h-7 gap-1.5 text-xs text-muted-foreground sm:inline-flex">
                  <Clock className="h-3 w-3" />
                  Schedule
                </Button>
                <div className="flex-1" />
                <Badge
                  variant="outline"
                  className={cn(
                    "h-5 border-0 text-[10px]",
                    currentChannel.bgColor,
                    currentChannel.color,
                  )}
                >
                  Replying via {currentChannel.name}
                </Badge>
              </div>
              <div className="flex items-end gap-2 rounded-lg bg-secondary p-1">
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  onChange={(event) => setSelectedFile(event.target.files?.[0] || null)}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 shrink-0 text-muted-foreground hover:text-foreground"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={!Object.values(selectedConversationCapabilities.attachments).some(Boolean)}
                  title={
                    Object.values(selectedConversationCapabilities.attachments).some(Boolean)
                      ? "Attach a file"
                      : "Attachments are not available for this channel yet"
                  }
                >
                  <Paperclip className="h-4 w-4" />
                </Button>
                <Textarea
                  ref={composerInputRef}
                  placeholder={selectedConversation ? `Message ${selectedConversation.name}...` : "Type a message"}
                  value={messageInput}
                  onChange={(event) => setMessageInput(event.target.value)}
                  rows={1}
                  className="min-h-10 max-h-40 flex-1 resize-none border-0 bg-transparent px-3 py-2 text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-9 w-9 shrink-0 text-muted-foreground hover:text-foreground"
                  onClick={() => setShowEmojiPicker((current) => !current)}
                >
                  <Smile className="h-4 w-4" />
                </Button>
                {showEmojiPicker ? (
                  <div
                    ref={emojiPickerRef}
                    className="absolute bottom-[calc(100%+10px)] right-14 z-[var(--z-popover)] overflow-hidden rounded-xl border border-border/70 shadow-[var(--shadow-floating)]"
                  >
                    <Picker
                      data={emojiData}
                      previewPosition="none"
                      theme={emojiTheme}
                      perLine={9}
                      maxFrequentRows={1}
                      onEmojiSelect={(payload: { native?: string }) => {
                        insertEmojiAtCursor(payload.native || "");
                      }}
                    />
                  </div>
                ) : null}
                <Button
                  size="icon"
                  className="h-9 w-9 shrink-0 bg-primary text-primary-foreground hover:bg-primary/90"
                  onClick={() => void sendMessage()}
                  disabled={composerLoading || (!messageInput.trim() && !selectedFile)}
                >
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
          ) : null}
        </div>
        </div>
        <audio ref={remoteAudioRef} autoPlay playsInline className="hidden" />
      </div>
    </TooltipProvider>
  );
}

function selectedCallMediaStateLabel(
  state: "idle" | "requesting" | "connecting" | "connected" | "failed",
  loading: boolean,
) {
  if (loading) return "setting up media";
  if (state === "requesting") return "requesting microphone";
  if (state === "connecting") return "connecting audio";
  if (state === "connected") return "audio connected";
  if (state === "failed") return "media failed";
  return "";
}

function DashboardMessageContent({
  message,
  replyTargetMessage,
  contactLabel,
  channel,
  onOpenMedia,
}: {
  message: ConversationMessage;
  replyTargetMessage: ConversationMessage | null;
  contactLabel: string;
  channel: InboxConversation["channel"];
  onOpenMedia: (url: string, kind: MessageAttachmentKind, caption?: string | null) => void;
}) {
  const previewText = getMessageDisplayText(message);
  const replyPreview = message.reference?.previewText || null;
  const attachments = message.attachments || [];

  const replyCard = replyPreview ? (
    <ReplyPreviewCard
      message={replyTargetMessage}
      fallbackPreview={replyPreview}
      contactLabel={contactLabel}
    />
  ) : null;

  if (!attachments.length) {
    return (
      <div className="space-y-2">
        {replyCard}
        <p className="whitespace-pre-wrap text-sm leading-relaxed"><EmojiText value={previewText} /></p>
      </div>
    );
  }

  const caption = getMeaningfulMessageContent(message) || null;

  return (
    <div className="space-y-2">
      {replyCard}
      {attachments.map((attachment) => (
        <MessageAttachmentContent
          key={attachment.id}
          message={message}
          attachment={attachment}
          channel={channel}
          caption={caption}
          onOpenMedia={onOpenMedia}
        />
      ))}
      {caption ? <p className="whitespace-pre-wrap text-sm leading-relaxed"><EmojiText value={caption} /></p> : null}
    </div>
  );
}

function MessageAttachmentContent({
  message,
  attachment,
  channel,
  caption,
  onOpenMedia,
}: {
  message: ConversationMessage;
  attachment: MessageAttachment;
  channel: InboxConversation["channel"];
  caption: string | null;
  onOpenMedia: (url: string, kind: MessageAttachmentKind, caption?: string | null) => void;
}) {
  const [mediaFailed, setMediaFailed] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const mediaUrl =
    channel === "whatsapp"
      ? apiUrl(`/api/whatsapp/inbox/media/${message.id}/attachments/${attachment.id}`)
      : apiUrl(`/api/inbox/messages/${message.id}/attachments/${attachment.id}`);
  const sticker = isStickerAttachment(attachment);

  if (mediaFailed) {
    return (
      <div className="space-y-2">
        <div className="rounded-md border border-border/60 bg-card/40 px-3 py-2 text-xs text-muted-foreground">
          Media preview unavailable.
        </div>
        <div className="flex flex-wrap gap-2">
          <a href={mediaUrl} target="_blank" rel="noreferrer" className="inline-flex rounded-md border border-border/60 px-3 py-2 text-sm text-foreground no-underline">
            {`Open ${getMediaLabel(sticker ? "sticker" : attachment.kind)}`}
          </a>
          <button type="button" onClick={() => { setMediaFailed(false); setReloadToken((current) => current + 1); }} className="inline-flex rounded-md border border-border/60 px-3 py-2 text-sm text-foreground">
            Retry preview
          </button>
        </div>
      </div>
    );
  }

  if (sticker) {
    return (
      // Meta may return a transparent sticker asset or a flattened preview.
      // Render the provider response unchanged; altering its pixels damages
      // anti-aliased artwork and cannot restore animation data.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        key={`sticker-${reloadToken}`}
        src={mediaUrl}
        alt={attachment.fileName || "sticker"}
        className="block h-32 w-32 cursor-zoom-in object-contain"
        onError={() => setMediaFailed(true)}
        onClick={() => onOpenMedia(mediaUrl, "sticker", caption)}
      />
    );
  }

  if (attachment.kind === "image") {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img key={`image-${reloadToken}`} src={mediaUrl} alt={caption || attachment.fileName || "attachment"} className="max-h-72 w-full max-w-sm cursor-zoom-in rounded-md border border-border/60 object-contain" onError={() => setMediaFailed(true)} onClick={() => onOpenMedia(mediaUrl, attachment.kind, caption)} />
    );
  }

  if (attachment.kind === "video") {
    return <video key={`video-${reloadToken}`} controls className="max-h-72 w-full max-w-sm cursor-zoom-in rounded-md border border-border/60" src={mediaUrl} onError={() => setMediaFailed(true)} onClick={() => onOpenMedia(mediaUrl, attachment.kind, caption)} />;
  }

  if (attachment.kind === "audio") {
    return <audio key={`audio-${reloadToken}`} controls className="w-full max-w-sm" src={mediaUrl} onError={() => setMediaFailed(true)} />;
  }

  return (
    <a href={mediaUrl} onClick={(event) => { event.preventDefault(); onOpenMedia(mediaUrl, attachment.kind, caption); }} className="inline-flex w-fit rounded-md border border-border/60 px-3 py-2 text-sm text-foreground no-underline">
      {`Open ${attachment.fileName || getMediaLabel(attachment.kind)}`}
    </a>
  );
}

function ReplyPreviewCard({
  message,
  fallbackPreview,
  contactLabel,
}: {
  message: ConversationMessage | null;
  fallbackPreview: string;
  contactLabel: string;
}) {
  const attachment = message ? getMessageAttachment(message) : null;
  const label = message?.sender === "bot" ? "You" : contactLabel;
  const displayText = message ? getMessageDisplayText(message) : fallbackPreview;
  const replyPreviewText = attachment ? getReplyPreviewText(attachment, displayText) : displayText;

  return (
    <div className="flex overflow-hidden rounded-md bg-secondary">
      <div className="w-1 shrink-0 bg-primary" />
      <div className="min-w-0 flex-1 px-3 py-2">
        <p className="truncate text-[11px] font-medium text-primary">{label}</p>
        {attachment ? (
          <div className="mt-0.5 flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                {renderReplyPreviewIcon(attachment.kind)}
                <p className="truncate text-xs text-muted-foreground">
                  <EmojiText value={replyPreviewText} />
                </p>
              </div>
            </div>
          </div>
        ) : (
          <p className="truncate text-xs text-muted-foreground"><EmojiText value={displayText} /></p>
        )}
      </div>
    </div>
  );
}

function renderOutgoingMessageState(status?: ConversationMessage["status"]) {
  if (!status) return null;

  if (status === "pending") {
    return <Clock className="h-3 w-3 text-muted-foreground" />;
  }

  if (status === "failed" || status === "BLOCKED") {
    return <span className="text-[10px] text-destructive">Failed</span>;
  }

  if (status === "SENT") {
    return (
      <span className="translate-y-[0.5px] text-[13px] font-semibold leading-none tracking-[-0.08em] text-muted-foreground">
        ✓
      </span>
    );
  }

  if (status === "DELIVERED") {
    return (
      <span className="translate-y-[0.5px] text-[13px] font-semibold leading-none tracking-[-0.14em] text-muted-foreground">
        ✓✓
      </span>
    );
  }

  if (status === "READ") {
    return (
      <span className="translate-y-[0.5px] text-[13px] font-semibold leading-none tracking-[-0.14em] text-sky-400">
        ✓✓
      </span>
    );
  }

  return null;
}

function normalizeRealtimeStatus(
  status?: "PROCESSING" | "SENT" | "DELIVERED" | "READ" | "FAILED" | "BLOCKED",
): ConversationMessage["status"] {
  if (!status) return undefined;
  if (status === "PROCESSING") return "pending";
  return status === "FAILED" ? "failed" : status;
}

function calculateReactionPickerPosition(
  messageId: string,
  trigger: HTMLElement,
): ReactionPickerState {
  const rect = trigger.getBoundingClientRect();
  const pickerWidth = 352;
  const pickerHeight = 435;
  const gutter = 8;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  const spaceBelow = viewportHeight - rect.bottom;
  const spaceAbove = rect.top;
  const spaceRight = viewportWidth - rect.left;
  const spaceLeft = rect.right;

  let top =
    spaceBelow < pickerHeight && spaceAbove > spaceBelow
      ? rect.top - pickerHeight - gutter
      : rect.bottom + gutter;

  let left =
    spaceRight < pickerWidth && spaceLeft > spaceRight
      ? rect.right - pickerWidth
      : rect.left;

  top = Math.max(gutter, Math.min(top, viewportHeight - pickerHeight - gutter));
  left = Math.max(gutter, Math.min(left, viewportWidth - pickerWidth - gutter));

  return { messageId, top, left };
}

function getMediaLabel(kind: MessageAttachmentKind) {
  if (kind === "image") return "image";
  if (kind === "video") return "video";
  if (kind === "audio") return "audio";
  if (kind === "document") return "document";
  return kind === "sticker" ? "sticker" : "attachment";
}

function getReplyPreviewText(media: Pick<MessageAttachment, "kind" | "fileName">, fallback: string) {
  if (media.fileName?.trim()) return media.fileName;

  if (media.kind === "image") {
    return "Photo";
  }

  if (media.kind === "video") {
    return "Video";
  }

  if (media.kind === "audio") {
    return "Audio";
  }

  if (media.kind === "document") {
    return "Document";
  }

  if (media.kind === "sticker") {
    return "Sticker";
  }

  return fallback;
}

function renderReplyPreviewIcon(kind: MessageAttachmentKind) {
  if (kind === "image" || kind === "sticker") {
    return <FileImage className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
  }

  if (kind === "video") {
    return <FileVideo className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
  }

  if (kind === "audio") {
    return <FileAudio className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
  }

  if (kind === "document") {
    return <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
  }

  return <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />;
}

function MediaLightbox({
  url,
  kind,
  caption,
  onClose,
}: {
  url: string;
  kind: MessageAttachmentKind;
  caption?: string | null;
  onClose: () => void;
}) {
  const isZoomable = kind === "image" || kind === "sticker";
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!dragging) return;

    const onMouseUp = () => {
      setDragging(false);
      dragStartRef.current = null;
    };

    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [dragging]);

  function updateZoom(next: number) {
    const bounded = Math.min(5, Math.max(1, next));
    setZoom(bounded);
    if (bounded === 1) {
      setOffset({ x: 0, y: 0 });
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-h-[calc(100svh-2rem)] max-w-5xl overflow-hidden border-0 bg-transparent p-3 shadow-none">
      <button
        type="button"
        onClick={onClose}
        className="absolute right-5 top-5 rounded-full border border-border bg-card px-3 py-1 text-sm text-foreground"
      >
        Close
      </button>
      {isZoomable ? (
        <div className="absolute right-24 top-5 flex items-center gap-2 rounded-full border border-border bg-card px-2 py-1">
          <button
            type="button"
            onClick={() => updateZoom(zoom - 0.25)}
            className="h-7 w-7 rounded-full text-sm text-foreground hover:bg-secondary"
          >
            -
          </button>
          <span className="w-14 text-center text-xs text-muted-foreground">
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            onClick={() => updateZoom(zoom + 0.25)}
            className="h-7 w-7 rounded-full text-sm text-foreground hover:bg-secondary"
          >
            +
          </button>
          <button
            type="button"
            onClick={() => {
              updateZoom(1);
              setOffset({ x: 0, y: 0 });
            }}
            className="rounded-full px-2 py-1 text-xs text-foreground hover:bg-secondary"
          >
            Reset
          </button>
        </div>
      ) : null}
      <div
        className="max-h-[90svh] w-full overflow-hidden rounded-xl border border-border bg-background p-3"
        onWheel={(event) => {
          if (!isZoomable) return;
          event.preventDefault();
          updateZoom(zoom + (event.deltaY < 0 ? 0.12 : -0.12));
        }}
        role="presentation"
      >
        {kind === "image" || kind === "sticker" ? (
          <div
            className="flex max-h-[80svh] min-h-[70svh] items-center justify-center overflow-hidden"
            onMouseDown={(event) => {
              if (zoom <= 1) return;
              setDragging(true);
              dragStartRef.current = { x: event.clientX - offset.x, y: event.clientY - offset.y };
            }}
            onMouseMove={(event) => {
              if (!dragging || !dragStartRef.current) return;
              setOffset({
                x: event.clientX - dragStartRef.current.x,
                y: event.clientY - dragStartRef.current.y,
              });
            }}
            style={{
              cursor: zoom > 1 ? (dragging ? "grabbing" : "grab") : "zoom-in",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={url}
              alt={caption || "media"}
              className="max-h-[80svh] w-full select-none object-contain"
              draggable={false}
              onDoubleClick={() => updateZoom(zoom > 1 ? 1 : 2)}
              style={{
                transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
                transformOrigin: "center center",
                transition: dragging ? "none" : "transform 120ms ease-out",
              }}
            />
          </div>
        ) : null}
        {kind === "video" ? (
          <video controls autoPlay className="max-h-[80svh] w-full object-contain" src={url} />
        ) : null}
        {kind === "audio" ? <audio controls autoPlay className="w-full" src={url} /> : null}
        {kind === "document" ? (
          <iframe
            title="Document preview"
            src={url}
            className="h-[80svh] w-full rounded-xl border border-border/50"
          />
        ) : null}
        {caption ? <p className="mt-2 text-sm text-muted-foreground">{caption}</p> : null}
      </div>
      </DialogContent>
    </Dialog>
  );
}
