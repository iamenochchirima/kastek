"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Ban } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cancelAgentRun } from "@/lib/agent-platform";

const terminalStatuses = new Set(["completed", "failed", "cancelled", "expired"]);

export function AgentRunActions({ runId, status }: { runId: string; status: string }) {
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

  return <div className="flex flex-col items-end gap-1"><Button type="button" size="sm" variant="outline" disabled={busy || terminalStatuses.has(status)} onClick={() => void cancel()}><Ban className="mr-1.5 h-3.5 w-3.5" />{busy ? "Cancelling…" : "Cancel run"}</Button>{error ? <span className="max-w-48 text-right text-[11px] text-destructive" role="alert">{error}</span> : null}</div>;
}
