"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function OutreachSyncDraftsButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  async function runSync() {
    setLoading(true);
    setResult(null);
    const res = await fetch("/api/outreach/sync-drafts", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    setLoading(false);

    if (!res.ok) {
      setResult(data?.error || "Sync failed");
      return;
    }

    setResult(
      `Synced ${data.updated}/${data.matched} matched leads. Sendable now: ${data.sendable}.`
    );
    router.refresh();
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={runSync}
        disabled={loading}
        className="border border-border hover:bg-secondary text-foreground px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
      >
        {loading ? "Syncing..." : "Sync Drafts to Leads"}
      </button>
      {result ? <p className="text-xs text-muted-foreground">{result}</p> : null}
    </div>
  );
}
