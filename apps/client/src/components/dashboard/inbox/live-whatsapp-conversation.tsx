"use client";

import { useEffect, useMemo, useState } from "react";
import ReplyBox from "./reply-box";
import type { WhatsappRealtimeEvent } from "@/lib/whatsapp/types";

type MessageView = {
  id: string;
  sender: "customer" | "bot";
  content: string;
  timestamp: string;
  status?: "pending" | "failed" | "SENT" | "DELIVERED" | "READ" | "BLOCKED";
};

export default function LiveWhatsappConversation({
  conversationId,
  initialMessages,
}: {
  conversationId: string;
  initialMessages: MessageView[];
}) {
  const [messages, setMessages] = useState(initialMessages);
  const [streamError, setStreamError] = useState("");

  function addOptimisticMessage(text: string) {
    const timestamp = new Date().toISOString();
    const optimisticMessage: MessageView = {
      id: `optimistic:${timestamp}:${Math.random().toString(36).slice(2, 10)}`,
      sender: "bot",
      content: text,
      timestamp,
      status: "pending",
    };

    setMessages((current) =>
      [...current, optimisticMessage].sort(
        (left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime()
      )
    );
  }

  function removeOptimisticMessage(text: string) {
    setMessages((current) => {
      const index = current.findIndex(
        (message) => message.sender === "bot" && message.status === "pending" && message.content === text
      );

      if (index === -1) return current;

      return current.filter((_, currentIndex) => currentIndex !== index);
    });
  }

  useEffect(() => {
    void fetch(`/api/whatsapp/inbox/${conversationId}/read`, {
      method: "POST",
    });
  }, [conversationId]);

  useEffect(() => {
    const source = new EventSource("/api/realtime/whatsapp");

    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as WhatsappRealtimeEvent;
        if (payload.conversationId !== conversationId) return;

        if (payload.type === "message.created") {
          setMessages((current) => {
            if (current.some((message) => message.id === payload.message.id)) {
              return current;
            }

            const next = [...current];
            const optimisticIndex =
              payload.message.sender === "bot"
                ? next.findIndex(
                    (message) =>
                      message.sender === "bot" &&
                      message.status === "pending" &&
                      message.content === payload.message.content
                  )
                : -1;

            if (optimisticIndex !== -1) {
              next[optimisticIndex] = {
                ...payload.message,
                status: payload.message.whatsappStatus,
              };
              return next.sort(
                (left, right) =>
                  new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime()
              );
            }

            return [
              ...next,
              {
                ...payload.message,
                status: payload.message.whatsappStatus,
              },
            ].sort(
              (left, right) =>
                new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime()
            );
          });

          if (payload.message.sender === "customer") {
            void fetch(`/api/whatsapp/inbox/${conversationId}/read`, {
              method: "POST",
            });
          }
        }

        if (payload.type === "message.send_failed") {
          setStreamError(payload.error);
          if (payload.text) {
            setMessages((current) =>
              current.map((message) =>
                message.sender === "bot" &&
                message.status === "pending" &&
                message.content === payload.text
                  ? { ...message, status: "failed" }
                  : message
              )
            );
          }
        }

        if (payload.type === "message.updated") {
          setMessages((current) =>
            current.map((message) =>
              message.id === payload.message.id
                ? {
                    ...message,
                    status:
                      payload.message.whatsappStatus === "FAILED"
                        ? "failed"
                        : payload.message.whatsappStatus,
                  }
                : message
            )
          );
        }

        if (payload.type === "message.created") {
          setStreamError("");
        }
      } catch {
        setStreamError("Realtime stream error");
      }
    };

    source.onerror = () => {
      setStreamError("Realtime connection lost. Reconnecting...");
    };

    return () => {
      source.close();
    };
  }, [conversationId]);

  const renderedMessages = useMemo(
    () =>
      messages.map((message) => ({
        ...message,
        timeLabel: new Date(message.timestamp).toLocaleTimeString("en-ZA", {
          hour: "2-digit",
          minute: "2-digit",
        }),
      })),
    [messages]
  );

  return (
    <>
      <div className="min-h-[420px] space-y-3 rounded-xl border border-border bg-surface p-4">
        {renderedMessages.length === 0 ? (
          <p className="py-8 text-center text-sm text-text-muted">No messages yet.</p>
        ) : (
          renderedMessages.map((message) => (
            <div
              key={message.id}
              className={`flex ${message.sender === "customer" ? "justify-start" : "justify-end"}`}
            >
              <div
                className={`max-w-[75%] rounded-2xl px-4 py-2.5 ${
                  message.sender === "customer"
                    ? "rounded-bl-sm bg-surface-2 text-text"
                    : "rounded-br-sm bg-accent/20 text-text"
                }`}
              >
                <p className="whitespace-pre-wrap text-sm">{message.content}</p>
                <div
                  className={`mt-1 flex items-center gap-1 ${
                    message.sender === "bot" ? "justify-end" : "justify-start"
                  }`}
                >
                  <span
                    className={`text-[11px] leading-none ${
                      message.sender === "bot" ? "text-text/70" : "text-text-dim"
                    }`}
                  >
                    {message.timeLabel}
                  </span>
                  {message.sender === "bot" ? renderBotMessageState(message.status) : null}
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      <ReplyBox
        conversationId={conversationId}
        streamError={streamError}
        onOptimisticSend={addOptimisticMessage}
        onOptimisticSendFailed={removeOptimisticMessage}
      />
    </>
  );
}

function renderBotMessageState(status?: MessageView["status"]) {
  if (!status) return null;

  if (status === "pending") {
    return <span className="text-[11px] font-medium leading-none text-text/70">Sending...</span>;
  }

  if (status === "failed" || status === "BLOCKED") {
    return <span className="text-[11px] font-medium leading-none text-red-300">Failed</span>;
  }

  if (status === "SENT") {
    return (
      <span className="translate-y-[0.5px] text-[13px] font-semibold leading-none tracking-[-0.08em] text-text/75">
        ✓
      </span>
    );
  }

  if (status === "DELIVERED") {
    return (
      <span className="translate-y-[0.5px] text-[13px] font-semibold leading-none tracking-[-0.14em] text-text/75">
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
