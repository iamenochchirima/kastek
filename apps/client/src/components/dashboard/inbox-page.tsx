"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Picker from "@emoji-mart/react";
import emojiData from "@emoji-mart/data";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft,
  Archive,
  Clock,
  Facebook,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  Filter,
  Instagram,
  Mail,
  MessageCircle,
  MoreHorizontal,
  MoreVertical,
  Paperclip,
  Search,
  Send,
  Smile,
  Star,
  Tag,
  Users,
  X,
} from "lucide-react";
import type { WhatsappRealtimeEvent } from "@/lib/whatsapp/types";
import WhatsappManualConnectionCard from "@/components/dashboard/settings/whatsapp-manual-connection-card";
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
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  encodeStoredWhatsappReplyEnvelope,
  getWhatsappMessageDisplayText,
  getWhatsappMessagePreview,
  parseStoredWhatsappMedia,
  parseStoredWhatsappReaction,
  type WhatsappMediaKind,
  unwrapWhatsappStoredMessage,
} from "@/lib/whatsapp/message-content";

type InboxConversation = {
  id: string;
  name: string;
  handle: string;
  lastMessage: string;
  time: string;
  unread: boolean;
  starred: boolean;
  channel: "whatsapp";
  connectionId: string | null;
  connectionLabel: string;
  avatar: string;
  status: "online" | "offline";
  tags: string[];
};

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
};

const container = {
  hidden: { opacity: 0 },
  show: {
    opacity: 1,
    transition: { staggerChildren: 0.03 },
  },
};

const item = {
  hidden: { opacity: 0, x: -10 },
  show: { opacity: 1, x: 0, transition: { duration: 0.3, ease: "easeOut" as const } },
};

type ConversationMessage = {
  id: string;
  sender: "customer" | "bot";
  content: string;
  text: string;
  time: string;
  timestamp?: string;
  whatsappMessageId?: string | null;
  status?: "pending" | "failed" | "READ" | "DELIVERED" | "SENT" | "BLOCKED";
  canReply?: boolean;
  canReact?: boolean;
  errorMessage?: string | null;
};

type ReactionPickerState = {
  messageId: string;
  top: number;
  left: number;
};

