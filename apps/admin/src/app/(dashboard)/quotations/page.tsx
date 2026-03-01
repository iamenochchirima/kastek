import { prisma } from "@kasiai/database";
import Link from "next/link";
import { getServiceLabel } from "@/lib/quotation";

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-slate-500/15 text-slate-300",
  sent: "bg-blue-500/15 text-blue-300",
  accepted: "bg-green-500/15 text-green-300",
  rejected: "bg-red-500/15 text-red-300",
  expired: "bg-yellow-500/15 text-yellow-300",
};

export default async function QuotationsPage() {
  const quotations = await prisma.quotation.findMany({
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
        <h1 className="text-2xl font-bold text-text">Quotations</h1>
        <p className="text-sm text-text-muted mt-1">
          Create, update, download, and track standalone quotation records.
        </p>
        </div>
        <Link
          href="/quotations/new"
          className="bg-primary hover:bg-primary-dark text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
        >
          + New Quotation
        </Link>
      </div>

      <div className="bg-surface-raised rounded-xl border border-border overflow-hidden">
        <div className="grid grid-cols-[1.8fr_1.2fr_1.6fr_0.9fr_1fr] gap-4 px-6 py-3 border-b border-border text-xs font-semibold uppercase tracking-wider text-text-faint">
          <div>Business</div>
          <div>Contact</div>
          <div>Quotation</div>
          <div>Status</div>
          <div className="text-right">Action</div>
        </div>

        {quotations.length === 0 ? (
          <div className="px-6 py-10 text-center text-sm text-text-faint">
            No quotations created yet.
          </div>
        ) : (
          <div className="divide-y divide-border">
            {quotations.map((quotation) => (
              <div
                key={quotation.id}
                className="grid grid-cols-[1.8fr_1.2fr_1.6fr_0.9fr_1fr] gap-4 px-6 py-4 items-center"
              >
                <div>
                  <p className="font-medium text-sm text-text">{quotation.businessName}</p>
                  <p className="text-xs text-text-faint">
                    Created {quotation.createdAt.toLocaleDateString()}
                  </p>
                </div>

                <div>
                  <p className="text-sm text-text">{quotation.contactPerson}</p>
                  <p className="text-xs text-text-faint">{quotation.contactEmail}</p>
                </div>

                <div>
                  <p className="text-sm text-text">{quotation.title}</p>
                  <p className="text-xs text-text-faint">
                    {getServiceLabel(quotation.serviceType)}
                    {Array.isArray(quotation.pricingItems) && quotation.pricingItems.length > 0
                      ? ` · ${String((quotation.pricingItems[0] as { amount?: string }).amount || "")}`
                      : ""}
                  </p>
                </div>

                <div>
                  <span
                    className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium capitalize ${
                      STATUS_COLORS[quotation.status] || "bg-surface-overlay text-text-muted"
                    }`}
                  >
                    {quotation.status}
                  </span>
                </div>

                <div className="text-right">
                  <Link
                    href={`/quotations/${quotation.id}`}
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
