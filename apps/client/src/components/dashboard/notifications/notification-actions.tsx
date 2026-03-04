"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function NotificationActions() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function markAllRead() {
    setLoading(true);
    try {
      const res = await fetch("/api/notifications", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "mark_all_read" }),
      });

      if (!res.ok) {
        throw new Error("Failed to mark notifications as read");
      }

      router.refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={markAllRead}
      disabled={loading}
      className="rounded-full border border-border px-4 py-2 text-sm font-medium text-text transition-colors hover:border-border-light hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {loading ? "Updating..." : "Mark all read"}
    </button>
  );
}
