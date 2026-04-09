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

  const deliveryLogs = await prisma.outreachEmailDeliveryLog.findMany({
    where: { campaignId: id },
    orderBy: { attemptedAt: "desc" },
    take: 100,
    select: {
      id: true,
      recipient: true,
      subject: true,
      status: true,
      provider: true,
      providerMessageId: true,
      providerResponse: true,
      errorMessage: true,
      attemptedAt: true,
      lead: {
        select: {
          businessName: true,
          website: true,
        },
      },
    },
  });

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
    emailTemplate: l.emailTemplate,
    emailSentAt: l.emailSentAt?.toISOString() || null,
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

      <section className="rounded-xl border border-border bg-surface-raised p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-text">Delivery Log (last 100)</h2>
          <p className="text-xs text-text-faint">
            {deliveryLogs.length} record{deliveryLogs.length === 1 ? "" : "s"}
          </p>
        </div>
        {deliveryLogs.length === 0 ? (
          <p className="text-sm text-text-faint">No delivery attempts logged yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px]">
              <thead>
                <tr className="border-b border-border text-left">
                  <th className="px-2 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-faint">When</th>
                  <th className="px-2 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-faint">Status</th>
                  <th className="px-2 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-faint">Recipient</th>
                  <th className="px-2 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-faint">Business</th>
                  <th className="px-2 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-faint">Subject</th>
                  <th className="px-2 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-faint">Provider</th>
                  <th className="px-2 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-faint">Message ID</th>
                  <th className="px-2 py-2 text-[11px] font-semibold uppercase tracking-wide text-text-faint">Error</th>
                </tr>
              </thead>
              <tbody>
                {deliveryLogs.map((log) => (
                  <tr key={log.id} className="border-b border-border/70">
                    <td className="px-2 py-2 text-xs text-text-muted whitespace-nowrap">
                      {new Date(log.attemptedAt).toLocaleString()}
                    </td>
                    <td className="px-2 py-2 text-xs">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 font-medium ${
                          log.status === "sent"
                            ? "bg-green-500/15 text-green-400"
                            : "bg-red-500/15 text-red-400"
                        }`}
                      >
                        {log.status}
                      </span>
                    </td>
                    <td className="px-2 py-2 text-xs text-text break-all">{log.recipient}</td>
                    <td className="px-2 py-2 text-xs text-text-muted">
                      <p className="text-text">{log.lead?.businessName || "--"}</p>
                      {log.lead?.website ? (
                        <a
                          href={log.lead.website}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline break-all"
                        >
                          {log.lead.website}
                        </a>
                      ) : null}
                    </td>
                    <td className="px-2 py-2 text-xs text-text max-w-[360px] truncate" title={log.subject}>
                      {log.subject}
                    </td>
                    <td className="px-2 py-2 text-xs text-text-muted">{log.provider}</td>
                    <td className="px-2 py-2 text-xs text-text-muted break-all">
                      {log.providerMessageId || "--"}
                    </td>
                    <td className="px-2 py-2 text-xs text-red-300 max-w-[320px] truncate" title={log.errorMessage || ""}>
                      {log.errorMessage || "--"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
