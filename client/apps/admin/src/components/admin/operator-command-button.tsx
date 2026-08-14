"use client";

import { useState } from "react";
import { buttonClassName } from "@/components/ui/button";

type Command = { id: string; status: string; requiredApprovals: number; approvers: string[]; result?: { status?: string } | null; error?: { message?: string } | null };

export function OperatorReconcileButton({ effectId }: { effectId: string }) {
  const [command, setCommand] = useState<Command | null>(null);
  const [outcome, setOutcome] = useState<"succeeded" | "failed">("failed");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/operations/commands", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `admin-reconcile-${effectId}-${Date.now()}` },
        body: JSON.stringify({ commandType: "reconcile_effect", targetId: effectId, payload: outcome === "failed" ? { outcome, error: { code: "OPERATOR_CONFIRMED_FAILURE" } } : { outcome } }),
      });
      const data = await response.json() as Command & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Unable to create operator command");
      setCommand(data);
      setMessage(data.status === "awaiting_approval" ? "Second operator approval required." : "Reconciliation command accepted.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to create operator command");
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!command) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/operations/commands/${encodeURIComponent(command.id)}/approve`, { method: "POST" });
      const data = await response.json() as Command & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Unable to approve operator command");
      setCommand(data);
      setMessage("Reconciliation command completed.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to approve operator command");
    } finally {
      setBusy(false);
    }
  }

  return <div className="flex flex-col items-end gap-1.5">
    {!command || command.status === "failed" ? <div className="flex items-center gap-2">
      <label className="sr-only" htmlFor={`reconcile-outcome-${effectId}`}>Reconciliation outcome</label>
      <select id={`reconcile-outcome-${effectId}`} value={outcome} onChange={(event) => setOutcome(event.target.value as "succeeded" | "failed")} disabled={busy} className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground">
        <option value="failed">Provider failed</option>
        <option value="succeeded">Provider succeeded</option>
      </select>
      <button type="button" disabled={busy} onClick={() => void start()} className={buttonClassName({ variant: "secondary", size: "sm" })}>{busy ? "Submitting…" : "Request resolution"}</button>
    </div> : null}
    {command?.status === "awaiting_approval" ? <button type="button" disabled={busy} onClick={() => void approve()} className={buttonClassName({ variant: "secondary", size: "sm" })}>{busy ? "Approving…" : "Approve as second operator"}</button> : null}
    {message ? <span className="max-w-56 text-right text-[11px] text-muted-foreground">{message}</span> : null}
  </div>;
}
