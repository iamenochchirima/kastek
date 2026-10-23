import { fetchFromCore } from "@/lib/admin-auth";
import Link from "next/link";
import WebServicesTable from "@/components/admin/web-services-table";
import WebServicesFilters from "@/components/admin/web-services-filters";
import AddWebServiceLead from "@/components/admin/add-web-service-lead";
import Pagination from "@/components/admin/pagination";
import { AdminMetric, AdminPageHeader } from "@/components/admin/page-header";
import { buttonClassName } from "@/components/ui/button";
import { Plus } from "lucide-react";

interface WebServiceLead {
  id: string;
  businessName: string;
  website: string | null;
  address: string | null;
  bizbayUrl: string | null;
  category: string;
  phone: string | null;
  email: string | null;
  callStatus: string;
  notes: string | null;
  callbackDate: string | null;
}

export default async function WebServicesPage({
  searchParams,
}: {
  searchParams: Promise<{ callStatus?: string; category?: string; search?: string; page?: string }>;
}) {
  const filters = await searchParams;
  const PAGE_SIZE = 50;
  const currentPage = Math.max(1, Number(filters.page) || 1);

  const qs = new URLSearchParams();
  if (filters.callStatus) qs.set("callStatus", filters.callStatus);
  if (filters.category) qs.set("category", filters.category);
  if (filters.search) qs.set("search", filters.search);

  qs.set("paginate", "true");
  qs.set("page", String(currentPage));
  qs.set("limit", String(PAGE_SIZE));
  const res = await fetchFromCore(`/api/admin/web-services?${qs.toString()}`);
  if (!res.ok) throw new Error("Web services unavailable");
  const data = await res.json() as { items: WebServiceLead[]; total: number };
  const allLeads = data.items;

  // Summaries describe only the current page.
  const statusMap: Record<string, number> = {};
  const categoryMap: Record<string, number> = {};
  for (const l of allLeads) {
    statusMap[l.callStatus] = (statusMap[l.callStatus] ?? 0) + 1;
    categoryMap[l.category] = (categoryMap[l.category] ?? 0) + 1;
  }

  const total = data.total;
  const filteredCount = total;

  // The API applies filtering and pagination.
  const leads = allLeads;
  const totalPages = Math.ceil(filteredCount / PAGE_SIZE);

  const serialized = leads.map((l) => ({
    id: l.id,
    businessName: l.businessName,
    website: l.website,
    address: l.address,
    bizbayUrl: l.bizbayUrl,
    category: l.category,
    phone: l.phone,
    email: l.email,
    callStatus: l.callStatus,
    notes: l.notes,
    callbackDate: l.callbackDate ?? null,
  }));

  const categories = Object.entries(categoryMap)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  const called =
    (statusMap.called ?? 0) +
    (statusMap.interested ?? 0) +
    (statusMap.not_interested ?? 0) +
    (statusMap.callback ?? 0);
  const interested = statusMap.interested ?? 0;
  const conversionRate = called > 0 ? Math.round((interested / called) * 100) : 0;

  return (
    <div className="admin-page">
      <AdminPageHeader title="Web services" description={`${total} business lead${total === 1 ? "" : "s"} in the service-call pipeline.`} actions={<>

          <AddWebServiceLead />
          <Link
            href="/web-services/import"
            className={buttonClassName()}
          >
            <Plus className="size-4" />Import
          </Link>
      </>} />

      {/* Stats */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6"><AdminMetric label="Filtered leads" value={total} detail={`${allLeads.length} on this page`} /><AdminMetric label="Called on page" value={called} tone="info" /><AdminMetric label="Interested on page" value={interested} detail={`${conversionRate}% conversion`} tone="success" /><AdminMetric label="Callbacks on page" value={statusMap.callback ?? 0} tone="attention" /><AdminMetric label="No answer on page" value={statusMap.no_answer ?? 0} tone="danger" /><AdminMetric label="Dead on page" value={statusMap.dead ?? 0} /></div>

      {/* Category breakdown */}
      {categories.length > 0 && (
        <div className="v-card p-[var(--density-card-padding)]">
          <h2 className="text-base font-semibold tracking-[-0.01em] text-foreground">Categories on this page</h2>
          <div className="flex flex-wrap gap-2">
            {categories.map((c) => (
              <Link
                key={c.name}
                href={`/web-services?category=${encodeURIComponent(c.name)}`}
                className={`text-xs font-medium px-3 py-1.5 rounded-full transition-colors ${
                  filters.category === c.name
                    ? "bg-primary text-primary-foreground"
                    : "bg-secondary text-muted-foreground hover:bg-accent hover:text-foreground"
                }`}
              >
                {c.name.replace(/-/g, " ")} ({c.count})
              </Link>
            ))}
            {filters.category && (
              <Link
                href="/web-services"
                className="rounded-full bg-secondary px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                Clear
              </Link>
            )}
          </div>
        </div>
      )}

      <WebServicesFilters />
      <WebServicesTable leads={serialized} />
      <Pagination
        currentPage={currentPage}
        totalPages={totalPages}
        totalItems={filteredCount}
        pageSize={PAGE_SIZE}
      />
    </div>
  );
}
