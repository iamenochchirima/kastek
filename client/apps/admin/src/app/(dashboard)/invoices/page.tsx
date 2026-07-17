import { fetchFromCore } from "@/lib/admin-auth";
import Link from "next/link";
import { getServiceLabel } from "@/lib/invoice";
import { AdminMetric, AdminPageHeader } from "@/components/admin/page-header";
import { StatusBadge } from "@/components/admin/status-badge";
import { buttonClassName } from "@/components/ui/button";
import { Plus } from "lucide-react";

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
    <div className="admin-page">
      <AdminPageHeader title="Invoices" description="Track one-off invoices and recurring monthly clients from a single billing operations view." actions={<Link href="/invoices/new" className={buttonClassName()}><Plus className="size-4" />New invoice</Link>} />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><AdminMetric label="Total records" value={summary.totalInvoices} /><AdminMetric label="Monthly clients" value={summary.recurringClients} /><AdminMetric label="Need invoice send" value={summary.needsInvoiceSend} tone="attention" /><AdminMetric label="Need reminder" value={summary.needsReminder} tone="danger" /></div>

      <div className="rounded-lg border border-border bg-card overflow-hidden">
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

      <div className="admin-table-wrap">
        <div className="grid min-w-[780px] grid-cols-[1.5fr_1.1fr_1.5fr_1fr_1fr] gap-4 border-b border-border px-5 py-3 admin-table-head">
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
          <div className="min-w-[780px] divide-y divide-border">
            {invoices.map((invoice) => (
              <div
                key={invoice.id}
                className="grid grid-cols-[1.5fr_1.1fr_1.5fr_1fr_1fr] items-center gap-4 px-5 py-4 hover:bg-secondary"
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
                  <StatusBadge value={invoice.status} />
                </div>

                <div className="text-right">
                  <Link
                    href={`/invoices/${invoice.id}`}
                    className={buttonClassName({ variant: "secondary", size: "sm" })}
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
