"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { MessageSquarePlus, MoreVertical, Search } from "lucide-react";
import type { WhatsappRealtimeEvent } from "@/lib/whatsapp/types";
import { getWhatsappAvatarInitials, getWhatsappAvatarStyles } from "@/lib/whatsapp/avatar";
import { getWhatsappMessagePreview } from "@/lib/whatsapp/message-content";

type ConversationListItem = {
  id: string;
  customerName: string | null;
  phone: string;
  lastMessageAt: string;
  unreadCount: number;
  lastMessage: {
    sender: "customer" | "bot";
    content: string;
  } | null;
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

export default function LiveWhatsappConversationList({
  initialConversations,
  selectedConversationId,
  className,
  showTopChrome = false,
}: {
  initialConversations: ConversationListItem[];
  selectedConversationId?: string;
  className?: string;
  showTopChrome?: boolean;
}) {
  const [conversations, setConversations] = useState(initialConversations);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    const source = new EventSource("/api/realtime/whatsapp");

    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as WhatsappRealtimeEvent;

        if (payload.type === "message.created") {
          setConversations((current) => {
            const existing = current.find((item) => item.id === payload.conversationId);
            if (!existing) {
              return current;
            }

            const next = current.map((item) =>
              item.id === payload.conversationId
                ? {
                    ...item,
                    lastMessageAt: payload.message.timestamp,
                    lastMessage: {
                      sender: payload.message.sender,
                      content: payload.message.content,
                    },
                    unreadCount:
                      payload.message.sender === "customer"
                        ? item.unreadCount + 1
                        : item.unreadCount,
                  }
                : item
            );

            return next.sort(
              (left, right) =>
                new Date(right.lastMessageAt).getTime() - new Date(left.lastMessageAt).getTime()
            );
          });
        }

        if (payload.type === "conversation.updated") {
          setConversations((current) => {
            const existing = current.find((item) => item.id === payload.conversationId);
            const next = existing
              ? current.map((item) =>
                  item.id === payload.conversationId
                    ? {
                        ...item,
                        customerName: payload.conversation.customerName,
                        phone: payload.conversation.phone,
                        lastMessageAt: payload.conversation.lastMessageAt,
                        unreadCount: payload.conversation.unreadCount,
                      }
                    : item
                )
              : [
                  {
                    id: payload.conversation.id,
                    customerName: payload.conversation.customerName,
                    phone: payload.conversation.phone,
                    lastMessageAt: payload.conversation.lastMessageAt,
                    unreadCount: payload.conversation.unreadCount,
                    lastMessage: null,
                  },
                  ...current,
                ];

            return next.sort(
              (left, right) =>
                new Date(right.lastMessageAt).getTime() - new Date(left.lastMessageAt).getTime()
            );
          });
        }
      } catch {
        // Ignore malformed SSE payloads.
      }
    };

    return () => {
      source.close();
    };
  }, []);

  const renderedConversations = useMemo(() => {
    if (!filter.trim()) return conversations;

    const search = filter.trim().toLowerCase();
    return conversations.filter((conversation) => {
      const name = (conversation.customerName || "").toLowerCase();
      const phone = conversation.phone.toLowerCase();
      const preview = getWhatsappMessagePreview(conversation.lastMessage?.content || "").toLowerCase();
      return name.includes(search) || phone.includes(search) || preview.includes(search);
    });
  }, [conversations, filter]);

  return (
    <div
      className={`h-full overflow-hidden rounded-xl border border-border bg-surface ${
        className || ""
      }`}
    >
      {showTopChrome ? (
        <div className="border-b border-border/70 px-4 pb-3 pt-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-[34px] font-semibold leading-none text-text">Inbox</h2>
            <div className="flex items-center gap-2 text-text-muted">
              <button
                type="button"
                className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-border/70 bg-surface-2/60 text-lg leading-none hover:border-border-light"
                title="New chat"
              >
                <MessageSquarePlus className="h-5 w-5" />
              </button>
              <button
                type="button"
                className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-border/70 bg-surface-2/60 text-xl leading-none hover:border-border-light"
                title="More"
              >
                <MoreVertical className="h-5 w-5" />
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-border/70 bg-surface-2/70 px-3 py-2">
            <Search className="h-5 w-5 text-text-dim" />
            <input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Search or start a new chat"
              className="w-full bg-transparent text-sm text-text outline-none placeholder:text-text-dim"
            />
          </div>
        </div>
      ) : null}

      {renderedConversations.length === 0 ? (
        <div className="p-12 text-center">
          <p className="text-sm text-text-muted">
            {filter.trim()
              ? "No chats match your search."
              : "No WhatsApp conversations captured yet. New messages will appear here from the time your number is connected to KasiTek."}
          </p>
        </div>
      ) : (
        <div className="whatsapp-scroll h-full divide-y divide-border/70 overflow-y-auto">
          {renderedConversations.map((conversation) => {
            const initials = getWhatsappAvatarInitials({
              name: conversation.customerName,
              phone: conversation.phone,
            });
            const avatarStyles = getWhatsappAvatarStyles({
              name: conversation.customerName,
              phone: conversation.phone,
            });

            return (
            <Link
              key={conversation.id}
              href={`/dashboard/inbox/whatsapp/${conversation.id}`}
              className={`flex items-center gap-3 px-4 py-3.5 no-underline transition-colors hover:bg-surface-2/40 ${
                selectedConversationId === conversation.id ? "bg-surface-2/70" : ""
              }`}
            >
              <div
                className="flex h-11 w-11 items-center justify-center rounded-full border text-sm font-semibold uppercase"
                style={avatarStyles}
              >
                {initials}
              </div>

              <div className="min-w-0 flex-1">
                <div className="mb-0.5 flex items-center gap-2">
                  <p className="truncate text-sm font-semibold text-text">
                    {conversation.customerName || conversation.phone || "Unknown"}
                  </p>
                  {conversation.unreadCount > 0 ? (
                    <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-semibold text-bg">
                      {conversation.unreadCount}
                    </span>
                  ) : null}
                </div>
                {conversation.lastMessage ? (
                  <p className="mt-0.5 truncate text-xs text-text-muted">
                    {conversation.lastMessage.sender === "bot" ? "You: " : ""}
                    {getWhatsappMessagePreview(conversation.lastMessage.content)}
                  </p>
                ) : (
                  <p className="mt-0.5 truncate text-xs text-text-dim">{conversation.phone}</p>
                )}
              </div>

              <div className="shrink-0 text-xs text-text-dim">
                {formatConversationTime(conversation.lastMessageAt)}
              </div>
            </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