type MediaLightboxState = {
  url: string;
  kind: WhatsappMediaKind;
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

export default function InboxPageClient({
  whatsappConnections,
  conversations,
  channelCounts,
}: {
  whatsappConnections: WhatsappConnectionView[];
  conversations: InboxConversation[];
  channelCounts: ChannelCounts;
}) {
  const [liveConversations, setLiveConversations] = useState(conversations);
  const [liveWhatsappUnreadCount, setLiveWhatsappUnreadCount] = useState(channelCounts.whatsapp.unreadCount);
  const [selectedChannel, setSelectedChannel] = useState<"all" | "whatsapp" | "instagram" | "facebook">("all");
  const [selectedWhatsappConnectionId, setSelectedWhatsappConnectionId] = useState<string | null>(null);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(
    conversations[0]?.id ?? null,
  );
  const [messagesByConversationId, setMessagesByConversationId] = useState<
    Record<string, ConversationMessage[]>
  >({});
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [composerLoading, setComposerLoading] = useState(false);
  const [composerError, setComposerError] = useState("");
  const [filter, setFilter] = useState("all");
  const [messageInput, setMessageInput] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [replyDraft, setReplyDraft] = useState<{ messageId: string; text: string } | null>(null);
  const [openActionsMessageId, setOpenActionsMessageId] = useState<string | null>(null);
  const [reactionPicker, setReactionPicker] = useState<ReactionPickerState | null>(null);
  const [selfReactionOverridesByMessageId, setSelfReactionOverridesByMessageId] = useState<Record<string, string>>({});
  const [showChannelPanel, setShowChannelPanel] = useState(true);
  const [mobileChannelPanelOpen, setMobileChannelPanelOpen] = useState(false);
  const [mobileConversationOpen, setMobileConversationOpen] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [lightbox, setLightbox] = useState<MediaLightboxState | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const emojiPickerRef = useRef<HTMLDivElement | null>(null);
  const reactionPickerRef = useRef<HTMLDivElement | null>(null);
  const reactionTriggerRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const unreadReconcileTimerRef = useRef<number | null>(null);

  useEffect(() => {
    setLiveConversations(conversations);
  }, [conversations]);

  useEffect(() => {
    setLiveWhatsappUnreadCount(channelCounts.whatsapp.unreadCount);
  }, [channelCounts.whatsapp.unreadCount]);

  const channels = useMemo(
    () => [
      {
        id: "all" as const,
        name: "All Channels",
        icon: MessageCircle,
        color: "text-foreground",
        bgColor: "bg-foreground/10",
        count:
          liveConversations.length +
          channelCounts.instagram.conversationCount +
          channelCounts.facebook.conversationCount,
        unreadCount:
          liveWhatsappUnreadCount +
          channelCounts.instagram.unreadCount +
          channelCounts.facebook.unreadCount,
        disabled: false,
        connected: true,
      },
      {
        id: "whatsapp" as const,
        name: "WhatsApp",
        icon: MessageCircle,
        color: "text-green-500",
        bgColor: "bg-green-500/10",
        count: liveConversations.length,
        unreadCount: liveWhatsappUnreadCount,
        disabled: false,
        connected: channelCounts.whatsapp.connected,
      },
      {
        id: "instagram" as const,
        name: "Instagram",
        icon: Instagram,
        color: "text-pink-500",
        bgColor: "bg-pink-500/10",
        count: 0,
        unreadCount: 0,
        disabled: true,
        connected: false,
      },
      {
        id: "facebook" as const,
        name: "Facebook Messenger",
        icon: Facebook,
        color: "text-blue-500",
        bgColor: "bg-blue-500/10",
        count: 0,
        unreadCount: 0,
        disabled: true,
        connected: false,
      },
    ],
    [channelCounts, liveConversations.length, liveWhatsappUnreadCount],
  );

  const whatsappConnectionFilters = useMemo(
    () => [
      {
        id: null as string | null,
        label: "All numbers",
        conversationCount: liveConversations.length,
        unreadCount: liveConversations.filter((conversation) => conversation.unread).length,
      },
      ...whatsappConnections.map((connection) => {
        const connectionConversations = liveConversations.filter(
          (conversation) => conversation.connectionId === connection.id,
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

  const filteredConversations = liveConversations.filter((conversation) => {
    const channelMatch = selectedChannel === "all" || conversation.channel === selectedChannel;
    const connectionMatch =
      !selectedWhatsappConnectionId || conversation.connectionId === selectedWhatsappConnectionId;
    const filterMatch =
      filter === "all" ||
      (filter === "unread" && conversation.unread) ||
      (filter === "starred" && conversation.starred);
    return channelMatch && connectionMatch && filterMatch;
  });

  const selectedConversation =
    filteredConversations.find((conversation) => conversation.id === selectedConversationId) ??
    filteredConversations[0] ??
    null;

  useEffect(() => {
    if (!filteredConversations.length) {
      if (selectedConversationId !== null) {
        setSelectedConversationId(null);
      }
      return;
    }

    const stillVisible = filteredConversations.some(
      (conversation) => conversation.id === selectedConversationId,
    );

    if (!stillVisible) {
      setSelectedConversationId(filteredConversations[0].id);
    }
  }, [filteredConversations, selectedConversationId]);

  const currentChannel =
    channels.find((channel) => channel.id === (selectedConversation?.channel ?? selectedChannel)) ??
    channels[0];
  const ChannelIcon = currentChannel.icon;
  const selectedChannelMeta = channels.find((channel) => channel.id === selectedChannel) ?? channels[0];
  const selectedMessages = useMemo(
    () => (selectedConversationId ? messagesByConversationId[selectedConversationId] || [] : []),
    [messagesByConversationId, selectedConversationId],
  );
  const persistedSelfReactionsByMessageId = useMemo(() => {
    const next: Record<string, string> = {};

    for (const message of selectedMessages) {
      const reaction = parseStoredWhatsappReaction(message.content);
      if (!reaction?.targetMessageId) continue;
      if (!reaction.actorIdentifier?.startsWith("bot:")) continue;
      next[reaction.targetMessageId] = reaction.emoji.trim();
    }

    return next;
  }, [selectedMessages]);

  const reactionDisplayByMessageId = useMemo(() => {
    const next: Record<string, { emojis: string[]; total: number }> = {};
    const latestByActorTarget = new Map<string, { targetMessageId: string; emoji: string }>();

    for (const message of selectedMessages) {
      const reaction = parseStoredWhatsappReaction(message.content);
      if (!reaction?.targetMessageId) continue;
      const actor = reaction.actorIdentifier || message.sender;
      latestByActorTarget.set(`${actor}:${reaction.targetMessageId}`, {
        targetMessageId: reaction.targetMessageId,
        emoji: reaction.emoji.trim(),
      });
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

  const renderedMessages = useMemo(
    () =>
      selectedMessages.filter((message) => {
        const reaction = parseStoredWhatsappReaction(message.content);
        return !reaction;
      }),
    [selectedMessages],
  );

  const openConversation = (conversationId: string) => {
    setSelectedConversationId(conversationId);
    setMobileConversationOpen(true);
  };

  const renderChannelPanelContent = () => (
    <>
      <div className="border-b border-border p-4">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-foreground">Channels</h2>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-muted-foreground"
            onClick={() => {
              setShowChannelPanel(false);
              setMobileChannelPanelOpen(false);
            }}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">Manage all your conversations</p>
      </div>

      <ScrollArea className="flex-1 p-2">
        <div className="space-y-2">
          {channels.map((channel) => {
            const Icon = channel.icon;
            const isActive = selectedChannel === channel.id;

            return (
              <div
                key={channel.id}
                className={cn(
                  "rounded-lg border p-3 transition-all duration-200",
                  isActive ? "border-primary/20 bg-primary/10" : "border-transparent",
                  channel.disabled && "opacity-70",
                )}
              >
                <button
                  onClick={() => {
                    if (!channel.disabled) setSelectedChannel(channel.id);
                    setShowChannelPanel(false);
                    setMobileChannelPanelOpen(false);
                    setMobileConversationOpen(false);
                  }}
                  disabled={channel.disabled}
                  className="flex w-full items-center gap-3 text-left"
                >
                  <div className={cn("rounded-md p-1.5", channel.bgColor)}>
                    <Icon className={cn("h-4 w-4", channel.color)} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p
                      className={cn(
                        "text-sm",
                        isActive ? "font-medium text-foreground" : "text-muted-foreground",
                      )}
                    >
                      {channel.name}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {channel.unreadCount > 0 ? (
                      <Badge className="h-5 min-w-[20px] border-0 bg-primary px-1.5 text-xs text-primary-foreground">
                        {channel.unreadCount}
                      </Badge>
                    ) : null}
                    <span className="text-xs text-muted-foreground">{channel.count}</span>
                  </div>
                </button>

                {channel.id !== "all" ? (
                  <div className="mt-3">
                    {channel.id === "whatsapp" ? (
                      channel.connected ? (
                        <div className="space-y-2">
                          {whatsappConnectionFilters.map((connectionFilter) => {
                            const isActiveConnection =
                              selectedWhatsappConnectionId === connectionFilter.id;

                            return (
                              <button
                                key={connectionFilter.id || "all"}
                                onClick={() => {
                                  setSelectedWhatsappConnectionId(connectionFilter.id);
                                  setShowChannelPanel(false);
                                  setMobileChannelPanelOpen(false);
                                  setMobileConversationOpen(false);
                                }}
                                className={cn(
                                  "flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left transition-colors",
                                  isActiveConnection
                                    ? "border-primary/20 bg-primary/10 text-foreground"
                                    : "border-border bg-secondary/30 text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                                )}
                              >
                                <div className="min-w-0">
                                  <p className="truncate text-xs font-medium">
                                    {connectionFilter.label}
                                  </p>
                                </div>
                                <div className="ml-3 flex items-center gap-2">
                                  {connectionFilter.unreadCount > 0 ? (
                                    <Badge className="h-5 min-w-[20px] border-0 bg-primary px-1.5 text-[10px] text-primary-foreground">
                                      {connectionFilter.unreadCount}
                                    </Badge>
                                  ) : null}
                                  <span className="text-[10px] text-muted-foreground">
                                    {connectionFilter.conversationCount}
                                  </span>
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <Sheet>
                          <SheetTrigger asChild>
                            <Button
                              variant="secondary"
                              className="h-8 w-full justify-center text-xs"
                            >
                              Connect WhatsApp
                            </Button>
                          </SheetTrigger>
                          <SheetContent side="right" className="w-[min(720px,100vw)] overflow-y-auto p-0">
                            <div className="border-b border-border px-5 py-4">
                              <h3 className="text-base font-semibold text-foreground">
                                WhatsApp Connection
                              </h3>
                              <p className="mt-1 text-sm text-muted-foreground">
                                Reuse the current working Cloud API connection flow here.
                              </p>
                            </div>
                            <div className="p-5">
                              <WhatsappManualConnectionCard
                                connections={whatsappConnections}
                                mode="setup"
                              />
                            </div>
                          </SheetContent>
                        </Sheet>
                      )
                    ) : (
                      <Button
                        variant="outline"
                        className="h-8 w-full justify-center text-xs opacity-50"
                        disabled
                      >
                        Connect {channel.name}
                      </Button>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="mt-6 border-t border-border pt-4">
          <p className="mb-2 px-3 text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Quick Filters
          </p>
          <div className="space-y-1">
            {[
              { id: "all", label: "All Messages", icon: MessageCircle },
              { id: "unread", label: "Unread", icon: Mail },
              { id: "starred", label: "Starred", icon: Star },
            ].map((filterItem) => {
              const Icon = filterItem.icon;
              const isActive = filter === filterItem.id;
              return (
                <button
                  key={filterItem.id}
                  onClick={() => {
                    setFilter(filterItem.id);
                    setMobileConversationOpen(false);
                  }}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm transition-all duration-200",
                    isActive
                      ? "bg-secondary text-foreground"
                      : "text-muted-foreground hover:bg-secondary/50 hover:text-foreground",
                  )}
                >
                  <Icon className="h-4 w-4" />
                  <span>{filterItem.label}</span>
                </button>
              );
            })}
          </div>
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
        const response = await fetch(apiUrl(`/api/whatsapp/inbox/${conversationId}/messages`), {
          cache: "no-store",
          credentials: "include",
        });
        const payload = (await response.json()) as {
          messages?: ConversationMessage[];
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
          })),
        }));
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

    void fetch(apiUrl(`/api/whatsapp/inbox/${selectedConversationId}/read`), {
      method: "POST",
      credentials: "include",
    });
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

  useEffect(() => {
    const source = new EventSource(apiUrl("/api/realtime/whatsapp"), {
      withCredentials: true,
    });

    const syncUnreadCount = async () => {
      try {
        const response = await fetch(apiUrl("/api/whatsapp/inbox/unread-count"), {
          cache: "no-store",
          credentials: "include",
        });

        if (!response.ok) return;

        const payload = (await response.json()) as { unreadCount?: number };
        if (typeof payload.unreadCount !== "number") return;

        setLiveWhatsappUnreadCount(Math.max(0, payload.unreadCount));
      } catch {
        // Ignore transient failures; reconcile again on the next event.
      }
    };

    const scheduleUnreadSync = () => {
      if (unreadReconcileTimerRef.current !== null) {
        window.clearTimeout(unreadReconcileTimerRef.current);
      }

      unreadReconcileTimerRef.current = window.setTimeout(() => {
        void syncUnreadCount();
      }, 250);
    };

    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as WhatsappRealtimeEvent;

        if (payload.type === "message.created") {
          const conversationId = payload.conversationId;
          setLiveConversations((current) => {
            const existing = current.find((conversation) => conversation.id === conversationId);
            if (!existing) {
              const fallbackName =
                payload.conversation?.customerName || payload.conversation?.phone || "Unknown contact";
              const nextConversation: InboxConversation = {
                id: conversationId,
                name: fallbackName,
                handle: payload.conversation?.phone || "Unknown contact",
                lastMessage: getWhatsappMessagePreview(payload.message.content),
                time: payload.message.timestamp,
                unread: payload.message.sender === "customer" && conversationId !== selectedConversationId,
                starred: false,
                channel: "whatsapp" as const,
                connectionId: payload.conversation?.connectionId || null,
                connectionLabel:
                  payload.conversation?.connectionLabel || payload.conversation?.phone || "Unknown number",
                avatar:
                  fallbackName
                    .split(/\s+/)
                    .filter(Boolean)
                    .slice(0, 2)
                    .map((part) => part[0]?.toUpperCase() || "")
                    .join("")
                    .slice(0, 2) || "?",
                status: "offline" as const,
                tags: [],
              };

              return [nextConversation, ...current].sort(
                (left, right) => new Date(right.time).getTime() - new Date(left.time).getTime(),
              );
            }

            const next = current.map((conversation) =>
              conversation.id === conversationId
                ? {
                    ...conversation,
                    time: payload.message.timestamp,
                    lastMessage: getWhatsappMessagePreview(payload.message.content),
                    unread:
                      payload.message.sender === "customer"
                        ? conversation.id === selectedConversationId
                          ? false
                          : true
                        : conversation.unread,
                  }
                : conversation,
            );

            return next.sort(
              (left, right) => new Date(right.time).getTime() - new Date(left.time).getTime(),
            );
          });

          if (payload.message.sender === "customer") {
            setLiveWhatsappUnreadCount((current) =>
              conversationId === selectedConversationId ? current : current + 1,
            );
            scheduleUnreadSync();
          }

          setMessagesByConversationId((current) => {
            const existing = current[conversationId];
            if (!existing) return current;
            if (existing.some((message) => message.id === payload.message.id)) return current;

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

            const confirmedMessage: ConversationMessage = {
              id: payload.message.id,
              sender: payload.message.sender,
              content: payload.message.content,
              text: getWhatsappMessageDisplayText(payload.message.content),
              time: new Date(payload.message.timestamp).toLocaleTimeString("en-ZA", {
                hour: "2-digit",
                minute: "2-digit",
              }),
              timestamp: payload.message.timestamp,
              status: normalizeRealtimeStatus(payload.message.whatsappStatus),
            };

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
        }

        if (payload.type === "conversation.updated") {
          setLiveConversations((current) => {
            const existing = current.find((conversation) => conversation.id === payload.conversationId);

            const next = existing
              ? current.map((conversation) =>
                  conversation.id === payload.conversationId
                    ? {
                        ...conversation,
                        name: payload.conversation.customerName || conversation.name,
                        handle: payload.conversation.phone,
                        time: payload.conversation.lastMessageAt,
                        unread: payload.conversation.unreadCount > 0,
                        avatar:
                          (payload.conversation.customerName || payload.conversation.phone || "?")
                            .split(/\s+/)
                            .filter(Boolean)
                            .slice(0, 2)
                            .map((part) => part[0]?.toUpperCase() || "")
                            .join("")
                            .slice(0, 2) || "?",
                      }
                    : conversation,
                )
              : [
                  {
                    id: payload.conversationId,
                    name: payload.conversation.customerName || payload.conversation.phone || "Unknown contact",
                    handle: payload.conversation.phone,
                    lastMessage: "New conversation",
                    time: payload.conversation.lastMessageAt,
                    unread: payload.conversation.unreadCount > 0,
                    starred: false,
                    channel: "whatsapp" as const,
                    connectionId: payload.conversation.connectionId || null,
                    connectionLabel:
                      payload.conversation.connectionLabel || payload.conversation.phone || "Unknown number",
                    avatar:
                      (payload.conversation.customerName || payload.conversation.phone || "?")
                        .split(/\s+/)
                        .filter(Boolean)
                        .slice(0, 2)
                        .map((part) => part[0]?.toUpperCase() || "")
                        .join("")
                        .slice(0, 2) || "?",
                    status: "offline" as const,
                    tags: [],
                  },
                  ...current,
                ];

            return next.sort(
              (left, right) => new Date(right.time).getTime() - new Date(left.time).getTime(),
            );
          });

          scheduleUnreadSync();
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
                      status: normalizeRealtimeStatus(payload.message.whatsappStatus),
                      errorMessage: null,
                    }
                  : message,
              ),
            };
          });
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
      } catch {
        // Ignore malformed payloads.
      }
    };

    return () => {
      source.close();
      if (unreadReconcileTimerRef.current !== null) {
        window.clearTimeout(unreadReconcileTimerRef.current);
        unreadReconcileTimerRef.current = null;
      }
    };
  }, [selectedConversationId]);

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

  async function sendMessage() {
    if (!selectedConversationId) return;
    const conversationId = selectedConversationId;

    const trimmed = messageInput.trim();
    if (!trimmed && !selectedFile) return;

    setComposerLoading(true);
    setComposerError("");

    const optimisticId = `optimistic:${Date.now()}`;
    if (trimmed && !selectedFile) {
      const optimisticContent =
        replyDraft?.messageId && replyDraft.text
          ? encodeStoredWhatsappReplyEnvelope({
              version: 1,
              replyToMessageId: replyDraft.messageId,
              replyPreview: replyDraft.text,
              content: trimmed,
            })
          : trimmed;

      setMessagesByConversationId((current) => ({
        ...current,
        [conversationId]: [
          ...(current[conversationId] || []),
          {
            id: optimisticId,
            sender: "bot",
            content: optimisticContent,
            text: trimmed,
            time: new Date().toLocaleTimeString("en-ZA", {
              hour: "2-digit",
              minute: "2-digit",
            }),
            timestamp: new Date().toISOString(),
            status: "pending",
          },
        ],
      }));
    }

    const response = selectedFile
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
      : await fetch(apiUrl(`/api/whatsapp/inbox/${conversationId}/messages`), {
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
      };
      console.log("[inbox send debug]", {
        conversationId,
        optimisticId,
        payload,
      });
      if (payload.messageId && optimisticId.startsWith("optimistic:")) {
        setMessagesByConversationId((current) => ({
          ...current,
          [conversationId]: (current[conversationId] || []).map((message) =>
            message.id === optimisticId
              ? {
                  ...message,
                  id: payload.messageId!,
                  status: payload.queued ? "pending" : message.status,
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
      <div className="relative flex h-screen overflow-hidden">
        <Sheet open={mobileChannelPanelOpen} onOpenChange={setMobileChannelPanelOpen}>
          <SheetContent side="left" className="flex w-[min(320px,100vw)] flex-col p-0 lg:hidden">
            {renderChannelPanelContent()}
          </SheetContent>
        </Sheet>
        <AnimatePresence>
          {showChannelPanel ? (
            <motion.div
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 260, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="hidden flex-col overflow-hidden border-r border-border bg-card lg:flex"
            >
              {renderChannelPanelContent()}
            </motion.div>
          ) : null}
        </AnimatePresence>

        <div
          className={cn(
            "flex flex-col border-r border-border bg-card",
            mobileConversationOpen ? "hidden lg:flex" : "w-full",
            "lg:w-96",
          )}
        >
          <div className="border-b border-border p-3 sm:p-4">
            <div className="mb-4 flex items-center gap-2">
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 text-muted-foreground lg:hidden"
                onClick={() => setMobileChannelPanelOpen(true)}
              >
                <Filter className="h-4 w-4" />
              </Button>
              {!showChannelPanel ? (
                <Button
                  variant="ghost"
                  size="icon"
                  className="hidden h-8 w-8 shrink-0 text-muted-foreground lg:inline-flex"
                  onClick={() => setShowChannelPanel(true)}
                >
                  <Filter className="h-4 w-4" />
                </Button>
              ) : null}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h1 className="truncate text-lg font-semibold text-foreground sm:text-xl">
                    {selectedChannelMeta.name}
                  </h1>
                </div>
              </div>
              <Badge className="hidden border-0 bg-primary/10 text-primary sm:inline-flex">
                {filteredConversations.filter((conversation) => conversation.unread).length} new
              </Badge>
            </div>

            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search conversations..."
                className="border-border bg-secondary pl-9"
              />
            </div>
          </div>

          <ScrollArea className="flex-1">
            <motion.div variants={container} initial="hidden" animate="show" className="p-2">
              {selectedChannel !== "all" && selectedChannelMeta.disabled ? (
                <div className="flex flex-col items-center justify-center py-14 text-center">
                  <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
                    <selectedChannelMeta.icon className={cn("h-6 w-6", selectedChannelMeta.color)} />
                  </div>
                  <p className="text-sm text-foreground">{selectedChannelMeta.name} is not wired yet</p>
                </div>
              ) : !channelCounts.whatsapp.connected && (selectedChannel === "all" || selectedChannel === "whatsapp") ? (
                <div className="flex flex-col items-center justify-center py-14 text-center">
                  <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
                    <MessageCircle className="h-6 w-6 text-muted-foreground" />
                  </div>
                  <p className="text-sm text-foreground">Connect WhatsApp to start using inbox</p>
                </div>
              ) : filteredConversations.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
                    <MessageCircle className="h-6 w-6 text-muted-foreground" />
                  </div>
                  <p className="text-sm text-muted-foreground">No conversations found</p>
                  <p className="mt-1 text-xs text-muted-foreground">Try adjusting your filters</p>
                </div>
              ) : (
                filteredConversations.map((conversation) => {
                  const channelInfo = channels.find((channel) => channel.id === conversation.channel) ?? channels[0];
                  const ConversationChannelIcon = channelInfo.icon;

                  return (
                    <motion.button
                      key={conversation.id}
                      variants={item}
                      onClick={() => openConversation(conversation.id)}
                      className={cn(
                        "mb-1 flex w-full items-start gap-3 rounded-lg border p-3 text-left transition-all duration-200",
                        selectedConversation?.id === conversation.id
                          ? "border-primary/20 bg-primary/10"
                          : "border-transparent hover:bg-secondary",
                      )}
                    >
                      <div className="relative">
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
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="mb-0.5 flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span
                              className={cn(
                                "truncate text-sm",
                                conversation.unread ? "font-semibold text-foreground" : "text-foreground",
                              )}
                            >
                              {conversation.name}
                            </span>
                          </div>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {formatConversationTime(conversation.time)}
                          </span>
                        </div>
                        <p className="mb-1 truncate text-xs text-muted-foreground">
                          {conversation.handle}
                          {whatsappConnections.length > 1 ? ` · ${conversation.connectionLabel}` : ""}
                        </p>
                        <p
                          className={cn(
                            "truncate text-sm",
                            conversation.unread ? "text-foreground" : "text-muted-foreground",
                          )}
                        >
                          {conversation.lastMessage}
                        </p>
                      </div>
                      {conversation.unread ? (
                        <div className="mt-2 h-2 w-2 shrink-0 rounded-full bg-primary" />
                      ) : null}
                    </motion.button>
                  );
                })
              )}
            </motion.div>
          </ScrollArea>
        </div>

        <div className={cn("flex flex-1 flex-col bg-background", mobileConversationOpen ? "flex" : "hidden lg:flex")}>
          <div className="flex h-16 items-center justify-between gap-2 border-b border-border bg-card px-3 sm:px-6">
            {selectedConversation ? (
              <>
                <div className="flex min-w-0 items-center gap-2 sm:gap-3">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0 text-muted-foreground lg:hidden"
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
                        {selectedConversation.name}
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
                      <span>{selectedConversation.handle}</span>
                      {selectedConversation.status === "online" ? (
                        <span className="ml-1 hidden items-center gap-1 text-accent sm:inline-flex">
                          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                          Online
                        </span>
                      ) : null}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon" className="hidden h-8 w-8 text-muted-foreground sm:inline-flex">
                        <Tag className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Add Tag</TooltipContent>
                  </Tooltip>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground">
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
                      <Button variant="ghost" size="icon" className="hidden h-8 w-8 text-muted-foreground sm:inline-flex">
                        <Archive className="h-4 w-4" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>Archive</TooltipContent>
                  </Tooltip>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground">
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
                      <DropdownMenuItem className="text-destructive">
                        Block Contact
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </>
            ) : null}
          </div>

          <ScrollArea className="flex-1 p-3 sm:p-6">
            <div className="mx-auto max-w-3xl space-y-4">
              <div className="flex items-center gap-4 py-2">
                <div className="h-px flex-1 bg-border" />
                <span className="text-xs text-muted-foreground">Today</span>
                <div className="h-px flex-1 bg-border" />
              </div>

              {messagesLoading && renderedMessages.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">Loading messages...</div>
              ) : renderedMessages.length === 0 ? (
                <div className="py-8 text-center text-sm text-muted-foreground">No messages yet.</div>
              ) : (
                renderedMessages.map((message) => (
                <motion.div
                  key={message.id}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={cn(
                    "flex",
                    message.sender === "customer" ? "justify-start" : "justify-end",
                  )}
                >
                  <div
                    className={cn(
                      "group relative max-w-[85%] rounded-lg p-3 sm:max-w-[70%]",
                      message.sender === "customer"
                        ? "bg-secondary text-foreground"
                        : "border border-primary/20 bg-primary/10 text-foreground",
                    )}
                  >
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
                              disabled={!message.canReply}
                              onClick={() =>
                                setReplyDraft({
                                  messageId: message.id,
                                  text: getWhatsappMessageDisplayText(message.content).slice(0, 120),
                                })
                              }
                            >
                              Reply
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              disabled={!message.canReact}
                              onClick={() => toggleReactionPicker(message.id)}
                            >
                              React
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onClick={() => void deleteMessage(message.id)}>
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </div>
                    <DashboardMessageContent
                      message={message}
                      replyTargetMessage={
                        message.content.includes("__kasiai_wa_reply_v1__")
                          ? selectedMessages.find(
                              (candidate) =>
                                candidate.id === unwrapWhatsappStoredMessage(message.content).replyToMessageId,
                            ) || null
                          : null
                      }
                      contactLabel={selectedConversation?.handle || selectedConversation?.name || "Contact"}
                      onOpenMedia={(url, kind, caption) => setLightbox({ url, kind, caption })}
                    />
                    <div className="mt-1.5 space-y-1">
                      {message.status === "failed" && message.errorMessage ? (
                        <p className="max-w-[220px] text-right text-[10px] leading-snug text-red-300">
                          {message.errorMessage}
                        </p>
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
                              )?.trim() && message.canReact
                                ? "cursor-pointer hover:bg-card"
                                : "cursor-default",
                            )}
                            onClick={() => {
                              if (
                                !(
                                  (
                                    selfReactionOverridesByMessageId[message.id] ??
                                    persistedSelfReactionsByMessageId[message.id]
                                  )?.trim() && message.canReact
                                )
                              ) {
                                return;
                              }
                              void sendReaction(message.id, "", true);
                            }}
                          >
                            {reactionDisplayByMessageId[message.id].emojis.join(" ")}
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
                ))
              )}
              <div ref={messagesEndRef} />
            </div>
          </ScrollArea>
          {reactionPicker ? (
            <div
              ref={reactionPickerRef}
              className="fixed z-50 overflow-hidden rounded-xl border border-border/70 shadow-[0_16px_36px_rgba(0,0,0,0.35)]"
              style={{ top: reactionPicker.top, left: reactionPicker.left }}
            >
              <Picker
                data={emojiData}
                previewPosition="none"
                theme="dark"
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

          <div className="border-t border-border bg-card p-3 sm:p-4">
            <div className="mx-auto max-w-3xl">
              {composerError ? (
                <div className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                  {composerError}
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
                >
                  <Paperclip className="h-4 w-4" />
                </Button>
                <textarea
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
                    className="absolute bottom-[calc(100%+10px)] right-14 z-50 overflow-hidden rounded-xl border border-border/70 shadow-[0_16px_36px_rgba(0,0,0,0.35)]"
                  >
                    <Picker
                      data={emojiData}
                      previewPosition="none"
                      theme="dark"
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
        </div>
      </div>
    </TooltipProvider>
  );
}

function DashboardMessageContent({
  message,
  replyTargetMessage,
  contactLabel,
  onOpenMedia,
}: {
  message: ConversationMessage;
  replyTargetMessage: ConversationMessage | null;
  contactLabel: string;
  onOpenMedia: (url: string, kind: WhatsappMediaKind, caption?: string | null) => void;
}) {
  const unwrapped = unwrapWhatsappStoredMessage(message.content);
  const media = parseStoredWhatsappMedia(unwrapped.content);
  const [mediaFailed, setMediaFailed] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  if (!media) {
    return (
      <div className="space-y-2">
        {unwrapped.replyPreview ? (
          <ReplyPreviewCard
            message={replyTargetMessage}
            fallbackPreview={unwrapped.replyPreview}
            contactLabel={contactLabel}
          />
        ) : null}
        <p className="whitespace-pre-wrap text-sm leading-relaxed">{unwrapped.content}</p>
      </div>
    );
  }

  const mediaUrl = apiUrl(`/api/whatsapp/inbox/media/${message.id}`);
  const caption = media.caption?.trim();

  if (mediaFailed) {
    return (
      <div className="space-y-2">
        {unwrapped.replyPreview ? (
          <ReplyPreviewCard
            message={replyTargetMessage}
            fallbackPreview={unwrapped.replyPreview}
            contactLabel={contactLabel}
          />
        ) : null}
        <div className="rounded-md border border-border/60 bg-card/40 px-3 py-2 text-xs text-muted-foreground">
          Media preview unavailable.
        </div>
        <a
          href={mediaUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex rounded-md border border-border/60 px-3 py-2 text-sm text-foreground no-underline"
        >
          {`Open ${getMediaLabel(media.kind)}`}
        </a>
        <button
          type="button"
          onClick={() => {
            setMediaFailed(false);
            setReloadToken((current) => current + 1);
          }}
          className="inline-flex rounded-md border border-border/60 px-3 py-2 text-sm text-foreground"
        >
          Retry preview
        </button>
        {caption ? <p className="whitespace-pre-wrap text-sm leading-relaxed">{caption}</p> : null}
      </div>
    );
  }

  if (media.kind === "image" || media.kind === "sticker") {
    return (
      <div className="space-y-2">
        {unwrapped.replyPreview ? (
          <ReplyPreviewCard
            message={replyTargetMessage}
            fallbackPreview={unwrapped.replyPreview}
            contactLabel={contactLabel}
          />
        ) : null}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          key={`image-${reloadToken}`}
          src={mediaUrl}
          alt={caption || "attachment"}
          className="max-h-72 w-full max-w-sm cursor-zoom-in rounded-md border border-border/60 object-contain"
          onError={() => setMediaFailed(true)}
          onClick={() => onOpenMedia(mediaUrl, media.kind, caption)}
        />
        {caption ? <p className="whitespace-pre-wrap text-sm leading-relaxed">{caption}</p> : null}
      </div>
    );
  }

  if (media.kind === "video") {
    return (
      <div className="space-y-2">
        {unwrapped.replyPreview ? (
          <ReplyPreviewCard
            message={replyTargetMessage}
            fallbackPreview={unwrapped.replyPreview}
            contactLabel={contactLabel}
          />
        ) : null}
        <video
          key={`video-${reloadToken}`}
          controls
          className="max-h-72 w-full max-w-sm cursor-zoom-in rounded-md border border-border/60"
          src={mediaUrl}
          onError={() => setMediaFailed(true)}
          onClick={() => onOpenMedia(mediaUrl, media.kind, caption)}
        />
        {caption ? <p className="whitespace-pre-wrap text-sm leading-relaxed">{caption}</p> : null}
      </div>
    );
  }

  if (media.kind === "audio") {
    return (
      <div className="space-y-2">
        {unwrapped.replyPreview ? (
          <ReplyPreviewCard
            message={replyTargetMessage}
            fallbackPreview={unwrapped.replyPreview}
            contactLabel={contactLabel}
          />
        ) : null}
        <audio
          key={`audio-${reloadToken}`}
          controls
          className="w-full max-w-sm"
          src={mediaUrl}
          onError={() => setMediaFailed(true)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {unwrapped.replyPreview ? (
        <ReplyPreviewCard
          message={replyTargetMessage}
          fallbackPreview={unwrapped.replyPreview}
          contactLabel={contactLabel}
        />
      ) : null}
      <a
        href={mediaUrl}
        onClick={(event) => {
          event.preventDefault();
          onOpenMedia(mediaUrl, media.kind, caption);
        }}
        className="inline-flex rounded-md border border-border/60 px-3 py-2 text-sm text-foreground no-underline"
      >
        {`Open ${getMediaLabel(media.kind)}`}
      </a>
      <p className="whitespace-pre-wrap text-sm leading-relaxed">
        {caption || getWhatsappMessageDisplayText(message.content)}
      </p>
    </div>
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
  const previewSource = message?.content || fallbackPreview;
  const media = message ? parseStoredWhatsappMedia(unwrapWhatsappStoredMessage(message.content).content) : null;
  const label = message?.sender === "bot" ? "You" : contactLabel;
  const displayText = getWhatsappMessageDisplayText(previewSource);
  const replyPreviewText = media ? getReplyPreviewText(media, displayText) : displayText;
  const mediaUrl = message && media ? apiUrl(`/api/whatsapp/inbox/media/${message.id}`) : null;

  return (
    <div className="flex overflow-hidden rounded-md bg-black/20">
      <div className="w-1 shrink-0 bg-primary" />
      <div className="min-w-0 flex-1 px-3 py-2">
        <p className="truncate text-[11px] font-medium text-primary">{label}</p>
        {media ? (
          <div className="mt-0.5 flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                {renderReplyPreviewIcon(media.kind)}
                <p className="truncate text-xs text-muted-foreground">
                  {replyPreviewText}
                </p>
              </div>
            </div>
            {mediaUrl && (media.kind === "image" || media.kind === "sticker") ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={mediaUrl}
                alt={media.kind}
                className="h-10 w-10 shrink-0 rounded-sm object-cover"
              />
            ) : null}
          </div>
        ) : (
          <p className="truncate text-xs text-muted-foreground">{displayText}</p>
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
    return <span className="text-[10px] text-red-300">Failed</span>;
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
  status?: "SENT" | "DELIVERED" | "READ" | "FAILED" | "BLOCKED",
): ConversationMessage["status"] {
  if (!status) return undefined;
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

function getMediaLabel(kind: "image" | "video" | "audio" | "document" | "sticker") {
  if (kind === "image") return "image";
  if (kind === "video") return "video";
  if (kind === "audio") return "audio";
  if (kind === "document") return "document";
  return "sticker";
}

function getReplyPreviewText(media: { kind: WhatsappMediaKind; caption?: string | null }, fallback: string) {
  const caption = media.caption?.trim();
  if (caption) {
    return caption;
  }

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

function renderReplyPreviewIcon(kind: WhatsappMediaKind) {
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
  kind: WhatsappMediaKind;
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
      onClick={onClose}
      role="presentation"
    >
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
        className="max-h-[90vh] w-full max-w-5xl overflow-hidden rounded-2xl border border-border bg-background p-3"
        onClick={(event) => event.stopPropagation()}
        onWheel={(event) => {
          if (!isZoomable) return;
          event.preventDefault();
          updateZoom(zoom + (event.deltaY < 0 ? 0.12 : -0.12));
        }}
        role="presentation"
      >
        {kind === "image" || kind === "sticker" ? (
          <div
            className="flex max-h-[80vh] min-h-[70vh] items-center justify-center overflow-hidden"
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
              className="max-h-[80vh] w-full select-none object-contain"
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
          <video controls autoPlay className="max-h-[80vh] w-full object-contain" src={url} />
        ) : null}
        {kind === "audio" ? <audio controls autoPlay className="w-full" src={url} /> : null}
        {kind === "document" ? (
          <iframe
            title="Document preview"
            src={url}
            className="h-[80vh] w-full rounded-xl border border-border/50"
          />
        ) : null}
        {caption ? <p className="mt-2 text-sm text-muted-foreground">{caption}</p> : null}
      </div>
    </div>
  );
}
