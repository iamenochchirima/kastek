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
    try {
      const res = await fetch("/api/outreach/sync-drafts", { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Import failed");
      const failures = Array.isArray(data.failures) ? data.failures : [];
      setResult(`${data.updated}/${data.matched} imported${failures.length ? ` · ${failures.length} failed: ${failures.map((failure: {leadId:string;status:number}) => `${failure.leadId} (${failure.status})`).join(", ")}` : ""}`);
      router.refresh();
    } catch (error) {
      setResult(error instanceof Error ? error.message : "Import failed");
    } finally { setLoading(false); }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        onClick={runSync}
        disabled={loading}
        className="border border-border hover:bg-secondary text-foreground px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-50"
      >
        {loading ? "Importing…" : "Import drafts"}
      </button>
      {result ? <p role="status" className="break-all text-xs text-muted-foreground">{result}</p> : null}
    </div>
  );
}
