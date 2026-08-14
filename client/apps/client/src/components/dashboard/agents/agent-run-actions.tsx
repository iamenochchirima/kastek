"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Ban, PlayCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cancelAgentRun, signalAgentRunExternalEvent } from "@/lib/agent-platform";

const terminalStatuses = new Set(["completed", "failed", "cancelled", "expired"]);

export function AgentRunActions({ runId, status, waitingFor }: { runId: string; status: string; waitingFor?: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (terminalStatuses.has(status) && !error) return null;

  const cancel = async () => {
    if (busy || !window.confirm("Cancel this run? The durable run will be marked cancelled.")) return;
    setBusy(true);
    setError(null);
    try {
      await cancelAgentRun(runId, "Cancelled from Agent activity");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to cancel run");
    } finally {
      setBusy(false);
    }
  };

  const signalExternalEvent = async () => {
    if (busy) return;
    const key = window.prompt(status === "awaiting_human" ? "Handoff resolution key" : "Event key", waitingFor || (status === "awaiting_human" ? "handoff.resolved" : "external.event"));
    if (!key?.trim()) return;
    const payloadText = window.prompt("Event payload JSON", "{}");
    if (payloadText === null) return;
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(payloadText);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Payload must be a JSON object");
      payload = parsed as Record<string, unknown>;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Invalid event payload");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await signalAgentRunExternalEvent(runId, { key: key.trim(), payload });
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to signal external event");
    } finally {
      setBusy(false);
    }
  };

  return <div className="flex flex-col items-end gap-1"><div className="flex flex-wrap justify-end gap-2">{status === "awaiting_external_event" || status === "awaiting_human" ? <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void signalExternalEvent()}><PlayCircle className="mr-1.5 h-3.5 w-3.5" />{busy ? "Resuming…" : status === "awaiting_human" ? "Resolve handoff" : "Send event"}</Button> : null}<Button type="button" size="sm" variant="outline" disabled={busy || terminalStatuses.has(status)} onClick={() => void cancel()}><Ban className="mr-1.5 h-3.5 w-3.5" />{busy ? "Cancelling…" : "Cancel run"}</Button></div>{error ? <span className="max-w-48 text-right text-[11px] text-destructive" role="alert">{error}</span> : null}</div>;
}
