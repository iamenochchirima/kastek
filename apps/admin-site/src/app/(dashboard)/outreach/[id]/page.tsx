import { fetchFromCore } from "@/lib/admin-auth";
import { notFound } from "next/navigation";
import Link from "next/link";
import OutreachLeadsTable from "@/components/admin/outreach-leads-table";
import OutreachLeadFilters from "@/components/admin/outreach-lead-filters";
import Pagination from "@/components/admin/pagination";
import { StatusBadge } from "@/components/admin/status-badge";
import { AdminPageHeader } from "@/components/admin/page-header";
import { buttonClassName } from "@/components/ui/button";

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
  const currentPage = Math.max(1, Number(filters.page) || 1);

  // Fetch campaign + leads + delivery logs in parallel
  const leadsUrl = new URL(`http://x/api/admin/outreach/${id}/leads`);
  if (filters.emailStatus) leadsUrl.searchParams.set("emailStatus", filters.emailStatus);
  if (filters.search) leadsUrl.searchParams.set("search", filters.search);

  leadsUrl.searchParams.set("paginate", "true");
  leadsUrl.searchParams.set("page", String(currentPage));
  leadsUrl.searchParams.set("limit", String(PAGE_SIZE));
  const [campaignRes, leadsRes, logsRes] = await Promise.all([
    fetchFromCore(`/api/admin/outreach/${id}`),
    fetchFromCore(`/api/admin/outreach/${id}/leads?${leadsUrl.searchParams.toString()}`),
    fetchFromCore(`/api/admin/outreach/delivery?campaignId=${id}&limit=100`),
  ]);

  if (campaignRes.status === 404) notFound();
  if (!campaignRes.ok || !leadsRes.ok || !logsRes.ok) throw new Error("Campaign unavailable");

  const campaign = await campaignRes.json() as {
    id: string;
    name: string;
    category: string;
    status: string;
    totalLeads: number;
    emailsSent: number;
    replies: number;
  };

  const data = await leadsRes.json() as { items: Lead[]; total: number };
  const allLeads = data.items;
  const deliveryLogs: DeliveryLog[] = logsRes.ok ? (await logsRes.json() as DeliveryLog[]) : [];

  // The API applies filtering and pagination.
  const filteredCount = data.total;
  const totalPages = Math.ceil(filteredCount / PAGE_SIZE);
  const leads = allLeads;

  const rate =
    campaign.emailsSent > 0
      ? Math.round((campaign.replies / campaign.emailsSent) * 100)
      : 0;

  return (
    <div className="admin-page">
      <AdminPageHeader eyebrow={`Outreach / ${campaign.category}`} title={campaign.name} description={`${campaign.totalLeads} leads · ${campaign.emailsSent} sent · ${campaign.replies} replies · ${rate}% response rate`} actions={<><StatusBadge value={campaign.status} /><Link href="/outreach" className={buttonClassName({ variant: "outline", size: "sm" })}>Back to outreach</Link></>} />

      <OutreachLeadFilters />

      <OutreachLeadsTable leads={leads} campaignId={id} />
      <Pagination
        currentPage={currentPage}
        totalPages={totalPages}
        totalItems={filteredCount}
        pageSize={PAGE_SIZE}
      />

      <section className="v-card space-y-3 p-[var(--density-card-padding)]">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold tracking-[-0.01em] text-foreground">Delivery log (last 100)</h2>
          <p className="text-xs text-muted-foreground">
            {deliveryLogs.length} record{deliveryLogs.length === 1 ? "" : "s"}
          </p>
        </div>
        {deliveryLogs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No delivery attempts logged yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[980px]">
              <thead>
                <tr className="admin-table-head border-b border-line text-left">
                  <th className="px-2 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">When</th>
                  <th className="px-2 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Status</th>
                  <th className="px-2 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Recipient</th>
                  <th className="px-2 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Business</th>
                  <th className="px-2 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Subject</th>
                  <th className="px-2 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Provider</th>
                  <th className="px-2 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Message ID</th>
                  <th className="px-2 py-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Error</th>
                </tr>
              </thead>
              <tbody>
                {deliveryLogs.map((log) => (
                  <tr key={log.id} className="border-b border-border/70">
                    <td className="px-2 py-2 text-xs text-muted-foreground whitespace-nowrap">
                      {new Date(log.attemptedAt).toLocaleString()}
                    </td>
                    <td className="px-2 py-2 text-xs">
                      <StatusBadge value={log.status} />
                    </td>
                    <td className="px-2 py-2 text-xs text-foreground break-all">{log.recipient}</td>
                    <td className="px-2 py-2 text-xs text-muted-foreground">
                      <p className="text-foreground">{log.lead_business_name || "--"}</p>
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
                    <td className="px-2 py-2 text-xs text-foreground max-w-[360px] truncate" title={log.subject}>
                      {log.subject}
                    </td>
                    <td className="px-2 py-2 text-xs text-muted-foreground">{log.provider}</td>
                    <td className="px-2 py-2 text-xs text-muted-foreground break-all">
                      {log.providerMessageId || "--"}
                    </td>
                    <td className="px-2 py-2 text-xs text-status-danger max-w-[320px] truncate" title={log.errorMessage || ""}>
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
