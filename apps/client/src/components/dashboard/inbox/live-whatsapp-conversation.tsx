"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Picker from "@emoji-mart/react";
import emojiData from "@emoji-mart/data";
import ReplyBox from "./reply-box";
import type { WhatsappRealtimeEvent } from "@/lib/whatsapp/types";
import {
  getWhatsappMessageDisplayText,
  parseStoredWhatsappReaction,
  parseStoredWhatsappMedia,
  unwrapWhatsappStoredMessage,
  type WhatsappMediaKind,
} from "@/lib/whatsapp/message-content";

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
  const [selfReactionOverridesByMessageId, setSelfReactionOverridesByMessageId] = useState<
    Record<string, string>
  >({});
  const [streamError, setStreamError] = useState("");
  const [openActionsMessageId, setOpenActionsMessageId] = useState<string | null>(null);
  const [reactionPickerMessageId, setReactionPickerMessageId] = useState<string | null>(null);
  const [pendingDeleteMessageId, setPendingDeleteMessageId] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [lightbox, setLightbox] = useState<{
    url: string;
    kind: WhatsappMediaKind;
    caption?: string | null;
  } | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const reactionPickerRef = useRef<HTMLDivElement | null>(null);

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
                status: normalizeRealtimeStatus(payload.message.whatsappStatus),
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
                status: normalizeRealtimeStatus(payload.message.whatsappStatus),
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

  const persistedSelfReactionsByMessageId = useMemo(() => {
    const next: Record<string, string> = {};
    const ordered = [...messages].sort(
      (left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime()
    );

    for (const message of ordered) {
      const reaction = parseStoredWhatsappReaction(message.content);
      if (!reaction?.targetMessageId) continue;
      if (!reaction.actorIdentifier?.startsWith("bot:")) continue;
      next[reaction.targetMessageId] = reaction.emoji.trim();
    }

    return next;
  }, [messages]);

  const reactionDisplayByMessageId = useMemo(() => {
    const next: Record<string, { emojis: string[]; total: number }> = {};
    const ordered = [...messages].sort(
      (left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime()
    );

    const latestByActorTarget = new Map<string, { targetMessageId: string; emoji: string }>();
    for (const message of ordered) {
      const reaction = parseStoredWhatsappReaction(message.content);
      if (!reaction?.targetMessageId) continue;

      const actor = reaction.actorIdentifier || message.sender;
      const key = `${actor}:${reaction.targetMessageId}`;
      latestByActorTarget.set(key, {
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
    let hasAny = false;
    for (const entry of latestByActorTarget.values()) {
      if (!entry.emoji) continue;
      countsByTarget[entry.targetMessageId] ||= {};
      countsByTarget[entry.targetMessageId][entry.emoji] =
        (countsByTarget[entry.targetMessageId][entry.emoji] || 0) + 1;
      hasAny = true;
    }

    if (!hasAny) return next;

    for (const [messageId, counts] of Object.entries(countsByTarget)) {
      const sorted = Object.entries(counts).sort((left, right) => right[1] - left[1]);
      const total = sorted.reduce((sum, [, count]) => sum + count, 0);
      if (total <= 0) continue;
      next[messageId] = {
        emojis: sorted.map(([emoji]) => emoji).slice(0, 3),
        total,
      };
    }

    return next;
  }, [messages, selfReactionOverridesByMessageId]);

  const renderedMessages = useMemo(() => {
    const messageIds = new Set(messages.map((message) => message.id));

    return messages
      .filter((message) => {
        const reaction = parseStoredWhatsappReaction(message.content);
        return !(reaction?.targetMessageId && messageIds.has(reaction.targetMessageId));
      })
      .map((message) => ({
        ...message,
        timeLabel: new Date(message.timestamp).toLocaleTimeString("en-ZA", {
          hour: "2-digit",
          minute: "2-digit",
        }),
      }));
  }, [messages]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [renderedMessages.length]);

  useEffect(() => {
    if (!reactionPickerMessageId) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!reactionPickerRef.current) return;
      if (!reactionPickerRef.current.contains(event.target as Node)) {
        setReactionPickerMessageId(null);
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setReactionPickerMessageId(null);
      }
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [reactionPickerMessageId]);

  async function sendReaction(messageId: string, emoji: string, remove = false) {
    const reaction = emoji.trim();
    if (!remove && !reaction) return;
    const previousReaction =
      selfReactionOverridesByMessageId[messageId] ?? persistedSelfReactionsByMessageId[messageId] ?? "";

    setSelfReactionOverridesByMessageId((current) => ({
      ...current,
      [messageId]: remove ? "" : reaction,
    }));
    setReactionPickerMessageId(null);
    setOpenActionsMessageId(null);
    setStreamError("");

    const response = await fetch(
      `/api/whatsapp/inbox/${conversationId}/messages/${messageId}/reaction`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(remove ? { remove: true } : { emoji: reaction }),
      }
    );

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      setStreamError(body.error || "Failed to send reaction");
      setSelfReactionOverridesByMessageId((current) => ({
        ...current,
        [messageId]: previousReaction,
      }));
      return;
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border border-border/70 bg-[radial-gradient(circle_at_top_left,rgba(255,255,255,0.06),transparent_45%),linear-gradient(180deg,rgba(255,255,255,0.02),transparent_80%)] p-4 shadow-[0_18px_40px_rgba(0,0,0,0.22)]">
        {renderedMessages.length === 0 ? (
          <p className="py-8 text-center text-sm text-text-muted">No messages yet.</p>
        ) : (
          <div className="whatsapp-scroll min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
            {renderedMessages.map((message) => (
              <div
                key={message.id}
                className={`flex ${message.sender === "customer" ? "justify-start" : "justify-end"}`}
              >
                <div
                  className={`group relative max-w-[78%] rounded-2xl pb-2.5 pl-4 pr-8 pt-3 shadow-[0_8px_20px_rgba(0,0,0,0.2)] ${
                    message.sender === "customer"
                      ? "rounded-bl-sm border border-border/60 bg-surface-2/90 text-text"
                      : "rounded-br-sm border border-accent/35 bg-[linear-gradient(135deg,rgba(125,157,39,0.45),rgba(97,128,26,0.55))] text-text"
                  }`}
                >
                  <div className="absolute right-1.5 top-1.5">
                    <MessageActions
                      message={message}
                      side={message.sender === "customer" ? "left" : "right"}
                      open={openActionsMessageId === message.id}
                      onToggle={() =>
                        setOpenActionsMessageId((current) =>
                          current === message.id ? null : message.id
                        )
                      }
                      onClose={() => setOpenActionsMessageId(null)}
                      onReply={(text) => {
                        window.dispatchEvent(
                          new CustomEvent("kasiai:inbox-reply-draft", {
                            detail: { messageId: message.id, text },
                          })
                        );
                        setOpenActionsMessageId(null);
                      }}
                      onReact={async (messageId) => {
                        setReactionPickerMessageId(messageId);
                        setOpenActionsMessageId(null);
                      }}
                      onRemoveReaction={(messageId) => {
                        void sendReaction(messageId, "", true);
                      }}
                      canRemoveReaction={Boolean(
                        (
                          selfReactionOverridesByMessageId[message.id] ??
                          persistedSelfReactionsByMessageId[message.id]
                        )?.trim()
                      )}
                      onDelete={(messageId) => {
                        setPendingDeleteMessageId(messageId);
                        setOpenActionsMessageId(null);
                      }}
                      onOpenMedia={(url, kind, caption) => setLightbox({ url, kind, caption })}
                    />
                  </div>
                  <MessageBubbleContent
                    message={message}
                    onOpenMedia={(url, kind, caption) => setLightbox({ url, kind, caption })}
                  />
                  <div
                    className={`mt-1 flex items-center gap-1 ${
                      message.sender === "bot" ? "justify-end" : "justify-start"
                    }`}
                  >
                    {reactionDisplayByMessageId[message.id] ? (
                      <ReactionBadge
                        emojis={reactionDisplayByMessageId[message.id].emojis}
                        total={reactionDisplayByMessageId[message.id].total}
                      />
                    ) : null}
                    <span
                      className={`text-[11px] leading-none ${
                        message.sender === "bot" ? "text-text/80" : "text-text-dim"
                      }`}
                    >
                      {message.timeLabel}
                    </span>
                    {message.sender === "bot" ? renderBotMessageState(message.status) : null}
                  </div>
                </div>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
        )}
      </div>

      <ReplyBox
        conversationId={conversationId}
        streamError={streamError}
        onOptimisticSend={addOptimisticMessage}
        onOptimisticSendFailed={removeOptimisticMessage}
      />

      {lightbox ? (
        <MediaLightbox
          url={lightbox.url}
          kind={lightbox.kind}
          caption={lightbox.caption}
          onClose={() => setLightbox(null)}
        />
      ) : null}

      {reactionPickerMessageId ? (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-end justify-end p-6">
          <div
            ref={reactionPickerRef}
            className="pointer-events-auto overflow-hidden rounded-xl border border-border/70 shadow-[0_18px_40px_rgba(0,0,0,0.38)]"
          >
            <Picker
              data={emojiData}
              previewPosition="none"
              theme="dark"
              perLine={9}
              maxFrequentRows={1}
              onEmojiSelect={(payload: { native?: string }) => {
                void sendReaction(reactionPickerMessageId, payload.native || "");
              }}
            />
          </div>
        </div>
      ) : null}

      {pendingDeleteMessageId ? (
        <DeleteConfirmModal
          loading={deleteLoading}
          onCancel={() => {
            if (deleteLoading) return;
            setPendingDeleteMessageId(null);
          }}
          onConfirm={async () => {
            setDeleteLoading(true);
            const response = await fetch(
              `/api/whatsapp/inbox/${conversationId}/messages/${pendingDeleteMessageId}`,
              {
                method: "DELETE",
              }
            );

            if (!response.ok) {
              const body = (await response.json().catch(() => ({}))) as { error?: string };
              setStreamError(body.error || "Failed to delete message");
              setDeleteLoading(false);
              return;
            }

            setMessages((current) =>
              current.filter((item) => item.id !== pendingDeleteMessageId)
            );
            setDeleteLoading(false);
            setPendingDeleteMessageId(null);
          }}
        />
      ) : null}
    </div>
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

function normalizeRealtimeStatus(
  status?: "SENT" | "DELIVERED" | "READ" | "FAILED" | "BLOCKED"
): MessageView["status"] {
  if (!status) return undefined;
  return status === "FAILED" ? "failed" : status;
}

function MessageBubbleContent({
  message,
  onOpenMedia,
}: {
  message: MessageView;
  onOpenMedia: (url: string, kind: WhatsappMediaKind, caption?: string | null) => void;
}) {
  const unwrapped = unwrapWhatsappStoredMessage(message.content);
  const media = parseStoredWhatsappMedia(unwrapped.content);
  const [failedToLoad, setFailedToLoad] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  if (!media) {
    return (
      <div className="space-y-2">
        {unwrapped.replyPreview ? (
          <div className="rounded-lg border border-border/60 bg-surface/60 px-3 py-2 text-xs text-text-muted">
            Replying to: {unwrapped.replyPreview}
          </div>
        ) : null}
        <p className="whitespace-pre-wrap text-[14px] leading-relaxed">{unwrapped.content}</p>
      </div>
    );
  }

  const mediaUrl = `/api/whatsapp/inbox/media/${message.id}`;
  const caption = media.caption?.trim();

  if (media.kind === "image" || media.kind === "sticker") {
    return (
      <div className="space-y-2">
        {unwrapped.replyPreview ? (
          <div className="rounded-lg border border-border/60 bg-surface/60 px-3 py-2 text-xs text-text-muted">
            Replying to: {unwrapped.replyPreview}
          </div>
        ) : null}
        {/* eslint-disable @next/next/no-img-element */}
        {!failedToLoad ? (
          <img
            key={`img-${reloadToken}`}
            src={mediaUrl}
            alt={caption || getMediaLabel(media.kind)}
            className="max-h-80 w-full max-w-sm cursor-zoom-in rounded-xl border border-border/60 object-contain"
            onError={() => setFailedToLoad(true)}
            onClick={() => onOpenMedia(mediaUrl, media.kind, caption)}
          />
        ) : (
          <div className="space-y-2">
            <div className="rounded-xl border border-border/60 bg-surface/60 px-3 py-2 text-xs text-text-muted">
              Media preview unavailable.
            </div>
            <a
              href={mediaUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex text-xs text-accent no-underline hover:underline"
            >
              Open media file
            </a>
            <button
              type="button"
              onClick={() => {
                setFailedToLoad(false);
                setReloadToken((value) => value + 1);
              }}
              className="inline-flex text-xs text-text-muted hover:text-text"
            >
              Retry preview
            </button>
          </div>
        )}
        {/* eslint-enable @next/next/no-img-element */}
        {caption ? <p className="whitespace-pre-wrap text-[14px] leading-relaxed">{caption}</p> : null}
      </div>
    );
  }

  if (media.kind === "video") {
    return (
      <div className="space-y-2">
        {unwrapped.replyPreview ? (
          <div className="rounded-lg border border-border/60 bg-surface/60 px-3 py-2 text-xs text-text-muted">
            Replying to: {unwrapped.replyPreview}
          </div>
        ) : null}
        {!failedToLoad ? (
          <video
            key={`video-${reloadToken}`}
            controls
            className="max-h-80 w-full max-w-sm cursor-zoom-in rounded-xl border border-border/60"
            src={mediaUrl}
            onError={() => setFailedToLoad(true)}
            onClick={() => onOpenMedia(mediaUrl, media.kind, caption)}
          />
        ) : (
          <div className="space-y-2">
            <div className="rounded-xl border border-border/60 bg-surface/60 px-3 py-2 text-xs text-text-muted">
              Media preview unavailable.
            </div>
            <a
              href={mediaUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex text-xs text-accent no-underline hover:underline"
            >
              Open media file
            </a>
            <button
              type="button"
              onClick={() => {
                setFailedToLoad(false);
                setReloadToken((value) => value + 1);
              }}
              className="inline-flex text-xs text-text-muted hover:text-text"
            >
              Retry preview
            </button>
          </div>
        )}
        {caption ? <p className="whitespace-pre-wrap text-[14px] leading-relaxed">{caption}</p> : null}
      </div>
    );
  }

  if (media.kind === "audio") {
    return (
      <div className="space-y-2">
        {unwrapped.replyPreview ? (
          <div className="rounded-lg border border-border/60 bg-surface/60 px-3 py-2 text-xs text-text-muted">
            Replying to: {unwrapped.replyPreview}
          </div>
        ) : null}
        {!failedToLoad ? (
          <audio
            key={`audio-${reloadToken}`}
            controls
            className="w-full max-w-sm"
            src={mediaUrl}
            onError={() => setFailedToLoad(true)}
          />
        ) : (
          <div className="space-y-2">
            <div className="rounded-xl border border-border/60 bg-surface/60 px-3 py-2 text-xs text-text-muted">
              Media preview unavailable.
            </div>
            <a
              href={mediaUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex text-xs text-accent no-underline hover:underline"
            >
              Open media file
            </a>
            <button
              type="button"
              onClick={() => {
                setFailedToLoad(false);
                setReloadToken((value) => value + 1);
              }}
              className="inline-flex text-xs text-text-muted hover:text-text"
            >
              Retry preview
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {unwrapped.replyPreview ? (
        <div className="rounded-lg border border-border/60 bg-surface/60 px-3 py-2 text-xs text-text-muted">
          Replying to: {unwrapped.replyPreview}
        </div>
      ) : null}
      <button
        type="button"
        onClick={() => onOpenMedia(mediaUrl, media.kind, caption)}
        className="inline-flex items-center gap-2 rounded-lg border border-border/70 bg-surface/70 px-3 py-2 text-sm text-text hover:border-border-light"
      >
        {media.filename || `View ${getMediaLabel(media.kind)}`}
      </button>
      <p className="whitespace-pre-wrap text-[14px] leading-relaxed">
        {caption || getWhatsappMessageDisplayText(message.content)}
      </p>
    </div>
  );
}

function getMediaLabel(kind: WhatsappMediaKind) {
  if (kind === "image") return "image";
  if (kind === "video") return "video";
  if (kind === "audio") return "audio";
  if (kind === "document") return "document";
  return "sticker";
}

function ReactionBadge({ emojis, total }: { emojis: string[]; total: number }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-surface/80 px-2 py-0.5 text-xs leading-none text-text shadow-[0_4px_12px_rgba(0,0,0,0.22)]">
      <span className="inline-flex items-center gap-0.5 text-sm leading-none">
        {emojis.map((emoji) => (
          <span key={emoji}>{emoji}</span>
        ))}
      </span>
      {total > 1 ? <span className="text-[11px] font-semibold text-text-muted">{total}</span> : null}
    </span>
  );
}

function MessageActions({
  message,
  side,
  open,
  onToggle,
  onClose,
  onReply,
  onReact,
  onRemoveReaction,
  canRemoveReaction,
  onDelete,
  onOpenMedia,
}: {
  message: MessageView;
  side: "left" | "right";
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onReply: (text: string) => void;
  onReact: (messageId: string) => void | Promise<void>;
  onRemoveReaction: (messageId: string) => void | Promise<void>;
  canRemoveReaction: boolean;
  onDelete: (messageId: string) => void | Promise<void>;
  onOpenMedia: (url: string, kind: WhatsappMediaKind, caption?: string | null) => void;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [verticalSide, setVerticalSide] = useState<"up" | "down">("down");
  const media = parseStoredWhatsappMedia(message.content);
  const mediaUrl = media ? `/api/whatsapp/inbox/media/${message.id}` : null;
  const displayText = getWhatsappMessageDisplayText(message.content);

  async function copyToClipboard(text: string) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Ignore clipboard failures.
    }
  }

  useEffect(() => {
    if (!open) return;

    const updatePlacement = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;

      const estimatedMenuHeight = 210;
      const spaceAbove = rect.top;
      const spaceBelow = window.innerHeight - rect.bottom;

      if (spaceBelow < estimatedMenuHeight && spaceAbove > spaceBelow) {
        setVerticalSide("up");
      } else {
        setVerticalSide("down");
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(event.target as Node)) {
        onClose();
      }
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    updatePlacement();
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
  }, [open, onClose]);

  return (
    <div
      ref={rootRef}
      className={`relative transition-opacity ${
        open
          ? "pointer-events-auto opacity-100"
          : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100"
      }`}
    >
      <button
        type="button"
        onClick={onToggle}
        className="flex h-6 w-6 cursor-pointer items-center justify-center text-text-dim transition hover:text-text"
        aria-label="Message options"
        aria-expanded={open}
      >
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          className="h-4.5 w-4.5"
          aria-hidden="true"
        >
          <path d="m3.5 6 4.5 4 4.5-4" />
        </svg>
      </button>
      {open ? (
        <div
          className={`absolute z-30 w-44 overflow-hidden rounded-xl border border-border bg-surface p-1 shadow-[0_14px_30px_rgba(0,0,0,0.35)] ${
            side === "left" ? "left-0" : "right-0"
          } ${
            verticalSide === "up" ? "bottom-full mb-1" : "top-full mt-1"
          }`}
        >
          <button
            type="button"
            onClick={() => onReply(displayText)}
            className="block w-full rounded-lg px-3 py-2 text-left text-xs text-text hover:bg-surface-2"
          >
            Reply
          </button>
          <button
            type="button"
            onClick={() => onReact(message.id)}
            className="block w-full rounded-lg px-3 py-2 text-left text-xs text-text hover:bg-surface-2"
          >
            React
          </button>
          {canRemoveReaction ? (
            <button
              type="button"
              onClick={() => onRemoveReaction(message.id)}
              className="block w-full rounded-lg px-3 py-2 text-left text-xs text-text hover:bg-surface-2"
            >
              Remove reaction
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => onDelete(message.id)}
            className="block w-full rounded-lg px-3 py-2 text-left text-xs text-text hover:bg-surface-2"
          >
            Delete
          </button>
          <button
            type="button"
            disabled
            title="Not supported by WhatsApp Business API."
            className="block w-full cursor-not-allowed rounded-lg px-3 py-2 text-left text-xs text-text-dim"
          >
            Delete for everyone
          </button>
          <button
            type="button"
            onClick={() => copyToClipboard(displayText)}
            className="block w-full rounded-lg px-3 py-2 text-left text-xs text-text hover:bg-surface-2"
          >
            Copy
          </button>
          {media && mediaUrl ? (
            <>
              <a
                href={mediaUrl}
                download
                className="block rounded-lg px-3 py-2 text-left text-xs text-text no-underline hover:bg-surface-2"
              >
                Download {getMediaLabel(media.kind)}
              </a>
              {media.kind === "image" || media.kind === "video" || media.kind === "sticker" ? (
                <button
                  type="button"
                  onClick={() => onOpenMedia(mediaUrl, media.kind, media.caption || null)}
                  className="block w-full rounded-lg px-3 py-2 text-left text-xs text-text hover:bg-surface-2"
                >
                  View full screen
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
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
        className="absolute right-5 top-5 rounded-full border border-border bg-surface px-3 py-1 text-sm text-text"
      >
        Close
      </button>
      {isZoomable ? (
        <div className="absolute right-24 top-5 flex items-center gap-2 rounded-full border border-border bg-surface px-2 py-1">
          <button
            type="button"
            onClick={() => updateZoom(zoom - 0.25)}
            className="h-7 w-7 rounded-full text-sm text-text hover:bg-surface-2"
          >
            −
          </button>
          <span className="w-14 text-center text-xs text-text-muted">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            onClick={() => updateZoom(zoom + 0.25)}
            className="h-7 w-7 rounded-full text-sm text-text hover:bg-surface-2"
          >
            +
          </button>
          <button
            type="button"
            onClick={() => {
              updateZoom(1);
              setOffset({ x: 0, y: 0 });
            }}
            className="rounded-full px-2 py-1 text-xs text-text hover:bg-surface-2"
          >
            Reset
          </button>
        </div>
      ) : null}
      <div
        className="max-h-[90vh] w-full max-w-5xl overflow-hidden rounded-2xl border border-border bg-bg p-3"
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
          <iframe title="Document preview" src={url} className="h-[80vh] w-full rounded-xl border border-border/50" />
        ) : null}
        {caption ? <p className="mt-2 text-sm text-text-muted">{caption}</p> : null}
      </div>
    </div>
  );
}

function DeleteConfirmModal({
  loading,
  onCancel,
  onConfirm,
}: {
  loading: boolean;
  onCancel: () => void;
  onConfirm: () => void | Promise<void>;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-sm rounded-2xl border border-border bg-surface p-5 shadow-[0_20px_48px_rgba(0,0,0,0.45)]">
        <h3 className="text-base font-semibold text-text">Delete message?</h3>
        <p className="mt-2 text-sm text-text-muted">
          This will remove the message from your inbox view.
        </p>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="rounded-lg border border-border px-3 py-2 text-sm text-text hover:border-border-light disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className="rounded-lg bg-red-600 px-3 py-2 text-sm font-medium text-white hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loading ? "Deleting..." : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}
