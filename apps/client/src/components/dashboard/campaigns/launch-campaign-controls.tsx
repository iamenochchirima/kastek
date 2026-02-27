"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function LaunchCampaignControls({
  campaignId,
  status,
}: {
  campaignId: string;
  status: string;
}) {
  const router = useRouter();
  const [scheduledAt, setScheduledAt] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const isLocked = ["SENDING", "COMPLETED"].includes(status);

  async function launch(shouldSchedule: boolean) {
    setLoading(true);
    setError("");

    try {
      const res = await fetch(`/api/whatsapp/campaigns/${campaignId}/launch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          scheduledAt: shouldSchedule ? scheduledAt : undefined,
        }),
      });

      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error || "Launch failed");
      }

      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Launch failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-xl border border-border bg-surface p-5">
      <h2 className="mb-3 text-sm font-semibold">Launch controls</h2>

      {error && (
        <div className="mb-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-[1fr_auto_auto]">
        <input
          type="datetime-local"
          value={scheduledAt}
          onChange={(event) => setScheduledAt(event.target.value)}
          disabled={loading || isLocked}
          className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm outline-none ring-accent/30 focus:ring disabled:opacity-60"
        />

        <button
          type="button"
          onClick={() => launch(true)}
          disabled={loading || isLocked || !scheduledAt}
          className="rounded-lg border border-border px-4 py-2 text-sm text-text transition-colors hover:border-border-light disabled:opacity-60"
        >
          {loading ? "Working..." : "Schedule"}
        </button>

        <button
          type="button"
          onClick={() => launch(false)}
          disabled={loading || isLocked}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-bg transition-all hover:-translate-y-0.5 disabled:opacity-60 disabled:hover:translate-y-0"
        >
          {loading ? "Working..." : "Launch now"}
        </button>
      </div>

      {isLocked && (
        <p className="mt-3 text-xs text-text-muted">
          Campaign is already active or completed. Launch controls are disabled.
        </p>
      )}
    </div>
  );
}
