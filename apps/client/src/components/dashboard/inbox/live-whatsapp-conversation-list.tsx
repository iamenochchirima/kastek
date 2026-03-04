"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { WhatsappRealtimeEvent } from "@/lib/whatsapp/types";

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

export default function LiveWhatsappConversationList({
  initialConversations,
}: {
  initialConversations: ConversationListItem[];
}) {
  const [conversations, setConversations] = useState(initialConversations);

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

  const renderedConversations = useMemo(() => conversations, [conversations]);

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      {renderedConversations.length === 0 ? (
        <div className="p-12 text-center">
          <p className="text-sm text-text-muted">
            No WhatsApp conversations captured yet. New messages will appear here from the time your
            number is connected to KasiAI.
          </p>
        </div>
      ) : (
        <div className="divide-y divide-border">
          {renderedConversations.map((conversation) => (
            <Link
              key={conversation.id}
              href={`/dashboard/inbox/whatsapp/${conversation.id}`}
              className="flex items-center gap-4 px-4 py-4 no-underline transition-colors hover:bg-surface-2/40"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-500/15 text-lg text-green-300">
                💬
              </div>

              <div className="min-w-0 flex-1">
                <div className="mb-0.5 flex items-center gap-2">
                  <p className="truncate text-sm font-medium text-text">
                    {conversation.customerName || conversation.phone || "Unknown"}
                  </p>
                  {conversation.unreadCount > 0 ? (
                    <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-semibold text-bg">
                      {conversation.unreadCount}
                    </span>
                  ) : null}
                </div>
                <p className="text-xs text-text-dim">{conversation.phone}</p>
                {conversation.lastMessage ? (
                  <p className="mt-1 truncate text-xs text-text-muted">
                    {conversation.lastMessage.sender === "bot" ? "You: " : ""}
                    {conversation.lastMessage.content}
                  </p>
                ) : null}
              </div>

              <div className="shrink-0 text-xs text-text-dim">
                {new Date(conversation.lastMessageAt).toLocaleDateString("en-ZA")}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
