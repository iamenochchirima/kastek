"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, SendHorizontal, Smile, X } from "lucide-react";
import Picker from "@emoji-mart/react";
import emojiData from "@emoji-mart/data";

export default function ReplyBox({
  conversationId,
  streamError,
  onOptimisticSend,
  onOptimisticSendFailed,
}: {
  conversationId: string;
  streamError?: string;
  onOptimisticSend?: (text: string) => void;
  onOptimisticSendFailed?: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [replyToMessageId, setReplyToMessageId] = useState<string | null>(null);
  const [replyPreview, setReplyPreview] = useState("");
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const emojiPickerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDraftReply = (event: Event) => {
      const custom = event as CustomEvent<{ text?: string; messageId?: string }>;
      const replyText = custom.detail?.text?.trim();
      if (!replyText) return;
      if (custom.detail?.messageId) {
        setReplyToMessageId(custom.detail.messageId);
        setReplyPreview(replyText);
      }
      inputRef.current?.focus();
    };

    window.addEventListener("kasiai:inbox-reply-draft", onDraftReply as EventListener);
    return () => {
      window.removeEventListener("kasiai:inbox-reply-draft", onDraftReply as EventListener);
    };
  }, []);

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

  function insertEmojiAtCursor(emoji: string) {
    if (!emoji) return;
    const textarea = inputRef.current;
    const start = textarea?.selectionStart ?? text.length;
    const end = textarea?.selectionEnd ?? text.length;
    const nextText = `${text.slice(0, start)}${emoji}${text.slice(end)}`;
    setText(nextText);
    setShowEmojiPicker(false);

    requestAnimationFrame(() => {
      if (!textarea) return;
      textarea.focus();
      const cursor = start + emoji.length;
      textarea.setSelectionRange(cursor, cursor);
    });
  }

  async function sendReply() {
    const trimmed = text.trim();
    if (!trimmed && !selectedFile) return;

    setLoading(true);
    setError("");
    if (trimmed && !selectedFile) {
      onOptimisticSend?.(trimmed);
    }
    const originalText = trimmed;
    const originalFile = selectedFile;
    const originalReplyToMessageId = replyToMessageId;
    setText("");
    setSelectedFile(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }

    try {
      const requestBody = new FormData();
      if (originalText) {
        requestBody.append("text", originalText);
      }
      if (originalFile) {
        requestBody.append("file", originalFile);
      }
      if (originalReplyToMessageId) {
        requestBody.append("replyToMessageId", originalReplyToMessageId);
      }

      const res = await fetch(`/api/whatsapp/inbox/${conversationId}/messages`, {
        method: "POST",
        body: requestBody,
      });

      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error || "Failed to send reply");
      }

      setReplyToMessageId(null);
      setReplyPreview("");
    } catch (err) {
      if (originalText && !originalFile) {
        onOptimisticSendFailed?.(originalText);
      }
      setError(err instanceof Error ? err.message : "Failed to send reply");
      setText(originalText);
      setSelectedFile(originalFile || null);
      setReplyToMessageId(originalReplyToMessageId);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-xl border border-border/60 bg-surface/95 p-2.5 shadow-[0_10px_24px_rgba(0,0,0,0.2)]">
      {error || streamError ? (
        <div className="mb-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error || streamError}
        </div>
      ) : null}

      {replyToMessageId ? (
        <div className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-surface-2/70 px-3 py-2 text-xs text-text-muted">
          <span className="truncate">Replying to: {replyPreview}</span>
          <button
            type="button"
            onClick={() => {
              setReplyToMessageId(null);
              setReplyPreview("");
            }}
            className="text-text-dim hover:text-text"
          >
            Cancel
          </button>
        </div>
      ) : null}

      {selectedFile ? (
        <div className="mb-2 flex items-center justify-between gap-3 rounded-lg border border-border/70 bg-surface-2/70 px-3 py-2 text-xs text-text-muted">
          <span className="truncate">Attached: {selectedFile.name}</span>
          <button
            type="button"
            onClick={() => {
              setSelectedFile(null);
              if (fileInputRef.current) fileInputRef.current.value = "";
            }}
            className="inline-flex h-6 w-6 items-center justify-center rounded-full text-text-dim hover:bg-surface-3/70 hover:text-text"
            title="Remove attachment"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : null}

      <div className="relative flex items-center gap-2">
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={(event) => {
            const next = event.target.files?.[0] || null;
            setSelectedFile(next);
          }}
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-text-dim hover:bg-surface-2/70 hover:text-text"
          title="Attach"
        >
          <Plus className="h-5 w-5" />
        </button>
        <textarea
          ref={inputRef}
          rows={1}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void sendReply();
            }
          }}
          placeholder={selectedFile ? "Add a caption (optional)" : "Type a message"}
          className="max-h-32 min-h-[38px] w-full resize-none rounded-full border border-border/70 bg-surface-2/80 px-4 py-2 text-[15px] text-text outline-none placeholder:text-text-dim focus:border-border-light"
        />
        <button
          type="button"
          onClick={() => setShowEmojiPicker((current) => !current)}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-text-dim hover:bg-surface-2/70 hover:text-text"
          title="Emoji"
        >
          <Smile className="h-[18px] w-[18px]" />
        </button>
        {showEmojiPicker ? (
          <div
            ref={emojiPickerRef}
            className="absolute bottom-[calc(100%+10px)] right-10 z-50 overflow-hidden rounded-xl border border-border/70 shadow-[0_16px_36px_rgba(0,0,0,0.35)]"
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
        <button
          type="button"
          onClick={sendReply}
          disabled={loading || (!text.trim() && !selectedFile)}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-bg shadow-[0_8px_16px_rgba(196,240,77,0.18)] disabled:opacity-60"
          title="Send message"
        >
          {loading ? "…" : <SendHorizontal className="h-[18px] w-[18px]" />}
        </button>
      </div>
    </div>
  );
}
