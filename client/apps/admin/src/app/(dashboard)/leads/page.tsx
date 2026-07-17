import { fetchFromCore } from "@/lib/admin-auth";
import Link from "next/link";
import LeadFilters from "@/components/admin/lead-filters";
import LeadsTable from "@/components/admin/leads-table";
import { AdminPageHeader } from "@/components/admin/page-header";
import { buttonClassName } from "@/components/ui/button";
import { Plus } from "lucide-react";

interface Lead {
  id: string;
  businessName: string;
  businessType: string;
  contactPerson: string;
  email: string;
  source: string;
  status: string;
  createdAt: string;
}

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; source?: string; search?: string }>;
}) {
  const params = await searchParams;

  const qs = new URLSearchParams();
  if (params.status) qs.set("status", params.status);
  if (params.source) qs.set("source", params.source);
  if (params.search) qs.set("search", params.search);

  const res = await fetchFromCore(`/api/admin/leads?${qs.toString()}`);
  const leads: Lead[] = res.ok ? await res.json() : [];

  const serializedLeads = leads.map((lead) => ({
    id: lead.id,
    businessName: lead.businessName,
    businessType: lead.businessType,
    contactPerson: lead.contactPerson,
    email: lead.email,
    source: lead.source,
    status: lead.status,
    createdAt: lead.createdAt,
  }));

  return (
    <div className="admin-page">
      <AdminPageHeader title="Leads" description={`${leads.length} lead${leads.length === 1 ? "" : "s"} matching the current filters.`} actions={<Link href="/leads/new" className={buttonClassName()}><Plus className="size-4" />Add lead</Link>} />

      <LeadFilters />

      <LeadsTable leads={serializedLeads} />
    </div>
  );
}
