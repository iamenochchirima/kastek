import { prisma } from "@kasitek/database";
import Link from "next/link";
import WebServicesTable from "@/components/admin/web-services-table";
import WebServicesFilters from "@/components/admin/web-services-filters";
import DeleteAllButton from "@/components/admin/web-services-delete-all";
import AddWebServiceLead from "@/components/admin/add-web-service-lead";
import Pagination from "@/components/admin/pagination";

export default async function WebServicesPage({
  searchParams,
}: {
  searchParams: Promise<{ callStatus?: string; category?: string; search?: string; page?: string }>;
}) {
  const filters = await searchParams;
  const PAGE_SIZE = 50;
  const currentPage = Math.max(1, parseInt(filters.page || "1", 10));

  const where: Record<string, unknown> = {};
  if (filters.callStatus) where.callStatus = filters.callStatus;
  if (filters.category) where.category = filters.category;
  if (filters.search) {
    where.OR = [
      { businessName: { contains: filters.search, mode: "insensitive" } },
      { address: { contains: filters.search, mode: "insensitive" } },
    ];
  }

  const [leads, filteredCount, statusBreakdown, categoryBreakdown] = await Promise.all([
    prisma.webServiceLead.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: (currentPage - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.webServiceLead.count({ where }),
    prisma.webServiceLead.groupBy({
      by: ["callStatus"],
      _count: true,
    }),
    prisma.webServiceLead.groupBy({
      by: ["category"],
      _count: true,
    }),
  ]);

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
    callbackDate: l.callbackDate?.toISOString() || null,
  }));

  const total = statusBreakdown.reduce((s, r) => s + r._count, 0);
  const statusMap = Object.fromEntries(statusBreakdown.map((s) => [s.callStatus, s._count]));
  const categories = categoryBreakdown
    .map((c) => ({ name: c.category, count: c._count }))
    .sort((a, b) => b.count - a.count);

  const called = (statusMap.called || 0) + (statusMap.interested || 0) + (statusMap.not_interested || 0) + (statusMap.callback || 0);
  const interested = statusMap.interested || 0;
  const conversionRate = called > 0 ? Math.round((interested / called) * 100) : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-text">Web Services ({total})</h1>
        <div className="flex items-center gap-3">
          {total > 0 && <DeleteAllButton count={total} />}
          <AddWebServiceLead />
          <Link
            href="/web-services/import"
            className="bg-primary hover:bg-primary-dark text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          >
            + Import
          </Link>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
        <div className="bg-surface-raised rounded-xl border border-border p-5">
          <p className="text-sm text-text-muted">Total</p>
          <p className="text-3xl font-bold text-text mt-1">{total}</p>
          <p className="text-xs text-text-faint mt-1">{statusMap.pending || 0} pending</p>
        </div>
        <div className="bg-blue-500/10 rounded-xl border border-blue-500/20 p-5">
          <p className="text-sm text-blue-400">Called</p>
          <p className="text-3xl font-bold text-blue-400 mt-1">{called}</p>
        </div>
        <div className="bg-green-500/10 rounded-xl border border-green-500/20 p-5">
          <p className="text-sm text-green-400">Interested</p>
          <p className="text-3xl font-bold text-green-400 mt-1">{interested}</p>
          <p className="text-xs text-green-400/60 mt-1">{conversionRate}% conversion</p>
        </div>
        <div className="bg-yellow-500/10 rounded-xl border border-yellow-500/20 p-5">
          <p className="text-sm text-yellow-400">Callback</p>
          <p className="text-3xl font-bold text-yellow-400 mt-1">{statusMap.callback || 0}</p>
        </div>
        <div className="bg-red-500/10 rounded-xl border border-red-500/20 p-5">
          <p className="text-sm text-red-400">No Answer</p>
          <p className="text-3xl font-bold text-red-400 mt-1">{statusMap.no_answer || 0}</p>
        </div>
        <div className="bg-zinc-500/10 rounded-xl border border-zinc-500/20 p-5">
          <p className="text-sm text-zinc-400">Dead</p>
          <p className="text-3xl font-bold text-zinc-400 mt-1">{statusMap.dead || 0}</p>
        </div>
      </div>

      {/* Category breakdown */}
      {categories.length > 0 && (
        <div className="bg-surface-raised rounded-xl border border-border p-6">
          <h2 className="font-semibold text-text mb-3">By Category</h2>
          <div className="flex flex-wrap gap-2">
            {categories.map((c) => (
              <Link
                key={c.name}
                href={`/web-services?category=${encodeURIComponent(c.name)}`}
                className={`text-xs font-medium px-3 py-1.5 rounded-full transition-colors ${
                  filters.category === c.name
                    ? "bg-primary text-white"
                    : "bg-surface-overlay text-text-muted hover:text-text"
                }`}
              >
                {c.name.replace(/-/g, " ")} ({c.count})
              </Link>
            ))}
            {filters.category && (
              <Link
                href="/web-services"
                className="text-xs font-medium px-3 py-1.5 rounded-full bg-white/5 text-text-faint hover:text-text"
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
