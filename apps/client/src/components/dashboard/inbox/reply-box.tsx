"use client";

import { useState } from "react";

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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function sendReply() {
    const trimmed = text.trim();
    if (!trimmed) return;

    setLoading(true);
    setError("");
    onOptimisticSend?.(trimmed);
    setText("");

    try {
      const res = await fetch(`/api/whatsapp/inbox/${conversationId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: trimmed,
        }),
      });

      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error || "Failed to send reply");
      }
    } catch (err) {
      onOptimisticSendFailed?.(trimmed);
      setError(err instanceof Error ? err.message : "Failed to send reply");
      setText(trimmed);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-3 rounded-xl border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">Reply</h2>
        <p className="text-xs text-text-muted">
          Works for active WhatsApp service conversations on the connected number.
        </p>
      </div>

      {error || streamError ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error || streamError}
        </div>
      ) : null}

      <textarea
        rows={4}
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Type your reply..."
        className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text"
      />

      <div className="flex justify-end">
        <button
          type="button"
          onClick={sendReply}
          disabled={loading || !text.trim()}
          className="rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-bg disabled:opacity-60"
        >
          {loading ? "Queueing..." : "Send reply"}
        </button>
      </div>
    </div>
  );
}
