import { fetchFromCore } from "@/lib/admin-auth";
import { notFound } from "next/navigation";
import Link from "next/link";
import OutreachLeadsTable from "@/components/admin/outreach-leads-table";
import OutreachLeadFilters from "@/components/admin/outreach-lead-filters";
import Pagination from "@/components/admin/pagination";

const PAGE_SIZE = 50;

type Lead = {
  id: string;
  campaignId: string;
  businessName: string;
  website: string | null;
  address: string | null;
  emailStatus: string;
  emailAddress: string | null;
  phone: string | null;
  emailTemplate: string | null;
  emailSentAt: string | null;
  followUpCount: number;
  nextFollowUp: string | null;
  notes: string | null;
};

type DeliveryLog = {
  id: string;
  recipient: string;
  subject: string;
  status: string;
  provider: string;
  providerMessageId: string | null;
  errorMessage: string | null;
  attemptedAt: string;
  campaign_name: string | null;
  lead_business_name: string | null;
  lead_website: string | null;
};

export default async function CampaignDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ emailStatus?: string; search?: string; page?: string }>;
}) {
  const { id } = await params;
  const filters = await searchParams;
  const currentPage = Math.max(1, parseInt(filters.page || "1", 10));

  // Fetch campaign + leads + delivery logs in parallel
  const leadsUrl = new URL(`http://x/api/admin/outreach/${id}/leads`);
  if (filters.emailStatus) leadsUrl.searchParams.set("emailStatus", filters.emailStatus);
  if (filters.search) leadsUrl.searchParams.set("search", filters.search);

  const [campaignRes, leadsRes, logsRes] = await Promise.all([
    fetchFromCore(`/api/admin/outreach/${id}`),
    fetchFromCore(`/api/admin/outreach/${id}/leads?${leadsUrl.searchParams.toString()}`),
    fetchFromCore(`/api/admin/outreach/delivery?campaignId=${id}&limit=100`),
  ]);

  if (!campaignRes.ok) notFound();

  const campaign = await campaignRes.json() as {
    id: string;
    name: string;
    category: string;
    status: string;
    totalLeads: number;
    emailsSent: number;
    replies: number;
  };

  const allLeads: Lead[] = leadsRes.ok ? await leadsRes.json() : [];
  const deliveryLogs: DeliveryLog[] = logsRes.ok ? (await logsRes.json() as DeliveryLog[]) : [];

  // Client-side pagination for leads
  const filteredCount = allLeads.length;
  const totalPages = Math.ceil(filteredCount / PAGE_SIZE);
  const leads = allLeads.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

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

      <OutreachLeadsTable leads={leads} campaignId={id} />
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
                      <p className="text-text">{log.lead_business_name || "--"}</p>
                      {log.lead_website ? (
                        <a
                          href={log.lead_website}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline break-all"
                        >
                          {log.lead_website}
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
