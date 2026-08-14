"use client";

import { useState } from "react";
import { buttonClassName } from "@/components/ui/button";

type Command = { id: string; status: string; requiredApprovals: number; approvers: string[]; result?: { status?: string } | null; error?: { message?: string } | null };

export function OperatorInstallationButton({ installationId, action }: { installationId: string; action: "suspend" | "resume" }) {
  const [command, setCommand] = useState<Command | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const commandType = action === "suspend" ? "suspend_installation" : "resume_installation";

  async function start() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/operations/commands", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `admin-${commandType}-${installationId}-${Date.now()}` },
        body: JSON.stringify({ commandType, targetId: installationId, payload: {} }),
      });
      const data = await response.json() as Command & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Unable to create operator command");
      setCommand(data);
      setMessage(data.status === "awaiting_approval" ? "Second operator approval required." : "Installation command accepted.");
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
      setMessage("Installation command completed.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to approve operator command");
    } finally {
      setBusy(false);
    }
  }

  return <div className="flex flex-col items-end gap-1"><button type="button" disabled={busy || Boolean(command && command.status !== "failed")} onClick={() => void start()} className={buttonClassName({ variant: "ghost", size: "sm" })}>{busy ? "Submitting…" : action === "suspend" ? "Suspend" : "Resume"}</button>{command?.status === "awaiting_approval" ? <button type="button" disabled={busy} onClick={() => void approve()} className={buttonClassName({ variant: "secondary", size: "sm" })}>{busy ? "Approving…" : "Approve"}</button> : null}{message ? <span className="max-w-48 text-right text-[11px] text-muted-foreground">{message}</span> : null}</div>;
}

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

function OperatorRecoveryCommandButton({ commandType, targetId, label, completedMessage, payload = {} }: {
  commandType: "retry_run" | "replay_delivery";
  targetId: string;
  label: string;
  completedMessage: string;
  payload?: Record<string, unknown>;
}) {
  const [command, setCommand] = useState<Command | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/operations/commands", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": `admin-${commandType}-${targetId}-${Date.now()}` },
        body: JSON.stringify({ commandType, targetId, payload }),
      });
      const data = await response.json() as Command & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Unable to create operator command");
      setCommand(data);
      setMessage(data.status === "awaiting_approval" ? "Second operator approval required." : completedMessage);
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
      setMessage(completedMessage);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to approve operator command");
    } finally {
      setBusy(false);
    }
  }

  return <div className="flex flex-col items-end gap-1">
    {!command || command.status === "failed" ? <button type="button" disabled={busy} onClick={() => void start()} className={buttonClassName({ variant: "secondary", size: "sm" })}>{busy ? "Submitting…" : label}</button> : null}
    {command?.status === "awaiting_approval" ? <button type="button" disabled={busy} onClick={() => void approve()} className={buttonClassName({ variant: "secondary", size: "sm" })}>{busy ? "Approving…" : "Approve as second operator"}</button> : null}
    {message ? <span className="max-w-56 text-right text-[11px] text-muted-foreground">{message}</span> : null}
  </div>;
}

export function OperatorRetryButton({ runId }: { runId: string }) {
  return <OperatorRecoveryCommandButton commandType="retry_run" targetId={runId} label="Retry run" completedMessage="Run retry dispatched." />;
}

export function OperatorDeliveryReplayButton({ attemptId, status }: { attemptId: string; status: "failed" | "unknown" }) {
  return <OperatorRecoveryCommandButton
    commandType="replay_delivery"
    targetId={attemptId}
    label={status === "unknown" ? "Confirm & replay" : "Replay delivery"}
    completedMessage="Delivery replay queued."
    payload={status === "unknown" ? { confirmUnknown: true } : {}}
  />;
}
