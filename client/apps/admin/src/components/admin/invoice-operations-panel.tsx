"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

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
      <div className="bg-surface-raised rounded-xl border border-border p-5 space-y-4">
        <div>
          <h2 className="font-semibold text-text">Billing Operations</h2>
          <p className="text-sm text-text-muted mt-1">
            Operational tracking for monthly invoice send dates, overdue reminder follow-up, and payment confirmation.
          </p>
        </div>

        {error ? (
          <div className="rounded-lg border border-danger/20 bg-danger/10 px-4 py-3 text-sm text-danger">
            {error}
          </div>
        ) : null}

        {!operations?.recurring_client ? (
          <div className="rounded-lg border border-border bg-surface px-4 py-4 text-sm text-text-muted">
            This invoice is currently configured as a one-off record. Switch it to monthly recurring in the builder to start cycle tracking and reminder actions.
          </div>
        ) : currentRun ? (
          <div className="space-y-4">
            <div className="grid md:grid-cols-2 gap-4">
              <div className="rounded-xl border border-border bg-surface p-4">
                <p className="text-xs uppercase tracking-wide text-text-faint">Current Cycle</p>
                <p className="mt-2 text-lg font-semibold text-text">{currentRun.cycleKey}</p>
                <p className="mt-2 text-sm text-text-muted">
                  Issue date {formatDate(currentRun.issueDate)} · Due {formatDate(currentRun.dueDate)}
                </p>
              </div>
              <div className="rounded-xl border border-border bg-surface p-4">
                <p className="text-xs uppercase tracking-wide text-text-faint">Operational Status</p>
                <p className="mt-2 text-lg font-semibold text-text capitalize">{currentRun.status.replace(/_/g, " ")}</p>
                <p className="mt-2 text-sm text-text-muted">
                  Send: {currentRun.sendStatus} · Reminder: {currentRun.reminderStatus}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => runAction("mark_sent")}
                disabled={loadingAction !== null}
                className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-primary-dark disabled:opacity-50"
              >
                {loadingAction === "mark_sent" ? "Saving..." : "Mark Invoice Sent"}
              </button>
              <button
                type="button"
                onClick={() => runAction("mark_reminder_sent")}
                disabled={loadingAction !== null}
                className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-text transition-colors hover:bg-surface-overlay disabled:opacity-50"
              >
                {loadingAction === "mark_reminder_sent" ? "Saving..." : "Mark Reminder Sent"}
              </button>
              <button
                type="button"
                onClick={() => runAction("mark_paid")}
                disabled={loadingAction !== null}
                className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-300 transition-colors hover:bg-emerald-500/15 disabled:opacity-50"
              >
                {loadingAction === "mark_paid" ? "Saving..." : "Mark Paid"}
              </button>
              <button
                type="button"
                onClick={() => runAction("reopen_cycle")}
                disabled={loadingAction !== null}
                className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-text-muted transition-colors hover:bg-surface-overlay disabled:opacity-50"
              >
                {loadingAction === "reopen_cycle" ? "Saving..." : "Reopen Cycle"}
              </button>
            </div>

            <div className="grid md:grid-cols-3 gap-4 text-sm">
              <div className="rounded-lg border border-border bg-surface px-4 py-3">
                <p className="text-xs uppercase tracking-wide text-text-faint">Invoice Sent</p>
                <p className="mt-2 text-text">{formatDate(currentRun.sentAt)}</p>
              </div>
              <div className="rounded-lg border border-border bg-surface px-4 py-3">
                <p className="text-xs uppercase tracking-wide text-text-faint">Reminder Due</p>
                <p className="mt-2 text-text">{formatDate(currentRun.reminderDueAt)}</p>
              </div>
              <div className="rounded-lg border border-border bg-surface px-4 py-3">
                <p className="text-xs uppercase tracking-wide text-text-faint">Reminder Sent</p>
                <p className="mt-2 text-text">{formatDate(currentRun.reminderSentAt || currentRun.paidAt)}</p>
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-lg border border-border bg-surface px-4 py-4 text-sm text-text-muted">
            No active cycle has been generated yet for this monthly client.
          </div>
        )}
      </div>

      {recentRuns.length > 0 ? (
        <div className="bg-surface-raised rounded-xl border border-border overflow-hidden">
          <div className="border-b border-border px-5 py-4">
            <h3 className="font-semibold text-text">Recent Billing Cycles</h3>
          </div>
          <div className="divide-y divide-border">
            {recentRuns.map((run) => (
              <div key={run.id} className="grid grid-cols-[1.1fr_1fr_1fr_1.1fr] gap-4 px-5 py-4 text-sm">
                <div>
                  <p className="font-medium text-text">{run.cycleKey}</p>
                  <p className="text-xs text-text-faint">Issued {formatDate(run.issueDate)}</p>
                </div>
                <div className="text-text-muted">Due {formatDate(run.dueDate)}</div>
                <div className="capitalize text-text-muted">{run.status.replace(/_/g, " ")}</div>
                <div className="text-text-muted">
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
