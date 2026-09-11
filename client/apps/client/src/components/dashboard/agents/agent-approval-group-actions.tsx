"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirmationDialog } from "@/components/ui/confirmation-provider";
import { decideAgentRunApprovalGroup, type AgentApprovalGroup } from "@/lib/agent-platform";

export function AgentApprovalGroupActions({ runId, group, onDecided }: { runId: string; group: AgentApprovalGroup; onDecided?: (decision: "approved" | "rejected") => void }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"approved" | "rejected" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { confirm } = useConfirmationDialog();
  if (group.status !== "pending" && !error) return <p className="text-sm text-muted-foreground">This approval group has already been decided.</p>;

  const decide = async (decision: "approved" | "rejected") => {
    if (busy || !await confirm({
      title: decision === "approved" ? "Approve all actions?" : "Deny all actions?",
      confirmLabel: decision === "approved" ? "Approve all" : "Deny all",
      variant: decision === "approved" ? "default" : "destructive",
    })) return;
    setBusy(decision); setError(null);
    try {
      await decideAgentRunApprovalGroup(runId, group, decision);
      onDecided?.(decision);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to record approval decision");
    } finally {
      setBusy(null);
    }
  };

  return <div className="flex flex-wrap items-center gap-2"><Button type="button" disabled={busy !== null} onClick={() => void decide("approved")}><Check className="mr-1.5 h-4 w-4" />{busy === "approved" ? "Approving…" : "Approve all"}</Button><Button type="button" variant="outline" disabled={busy !== null} onClick={() => void decide("rejected")}><X className="mr-1.5 h-4 w-4" />{busy === "rejected" ? "Denying…" : "Deny all"}</Button>{error ? <p className="basis-full text-sm text-destructive" role="alert">{error}</p> : null}</div>;
}
