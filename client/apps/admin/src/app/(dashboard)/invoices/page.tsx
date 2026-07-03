import { fetchFromCore } from "@/lib/admin-auth";
import Link from "next/link";
import { getServiceLabel } from "@/lib/invoice";

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-slate-500/15 text-slate-300",
  sent: "bg-blue-500/15 text-blue-300",
  paid: "bg-green-500/15 text-green-300",
  overdue: "bg-yellow-500/15 text-yellow-300",
  cancelled: "bg-red-500/15 text-red-300",
};

function formatDate(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString();
}

export default async function InvoicesPage() {
  const res = await fetchFromCore("/api/admin/invoices");
  const data: {
    summary?: {
      totalInvoices: number;
      recurringClients: number;
      needsInvoiceSend: number;
      needsReminder: number;
    };
    actionItems?: Array<{
      invoiceId: string;
      invoiceRunId: string;
      businessName: string;
      actionType: string;
      title: string;
      message: string;
      dueAt: string;
    }>;
    invoices?: Array<{
      id: string;
      businessName: string;
      contactPerson: string;
      contactEmail: string;
      serviceType: string;
      billingMode: string;
      recurringActive: boolean;
      title: string;
      status: string;
      pricingItems: Array<{ amount?: string }>;
      createdAt: string;
      currentRun?: {
        cycleKey: string;
        dueDate: string;
      } | null;
      operations?: {
        needs_invoice_send?: boolean;
        needs_reminder?: boolean;
      };
    }>;
  } = res.ok ? await res.json() : {};

  const summary = data.summary ?? {
    totalInvoices: 0,
    recurringClients: 0,
    needsInvoiceSend: 0,
    needsReminder: 0,
  };
  const actionItems = data.actionItems ?? [];
  const invoices = data.invoices ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-text">Invoices</h1>
          <p className="text-sm text-text-muted mt-1">
            Track one-off invoices and recurring monthly clients from a single billing operations view.
          </p>
        </div>
        <Link
          href="/invoices/new"
          className="bg-primary hover:bg-primary-dark text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
        >
          + New Invoice
        </Link>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <div className="rounded-xl border border-border bg-surface-raised p-5">
          <p className="text-xs uppercase tracking-wide text-text-faint">Total Records</p>
          <p className="mt-3 text-2xl font-semibold text-text">{summary.totalInvoices}</p>
        </div>
        <div className="rounded-xl border border-border bg-surface-raised p-5">
          <p className="text-xs uppercase tracking-wide text-text-faint">Monthly Clients</p>
          <p className="mt-3 text-2xl font-semibold text-text">{summary.recurringClients}</p>
        </div>
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-5">
          <p className="text-xs uppercase tracking-wide text-amber-300">Need Invoice Send</p>
          <p className="mt-3 text-2xl font-semibold text-amber-200">{summary.needsInvoiceSend}</p>
        </div>
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 p-5">
          <p className="text-xs uppercase tracking-wide text-red-300">Need Reminder</p>
          <p className="mt-3 text-2xl font-semibold text-red-200">{summary.needsReminder}</p>
        </div>
      </div>

      <div className="bg-surface-raised rounded-xl border border-border overflow-hidden">
        <div className="border-b border-border px-6 py-4">
          <h2 className="font-semibold text-text">Action Queue</h2>
          <p className="text-sm text-text-muted mt-1">
            These are the monthly client tasks that need operational attention right now.
          </p>
        </div>

        {actionItems.length === 0 ? (
          <div className="px-6 py-8 text-sm text-text-faint">No billing actions are currently outstanding.</div>
        ) : (
          <div className="divide-y divide-border">
            {actionItems.slice(0, 8).map((item) => (
              <Link
                key={`${item.invoiceRunId}-${item.actionType}`}
                href={`/invoices/${item.invoiceId}`}
                className="block px-6 py-4 transition-colors hover:bg-surface-overlay"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="font-medium text-text">{item.title}</p>
                    <p className="text-sm text-text-muted mt-1">{item.message}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-sm text-text">{item.businessName}</p>
                    <p className="text-xs text-text-faint">Due {formatDate(item.dueAt) ?? "now"}</p>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>

      <div className="bg-surface-raised rounded-xl border border-border overflow-hidden">
        <div className="grid grid-cols-[1.5fr_1.1fr_1.5fr_1fr_1fr] gap-4 px-6 py-3 border-b border-border text-xs font-semibold uppercase tracking-wider text-text-faint">
          <div>Business</div>
          <div>Billing</div>
          <div>Current Cycle</div>
          <div>Status</div>
          <div className="text-right">Action</div>
        </div>

        {invoices.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-text-faint">
            No invoices created yet.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {invoices.map((invoice) => (
              <div
                key={invoice.id}
                className="grid grid-cols-[1.5fr_1.1fr_1.5fr_1fr_1fr] gap-4 px-6 py-4 items-center"
              >
                <div>
                  <p className="font-medium text-sm text-text">{invoice.businessName}</p>
                  <p className="text-xs text-text-faint">{invoice.contactEmail}</p>
                </div>

                <div>
                  <p className="text-sm text-text">
                    {invoice.billingMode === "monthly" && invoice.recurringActive ? "Monthly client" : "One-off"}
                  </p>
                  <p className="text-xs text-text-faint">{getServiceLabel(invoice.serviceType)}</p>
                </div>

                <div>
                  <p className="text-sm text-text">{invoice.title}</p>
                  <p className="text-xs text-text-faint">
                    {invoice.currentRun?.cycleKey
                      ? `${invoice.currentRun.cycleKey} · Due ${formatDate(invoice.currentRun.dueDate) ?? "n/a"}`
                      : `Created ${formatDate(invoice.createdAt) ?? "n/a"}`}
                  </p>
                  {invoice.operations?.needs_invoice_send ? (
                    <p className="text-xs text-amber-300 mt-1">Invoice still needs to be sent</p>
                  ) : null}
                  {invoice.operations?.needs_reminder ? (
                    <p className="text-xs text-red-300 mt-1">Reminder email still needs to be sent</p>
                  ) : null}
                </div>

                <div>
                  <span
                    className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium capitalize ${
                      STATUS_COLORS[invoice.status] || "bg-surface-overlay text-text-muted"
                    }`}
                  >
                    {invoice.status}
                  </span>
                </div>

                <div className="text-right">
                  <Link
                    href={`/invoices/${invoice.id}`}
                    className="inline-flex items-center rounded-lg border border-border px-3 py-2 text-sm font-medium text-text hover:bg-surface-overlay transition-colors"
                  >
                    Open
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
