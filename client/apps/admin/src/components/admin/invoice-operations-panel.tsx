"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { buttonClassName } from "@/components/ui/button";
import { StatusBadge } from "@/components/admin/status-badge";

type InvoiceRun = {
  id: string;
  cycleKey: string;
  issueDate: string;
  dueDate: string;
  status: string;
  sendStatus: string;
  reminderStatus: string;
  sentAt?: string | null;
  reminderDueAt?: string | null;
  reminderSentAt?: string | null;
  paidAt?: string | null;
};

type Props = {
  invoiceId: string;
  currentRun?: InvoiceRun | null;
  recentRuns?: InvoiceRun[];
  operations?: {
    recurring_client?: boolean;
    needs_invoice_send?: boolean;
    needs_reminder?: boolean;
    cycle_label?: string | null;
  } | null;
};

function formatDate(value?: string | null) {
  if (!value) return "Not set";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Not set";
  return date.toLocaleDateString();
}

export default function InvoiceOperationsPanel({
  invoiceId,
  currentRun,
  recentRuns = [],
  operations,
}: Props) {
  const router = useRouter();
  const [loadingAction, setLoadingAction] = useState<string | null>(null);
  const [error, setError] = useState("");

  async function runAction(action: string) {
    if (!currentRun) return;
    setLoadingAction(action);
    setError("");

    try {
      const res = await fetch(`/api/invoices/${invoiceId}/runs/${currentRun.id}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to update billing cycle");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update billing cycle");
    } finally {
      setLoadingAction(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="v-card space-y-5 p-[var(--density-card-padding)]">
        <div>
          <p className="v-label">Billing operations</p>
          <h2 className="mt-1 text-lg font-semibold text-foreground">Current billing cycle</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Operational tracking for monthly invoice send dates, overdue reminder follow-up, and payment confirmation.
          </p>
        </div>

        {error ? (
          <div className="rounded-lg border border-status-danger/25 bg-status-danger-soft px-4 py-3 text-sm text-status-danger">
            {error}
          </div>
        ) : null}

        {!operations?.recurring_client ? (
          <div className="rounded-md border border-status-attention/25 bg-status-attention-soft px-4 py-4 text-sm text-foreground">
            This invoice is currently configured as a one-off record. Switch it to monthly recurring in the builder to start cycle tracking and reminder actions.
          </div>
        ) : currentRun ? (
          <div className="space-y-4">
            <div className="grid md:grid-cols-2 gap-4">
              <div className="rounded-md border border-border bg-background p-4">
                <p className="v-label">Current cycle</p>
                <p className="mt-2 text-lg font-semibold text-foreground">{currentRun.cycleKey}</p>
                <p className="mt-2 text-sm text-muted-foreground">
                  Issue date {formatDate(currentRun.issueDate)} · Due {formatDate(currentRun.dueDate)}
                </p>
              </div>
              <div className="rounded-md border border-border bg-background p-4">
                <p className="v-label">Operational status</p>
                <div className="mt-2"><StatusBadge value={currentRun.status} /></div>
                <p className="mt-2 text-sm text-muted-foreground">
                  Send: {currentRun.sendStatus} · Reminder: {currentRun.reminderStatus}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => runAction("mark_sent")}
                disabled={loadingAction !== null}
                className={buttonClassName({ variant: "primary", size: "md" })}
              >
                {loadingAction === "mark_sent" ? "Saving..." : "Mark Invoice Sent"}
              </button>
              <button
                type="button"
                onClick={() => runAction("mark_reminder_sent")}
                disabled={loadingAction !== null}
                className={buttonClassName({ variant: "outline", size: "md" })}
              >
                {loadingAction === "mark_reminder_sent" ? "Saving..." : "Mark Reminder Sent"}
              </button>
              <button
                type="button"
                onClick={() => runAction("mark_paid")}
                disabled={loadingAction !== null}
                className={buttonClassName({ variant: "secondary", size: "md", className: "border-status-success/30 bg-status-success-soft text-status-success hover:bg-status-success-soft" })}
              >
                {loadingAction === "mark_paid" ? "Saving..." : "Mark Paid"}
              </button>
              <button
                type="button"
                onClick={() => runAction("reopen_cycle")}
                disabled={loadingAction !== null}
                className={buttonClassName({ variant: "ghost", size: "md" })}
              >
                {loadingAction === "reopen_cycle" ? "Saving..." : "Reopen Cycle"}
              </button>
            </div>

            <div className="grid md:grid-cols-3 gap-4 text-sm">
              <div className="rounded-md border border-border bg-background px-4 py-3">
                <p className="v-label">Invoice sent</p>
                <p className="mt-2 text-foreground">{formatDate(currentRun.sentAt)}</p>
              </div>
              <div className="rounded-md border border-border bg-background px-4 py-3">
                <p className="v-label">Reminder due</p>
                <p className="mt-2 text-foreground">{formatDate(currentRun.reminderDueAt)}</p>
              </div>
              <div className="rounded-md border border-border bg-background px-4 py-3">
                <p className="v-label">Reminder sent</p>
                <p className="mt-2 text-foreground">{formatDate(currentRun.reminderSentAt || currentRun.paidAt)}</p>
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-card px-4 py-4 text-sm text-muted-foreground">
            No active cycle has been generated yet for this monthly client.
          </div>
        )}
      </div>

      {recentRuns.length > 0 ? (
        <div className="v-card overflow-hidden">
          <div className="border-b border-border px-5 py-4">
            <h3 className="text-sm font-semibold text-foreground">Recent billing cycles</h3>
          </div>
          <div className="divide-y divide-border">
            {recentRuns.map((run) => (
              <div key={run.id} className="grid gap-2 px-5 py-4 text-sm sm:grid-cols-[1.1fr_1fr_1fr_1.1fr] sm:gap-4">
                <div>
                  <p className="font-medium text-foreground">{run.cycleKey}</p>
                  <p className="text-xs text-ink-3">Issued {formatDate(run.issueDate)}</p>
                </div>
                <div className="text-muted-foreground">Due {formatDate(run.dueDate)}</div>
                <div><StatusBadge value={run.status} /></div>
                <div className="text-muted-foreground">
                  Send {run.sendStatus} · Reminder {run.reminderStatus}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
