import { prisma } from "@kasitek/database";
import Link from "next/link";
import { getServiceLabel } from "@/lib/invoice";

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-slate-500/15 text-slate-300",
  sent: "bg-blue-500/15 text-blue-300",
  paid: "bg-green-500/15 text-green-300",
  overdue: "bg-yellow-500/15 text-yellow-300",
  cancelled: "bg-red-500/15 text-red-300",
};

export default async function InvoicesPage() {
  const invoices = await prisma.invoice.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      businessName: true,
      contactPerson: true,
      contactEmail: true,
      serviceType: true,
      title: true,
      status: true,
      pricingItems: true,
      createdAt: true,
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
        <h1 className="text-2xl font-bold text-text">Invoices</h1>
        <p className="text-sm text-text-muted mt-1">
          Create, update, download, and track standalone invoice records.
        </p>
        </div>
        <Link
          href="/invoices/new"
          className="bg-primary hover:bg-primary-dark text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
        >
          + New Invoice
        </Link>
      </div>

      <div className="bg-surface-raised rounded-xl border border-border overflow-hidden">
        <div className="grid grid-cols-[1.8fr_1.2fr_1.6fr_0.9fr_1fr] gap-4 px-6 py-3 border-b border-border text-xs font-semibold uppercase tracking-wider text-text-faint">
          <div>Business</div>
          <div>Contact</div>
          <div>Invoice</div>
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
                className="grid grid-cols-[1.8fr_1.2fr_1.6fr_0.9fr_1fr] gap-4 px-6 py-4 items-center"
              >
                <div>
                  <p className="font-medium text-sm text-text">{invoice.businessName}</p>
                  <p className="text-xs text-text-faint">
                    Created {invoice.createdAt.toLocaleDateString()}
                  </p>
                </div>

                <div>
                  <p className="text-sm text-text">{invoice.contactPerson}</p>
                  <p className="text-xs text-text-faint">{invoice.contactEmail}</p>
                </div>

                <div>
                  <p className="text-sm text-text">{invoice.title}</p>
                  <p className="text-xs text-text-faint">
                    {getServiceLabel(invoice.serviceType)}
                    {Array.isArray(invoice.pricingItems) && invoice.pricingItems.length > 0
                      ? ` · ${String((invoice.pricingItems[0] as { amount?: string }).amount || "")}`
                      : ""}
                  </p>
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
