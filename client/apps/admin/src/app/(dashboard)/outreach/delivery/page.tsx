import Link from "next/link";
import { fetchFromCore } from "@/lib/admin-auth";
import Pagination from "@/components/admin/pagination";
import { AdminMetric, AdminPageHeader } from "@/components/admin/page-header";
import { StatusBadge } from "@/components/admin/status-badge";
import { buttonClassName } from "@/components/ui/button";

const PAGE_SIZE = 100;

type DeliveryLog = {
  id: string;
  campaignId: string | null;
  leadId: string | null;
  recipient: string;
  subject: string;
  status: string;
  provider: string;
  providerMessageId: string | null;
  errorMessage: string | null;
  attemptedAt: string;
  campaign_name: string | null;
  campaign_category: string | null;
  lead_business_name: string | null;
  lead_website: string | null;
};

type Campaign = { id: string; name: string };

export default async function OutreachDeliveryPage({
  searchParams,
}: {
  searchParams: Promise<{
    campaignId?: string;
    status?: string;
    mode?: string;
    recipient?: string;
    domain?: string;
    dateFrom?: string;
    dateTo?: string;
    page?: string;
  }>;
}) {
  const filters = await searchParams;
  const currentPage = Math.max(1, parseInt(filters.page || "1", 10));

  // Build query params for Rust endpoint
  const q = new URLSearchParams();
  if (filters.campaignId) q.set("campaignId", filters.campaignId);
  if (filters.status) q.set("status", filters.status);
  if (filters.mode) q.set("mode", filters.mode);
  if (filters.recipient) q.set("recipient", filters.recipient);
  if (filters.domain) q.set("domain", filters.domain);
  if (filters.dateFrom) q.set("dateFrom", filters.dateFrom);
  if (filters.dateTo) q.set("dateTo", filters.dateTo);

  const [campaignsRes, logsRes] = await Promise.all([
    fetchFromCore("/api/admin/outreach"),
    fetchFromCore(`/api/admin/outreach/delivery?${q.toString()}&limit=20000`),
  ]);

  const campaigns: Campaign[] = campaignsRes.ok ? await campaignsRes.json() : [];
  const allLogs: DeliveryLog[] = logsRes.ok ? await logsRes.json() : [];

  // Compute stats from returned logs
  const totalItems = allLogs.length;
  const sentCount = allLogs.filter((l) => l.status === "sent").length;
  const failedCount = allLogs.filter((l) => l.status === "failed").length;
  const failRate = totalItems > 0 ? Math.round((failedCount / totalItems) * 100) : 0;

  // Client-side pagination
  const totalPages = Math.ceil(totalItems / PAGE_SIZE);
  const logs = allLogs.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const exportParams = new URLSearchParams(q);

  return (
    <div className="admin-page">
      <AdminPageHeader eyebrow="Outreach" title="Delivery monitoring" description="Global send attempts across outreach campaigns." actions={<><a href={`/api/outreach/delivery/export?${exportParams.toString()}`} className={buttonClassName({ variant: "outline", size: "sm" })}>Export CSV</a><Link href="/outreach" className={buttonClassName({ variant: "ghost", size: "sm" })}>Back to outreach</Link></>} />

      <form className="v-card grid gap-3 p-4 md:grid-cols-7">
        <select
          name="campaignId"
          defaultValue={filters.campaignId || ""}
          className="h-[var(--density-control-height)] rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <option value="">All campaigns</option>
          {campaigns.map((campaign) => (
            <option key={campaign.id} value={campaign.id}>
              {campaign.name}
            </option>
          ))}
        </select>
        <select
          name="status"
          defaultValue={filters.status || ""}
          className="h-[var(--density-control-height)] rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <option value="">All statuses</option>
          <option value="sent">Sent</option>
          <option value="failed">Failed</option>
        </select>
        <select
          name="mode"
          defaultValue={filters.mode || ""}
          className="h-[var(--density-control-height)] rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <option value="">All types</option>
          <option value="live">Live Sends</option>
          <option value="test">Test Sends</option>
        </select>
        <input
          name="recipient"
          defaultValue={filters.recipient || ""}
          placeholder="Recipient contains..."
          className="h-[var(--density-control-height)] rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
        />
        <input
          name="domain"
          defaultValue={filters.domain || ""}
          placeholder="Domain (e.g. gmail.com)"
          className="h-[var(--density-control-height)] rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
        />
        <input
          type="date"
          name="dateFrom"
          defaultValue={filters.dateFrom || ""}
          className="h-[var(--density-control-height)] rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
        />
        <input
          type="date"
          name="dateTo"
          defaultValue={filters.dateTo || ""}
          className="h-[var(--density-control-height)] rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
        />

        <div className="md:col-span-6 flex items-center gap-2">
          <button
            type="submit"
            className={buttonClassName({ size: "sm" })}
          >
            Apply filters
          </button>
          <Link
            href="/outreach/delivery"
            className={buttonClassName({ variant: "outline", size: "sm" })}
          >
            Clear
          </Link>
        </div>
      </form>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <AdminMetric label="Filtered attempts" value={totalItems} />
        <AdminMetric label="Sent" value={sentCount} tone="success" />
        <AdminMetric label="Failed" value={failedCount} tone="danger" />
        <AdminMetric label="Failure rate" value={`${failRate}%`} tone={failRate ? "attention" : "default"} />
      </div>

      <section className="v-card p-4">
        {logs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No delivery attempts found for current filters.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1100px]">
              <thead>
                <tr className="admin-table-head border-b border-line">
                  <th className="px-2 py-2 text-left text-[11px] uppercase tracking-wide text-muted-foreground">When</th>
                  <th className="px-2 py-2 text-left text-[11px] uppercase tracking-wide text-muted-foreground">Campaign</th>
                  <th className="px-2 py-2 text-left text-[11px] uppercase tracking-wide text-muted-foreground">Type</th>
                  <th className="px-2 py-2 text-left text-[11px] uppercase tracking-wide text-muted-foreground">Business</th>
                  <th className="px-2 py-2 text-left text-[11px] uppercase tracking-wide text-muted-foreground">Recipient</th>
                  <th className="px-2 py-2 text-left text-[11px] uppercase tracking-wide text-muted-foreground">Status</th>
                  <th className="px-2 py-2 text-left text-[11px] uppercase tracking-wide text-muted-foreground">Subject</th>
                  <th className="px-2 py-2 text-left text-[11px] uppercase tracking-wide text-muted-foreground">Error</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id} className="border-b border-border/70">
                    <td className="px-2 py-2 text-xs text-muted-foreground whitespace-nowrap">
                      {new Date(log.attemptedAt).toLocaleString()}
                    </td>
                    <td className="px-2 py-2 text-xs text-foreground">
                      {log.campaign_name || "--"}
                    </td>
                    <td className="px-2 py-2 text-xs text-muted-foreground">
                      {log.campaign_category === "system-test" ? "Test" : "Live"}
                    </td>
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
                    <td className="px-2 py-2 text-xs text-foreground break-all">{log.recipient}</td>
                    <td className="px-2 py-2 text-xs">
                      <StatusBadge value={log.status} />
                    </td>
                    <td className="px-2 py-2 text-xs text-foreground max-w-[320px] truncate" title={log.subject}>
                      {log.subject}
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

      <Pagination
        currentPage={currentPage}
        totalPages={totalPages}
        totalItems={totalItems}
        pageSize={PAGE_SIZE}
      />
    </div>
  );
}
