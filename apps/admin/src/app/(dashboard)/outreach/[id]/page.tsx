import { prisma } from "@kasitek/database";
import { notFound } from "next/navigation";
import Link from "next/link";
import OutreachLeadsTable from "@/components/admin/outreach-leads-table";
import OutreachLeadFilters from "@/components/admin/outreach-lead-filters";
import Pagination from "@/components/admin/pagination";

export default async function CampaignDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ emailStatus?: string; search?: string; page?: string }>;
}) {
  const { id } = await params;
  const filters = await searchParams;
  const PAGE_SIZE = 50;
  const currentPage = Math.max(1, parseInt(filters.page || "1", 10));

  const campaign = await prisma.outreachCampaign.findUnique({
    where: { id },
  });

  if (!campaign) notFound();

  const where: Record<string, unknown> = { campaignId: id };
  if (filters.emailStatus) where.emailStatus = filters.emailStatus;
  if (filters.search) {
    where.OR = [
      { businessName: { contains: filters.search, mode: "insensitive" } },
      { website: { contains: filters.search, mode: "insensitive" } },
      { emailAddress: { contains: filters.search, mode: "insensitive" } },
    ];
  }

  const [leads, filteredCount] = await Promise.all([
    prisma.outreachLead.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "asc" }],
      skip: (currentPage - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.outreachLead.count({ where }),
  ]);

  const totalPages = Math.ceil(filteredCount / PAGE_SIZE);

  const serializedLeads = leads.map((l) => ({
    id: l.id,
    campaignId: l.campaignId,
    businessName: l.businessName,
    website: l.website,
    address: l.address,
    emailStatus: l.emailStatus,
    emailAddress: l.emailAddress,
    phone: l.phone,
    followUpCount: l.followUpCount,
    nextFollowUp: l.nextFollowUp?.toISOString() || null,
    notes: l.notes,
  }));

  const rate =
    campaign.emailsSent > 0
      ? Math.round((campaign.replies / campaign.emailsSent) * 100)
      : 0;

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/outreach"
          className="text-sm text-text-muted hover:text-text mb-1 inline-block"
        >
          &larr; Back to Outreach
        </Link>
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-text">{campaign.name}</h1>
            <p className="text-text-muted text-sm">
              {campaign.category} &middot; {campaign.totalLeads} leads &middot;{" "}
              {campaign.emailsSent} sent &middot; {campaign.replies} replies
              &middot; {rate}% response rate
            </p>
          </div>
          <span
            className={`text-xs font-medium px-2.5 py-1 rounded-full capitalize ${
              campaign.status === "active"
                ? "bg-green-500/15 text-green-400"
                : campaign.status === "paused"
                  ? "bg-yellow-500/15 text-yellow-400"
                  : campaign.status === "completed"
                    ? "bg-blue-500/15 text-blue-400"
                    : "bg-white/5 text-text-faint"
            }`}
          >
            {campaign.status}
          </span>
        </div>
      </div>

      <OutreachLeadFilters />

      <OutreachLeadsTable leads={serializedLeads} campaignId={id} />
      <Pagination
        currentPage={currentPage}
        totalPages={totalPages}
        totalItems={filteredCount}
        pageSize={PAGE_SIZE}
      />
    </div>
  );
}
