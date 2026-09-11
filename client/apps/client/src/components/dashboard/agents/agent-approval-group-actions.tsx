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
  const [selected, setSelected] = useState<string[]>(group.operations.filter((operation) => operation.status === "pending").map((operation) => operation.runtimeOperationId ?? operation.providerToolCallId));
  const [error, setError] = useState<string | null>(null);
  const { confirm } = useConfirmationDialog();
  if (group.status !== "pending" && !error) return <p className="text-sm text-muted-foreground">This approval group has already been decided.</p>;

  const decide = async (decision: "approved" | "rejected", operationIds?: string[]) => {
    const count = operationIds?.length ?? group.operations.length;
    if (decision === "approved" && count === 0) return;
    if (busy || !await confirm({
      title: decision === "approved" ? `Approve ${count === group.operations.length ? "all actions" : `${count} actions`}?` : "Reject all actions?",
      confirmLabel: decision === "approved" ? count === group.operations.length ? "Approve all" : "Approve selected" : "Reject",
      variant: decision === "approved" ? "default" : "destructive",
    })) return;
    setBusy(decision); setError(null);
    try {
      await decideAgentRunApprovalGroup(runId, group, decision, decision === "approved" && count !== group.operations.length ? operationIds : undefined);
      onDecided?.(decision);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to record approval decision");
    } finally {
      setBusy(null);
    }
  };

  const allOperationIds = group.operations.map((operation) => operation.runtimeOperationId ?? operation.providerToolCallId);
  const allSelected = selected.length === allOperationIds.length;
  return <div className="flex flex-wrap items-center gap-2">
    {group.operations.length > 1 ? <div className="basis-full space-y-1.5 rounded-md border border-border/70 bg-background/30 p-2">
      <p className="text-xs font-medium text-foreground">Approve selected</p>
      {group.operations.map((operation) => {
        const operationId = operation.runtimeOperationId ?? operation.providerToolCallId;
        const checked = selected.includes(operationId);
        return <label key={operationId} className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={checked} disabled={busy !== null} onChange={(event) => setSelected((current) => event.target.checked ? [...new Set([...current, operationId])] : current.filter((value) => value !== operationId))} /> <span className="truncate">{operation.capability}</span></label>;
      })}
    </div> : null}
    <Button type="button" disabled={busy !== null} onClick={() => void decide("approved", allOperationIds)}><Check className="mr-1.5 h-4 w-4" />{busy === "approved" ? "Approving…" : "Approve all"}</Button>
    {group.operations.length > 1 && !allSelected ? <Button type="button" variant="outline" disabled={busy !== null || selected.length === 0} onClick={() => void decide("approved", selected)}><Check className="mr-1.5 h-4 w-4" />Approve selected</Button> : null}
    <Button type="button" variant="outline" disabled={busy !== null} onClick={() => void decide("rejected")}><X className="mr-1.5 h-4 w-4" />{busy === "rejected" ? "Rejecting…" : "Reject"}</Button>
    {error ? <p className="basis-full text-sm text-destructive" role="alert">{error}</p> : null}
  </div>;
}
