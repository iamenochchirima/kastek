"use client";

import { useState } from "react";
import { buttonClassName } from "@/components/ui/button";

type ReplayCommand = {
  id: string;
  status: string;
  approverIds?: string[];
  error?: string | null;
  result?: { status?: string; attemptCount?: number } | null;
};

export function AdminWebhookReplayButton({
  deliveryId,
  expectedAttemptCount,
}: {
  deliveryId: string;
  expectedAttemptCount: number;
}) {
  const [command, setCommand] = useState<ReplayCommand | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function requestReplay() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/operations/webhooks/replays", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": `admin-webhook-replay-${deliveryId}-${Date.now()}`,
        },
        body: JSON.stringify({
          deliveryId,
          expectedStatus: "FAILED",
          expectedAttemptCount,
        }),
      });
      const data = (await response.json()) as ReplayCommand & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Unable to request webhook replay");
      setCommand(data);
      setMessage(
        data.status === "awaiting_approval"
          ? "Second operator approval required."
          : "Webhook replay queued.",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to request webhook replay");
    } finally {
      setBusy(false);
    }
  }

  async function approveReplay() {
    if (!command) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/operations/webhooks/replays/${encodeURIComponent(command.id)}/approve`,
        { method: "POST" },
      );
      const data = (await response.json()) as ReplayCommand & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Unable to approve webhook replay");
      setCommand(data);
      setMessage(
        data.status === "completed"
          ? "Webhook replay queued."
          : data.error ?? "Webhook replay approval recorded.",
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to approve webhook replay");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      {!command || command.status === "failed" ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void requestReplay()}
          className={buttonClassName({ variant: "secondary", size: "sm" })}
        >
          {busy ? "Submitting…" : "Replay webhook"}
        </button>
      ) : null}
      {command?.status === "awaiting_approval" ? (
        <button
          type="button"
          disabled={busy}
          onClick={() => void approveReplay()}
          className={buttonClassName({ variant: "secondary", size: "sm" })}
        >
          {busy ? "Approving…" : "Approve as second operator"}
        </button>
      ) : null}
      {message ? (
        <span className="max-w-56 text-right text-[11px] text-muted-foreground">
          {message}
        </span>
      ) : null}
    </div>
  );
}
