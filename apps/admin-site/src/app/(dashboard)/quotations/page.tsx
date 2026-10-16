import { fetchFromCore } from "@/lib/admin-auth";
import Link from "next/link";
import { getServiceLabel } from "@/lib/quotation";
import { AdminPageHeader } from "@/components/admin/page-header";
import { StatusBadge } from "@/components/admin/status-badge";
import { buttonClassName } from "@/components/ui/button";
import { Plus } from "lucide-react";

export default async function QuotationsPage() {
  const res = await fetchFromCore("/api/admin/quotations");
  const quotations: Array<{
    id: string;
    businessName: string;
    contactPerson: string;
    contactEmail: string;
    serviceType: string;
    title: string;
    status: string;
    pricingItems: Array<{ amount?: string }>;
    createdAt: string;
  }> = res.ok ? await res.json() : [];

  return (
    <div className="admin-page">
      <AdminPageHeader title="Quotations" description="Create, update, download, and track standalone quotation records." actions={<Link href="/quotations/new" className={buttonClassName()}><Plus className="size-4" />New quotation</Link>} />

      <div className="v-card overflow-hidden">
        <div className="grid min-w-[780px] grid-cols-[1.8fr_1.2fr_1.6fr_0.9fr_1fr] gap-4 border-b border-border px-5 py-3 admin-table-head">
          <div>Business</div>
          <div>Contact</div>
          <div>Quotation</div>
          <div>Status</div>
          <div className="text-right">Action</div>
        </div>

        {quotations.length === 0 ? (
            <div className="px-6 py-10 text-center text-sm text-muted-foreground">
            No quotations created yet.
          </div>
        ) : (
          <div className="min-w-[780px] divide-y divide-border">
            {quotations.map((quotation) => (
              <div
                key={quotation.id}
                className="grid grid-cols-[1.8fr_1.2fr_1.6fr_0.9fr_1fr] items-center gap-4 px-5 py-4 transition-colors hover:bg-accent"
              >
                <div>
                  <p className="text-sm font-medium text-foreground">{quotation.businessName}</p>
                  <p className="text-xs text-muted-foreground">
                    Created {new Date(quotation.createdAt).toLocaleDateString()}
                  </p>
                </div>

                <div>
                  <p className="text-sm text-foreground">{quotation.contactPerson}</p>
                  <p className="text-xs text-muted-foreground">{quotation.contactEmail}</p>
                </div>

                <div>
                  <p className="text-sm text-foreground">{quotation.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {getServiceLabel(quotation.serviceType)}
                    {Array.isArray(quotation.pricingItems) && quotation.pricingItems.length > 0
                      ? ` · ${String(quotation.pricingItems[0]?.amount || "")}`
                      : ""}
                  </p>
                </div>

                <div>
                  <StatusBadge value={quotation.status} />
                </div>

                <div className="text-right">
                  <Link
                    href={`/quotations/${quotation.id}`}
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
