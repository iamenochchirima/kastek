"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function ReplyBox({ conversationId }: { conversationId: string }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function sendReply() {
    if (!text.trim()) return;

    setLoading(true);
    setError("");

    try {
      const res = await fetch(`/api/whatsapp/inbox/${conversationId}/messages`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: text.trim(),
        }),
      });

      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error || "Failed to send reply");
      }

      setText("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send reply");
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

      {error ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
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
          {loading ? "Sending..." : "Send reply"}
        </button>
      </div>
    </div>
  );
}
