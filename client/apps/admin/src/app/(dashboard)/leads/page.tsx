import { prisma } from "@kasitek/database";
import Link from "next/link";
import LeadFilters from "@/components/admin/lead-filters";
import LeadsTable from "@/components/admin/leads-table";

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; source?: string; search?: string }>;
}) {
  const params = await searchParams;

  const where: Record<string, unknown> = {};
  if (params.status) where.status = params.status;
  if (params.source) where.source = params.source;
  if (params.search) {
    where.OR = [
      { businessName: { contains: params.search, mode: "insensitive" } },
      { contactPerson: { contains: params.search, mode: "insensitive" } },
      { email: { contains: params.search, mode: "insensitive" } },
      { phone: { contains: params.search } },
    ];
  }

  const leads = await prisma.quoteRequest.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });

  // Serialize dates for client component
  const serializedLeads = leads.map((lead) => ({
    id: lead.id,
    businessName: lead.businessName,
    businessType: lead.businessType,
    contactPerson: lead.contactPerson,
    email: lead.email,
    source: lead.source,
    status: lead.status,
    createdAt: lead.createdAt.toISOString(),
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-text">Leads ({leads.length})</h1>
        <Link
          href="/leads/new"
          className="bg-primary hover:bg-primary-dark text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
        >
          + Add Lead
        </Link>
      </div>

      <LeadFilters />

      <LeadsTable leads={serializedLeads} />
    </div>
  );
}
