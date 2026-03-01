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
  const [notice, setNotice] = useState("");

  const isLocked = ["SENDING", "COMPLETED"].includes(status);

  async function launch(shouldSchedule: boolean) {
    setLoading(true);
    setError("");
    setNotice("");

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
      setNotice(shouldSchedule ? "Campaign scheduled." : "Campaign launched.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Launch failed");
    } finally {
      setLoading(false);
    }
  }

  async function updateCampaign(
    action: "pause" | "resume" | "cancel" | "retry_failed",
    successMessage: string
  ) {
    setLoading(true);
    setError("");
    setNotice("");

    try {
      const res = await fetch(`/api/whatsapp/campaigns/${campaignId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          action,
          scheduledAt: action === "resume" ? scheduledAt || undefined : undefined,
        }),
      });

      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error || "Campaign update failed");
      }

      setNotice(successMessage);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Campaign update failed");
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

      {notice && (
        <div className="mb-3 rounded-lg border border-green-500/30 bg-green-500/10 px-3 py-2 text-xs text-green-300">
          {notice}
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
          Direct launch is disabled while the campaign is already sending or completed. Use the
          action buttons below to pause, cancel, or retry.
        </p>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        {["SENDING", "SCHEDULED"].includes(status) ? (
          <button
            type="button"
            onClick={() => updateCampaign("pause", "Campaign paused.")}
            disabled={loading}
            className="rounded-lg border border-border px-4 py-2 text-sm text-text transition-colors hover:border-border-light disabled:opacity-60"
          >
            {loading ? "Working..." : "Pause"}
          </button>
        ) : null}

        {status === "PAUSED" ? (
          <button
            type="button"
            onClick={() => updateCampaign("resume", "Campaign resumed.")}
            disabled={loading}
            className="rounded-lg border border-border px-4 py-2 text-sm text-text transition-colors hover:border-border-light disabled:opacity-60"
          >
            {loading ? "Working..." : "Resume"}
          </button>
        ) : null}

        {!["COMPLETED"].includes(status) ? (
          <button
            type="button"
            onClick={() => updateCampaign("cancel", "Campaign cancelled.")}
            disabled={loading}
            className="rounded-lg border border-red-500/30 px-4 py-2 text-sm text-red-300 transition-colors hover:border-red-400/40 disabled:opacity-60"
          >
            {loading ? "Working..." : "Cancel"}
          </button>
        ) : null}

        <button
          type="button"
          onClick={() => updateCampaign("retry_failed", "Failed recipients requeued.")}
          disabled={loading}
          className="rounded-lg border border-border px-4 py-2 text-sm text-text transition-colors hover:border-border-light disabled:opacity-60"
        >
          {loading ? "Working..." : "Retry failed"}
        </button>
      </div>
    </div>
  );
}
