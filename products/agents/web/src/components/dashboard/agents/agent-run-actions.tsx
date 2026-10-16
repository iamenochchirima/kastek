"use client";

import { useState } from "react";
import { useRouter } from "@/lib/navigation";
import { Ban, PlayCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirmationDialog } from "@/components/ui/confirmation-provider";
import { cancelAgentRun, signalAgentRunExternalEvent } from "@/lib/agent-platform";

const terminalStatuses = new Set(["completed", "failed", "cancelled", "expired"]);

export function AgentRunActions({ runId, status, waitingFor, showCancel = true }: { runId: string; status: string; waitingFor?: string; showCancel?: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm, prompt } = useConfirmationDialog();

  if (terminalStatuses.has(status) && !error) return null;

  const cancel = async () => {
    if (busy || !await confirm({ title: "Cancel run?", description: "The run will be stopped and marked cancelled.", confirmLabel: "Cancel run", variant: "destructive" })) return;
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
    const key = await prompt({ title: status === "awaiting_human" ? "Resolve handoff" : "Send event", label: status === "awaiting_human" ? "Handoff resolution key" : "Event key", defaultValue: waitingFor || (status === "awaiting_human" ? "handoff.resolved" : "external.event"), confirmLabel: "Continue" });
    if (!key?.trim()) return;
    const payloadText = await prompt({ title: "Event payload", label: "Payload JSON", defaultValue: "{}", confirmLabel: "Send event", multiline: true });
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

  return <div className="flex flex-col items-end gap-1"><div className="flex flex-wrap justify-end gap-2">{status === "awaiting_external_event" || status === "awaiting_human" ? <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void signalExternalEvent()}><PlayCircle className="mr-1.5 h-3.5 w-3.5" />{busy ? "Resuming…" : status === "awaiting_human" ? "Resolve handoff" : "Send event"}</Button> : null}{showCancel ? <Button type="button" size="sm" variant="outline" disabled={busy || terminalStatuses.has(status)} onClick={() => void cancel()}><Ban className="mr-1.5 h-3.5 w-3.5" />{busy ? "Cancelling…" : "Cancel run"}</Button> : null}</div>{error ? <span className="max-w-48 text-right text-[11px] text-destructive" role="alert">{error}</span> : null}</div>;
}
