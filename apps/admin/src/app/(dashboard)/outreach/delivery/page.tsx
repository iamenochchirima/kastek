import Link from "next/link";
import { prisma } from "@kasitek/database";
import Pagination from "@/components/admin/pagination";

const PAGE_SIZE = 100;

function parseDateStart(value?: string) {
  if (!value) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseDateEnd(value?: string) {
  if (!value) return null;
  const d = new Date(`${value}T23:59:59.999Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function buildWhere(filters: {
  campaignId?: string;
  status?: string;
  mode?: string;
  recipient?: string;
  domain?: string;
  dateFrom?: string;
  dateTo?: string;
}) {
  const where: Record<string, unknown> = {};

  if (filters.campaignId) where.campaignId = filters.campaignId;
  if (filters.status) where.status = filters.status;
  if (filters.mode === "test") {
    where.campaign = { category: "system-test" };
  }
  if (filters.mode === "live") {
    where.NOT = { campaign: { category: "system-test" } };
  }
  if (filters.recipient) {
    where.recipient = {
      contains: filters.recipient,
      mode: "insensitive",
    };
  }
  if (filters.domain) {
    const normalizedDomain = filters.domain.replace(/^@+/, "").trim().toLowerCase();
    if (normalizedDomain) {
      where.recipient = {
        ...(typeof where.recipient === "object" && where.recipient ? (where.recipient as object) : {}),
        endsWith: `@${normalizedDomain}`,
        mode: "insensitive",
      };
    }
  }

  const from = parseDateStart(filters.dateFrom);
  const to = parseDateEnd(filters.dateTo);
  if (from || to) {
    where.attemptedAt = {
      ...(from ? { gte: from } : {}),
      ...(to ? { lte: to } : {}),
    };
  }

  return where;
}

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
  const where = buildWhere(filters);

  const [campaigns, logs, totalItems, groupedStatus] = await Promise.all([
    prisma.outreachCampaign.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    prisma.outreachEmailDeliveryLog.findMany({
      where,
      orderBy: { attemptedAt: "desc" },
      skip: (currentPage - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      include: {
        campaign: { select: { name: true, category: true } },
        lead: { select: { businessName: true, website: true } },
      },
    }),
    prisma.outreachEmailDeliveryLog.count({ where }),
    prisma.outreachEmailDeliveryLog.groupBy({
      by: ["status"],
      where,
      _count: true,
    }),
  ]);

  const totalPages = Math.ceil(totalItems / PAGE_SIZE);
  const statusMap = Object.fromEntries(groupedStatus.map((row) => [row.status, row._count]));
  const sentCount = Number(statusMap.sent || 0);
  const failedCount = Number(statusMap.failed || 0);
  const failRate = totalItems > 0 ? Math.round((failedCount / totalItems) * 100) : 0;

  const exportParams = new URLSearchParams();
  if (filters.campaignId) exportParams.set("campaignId", filters.campaignId);
  if (filters.status) exportParams.set("status", filters.status);
  if (filters.mode) exportParams.set("mode", filters.mode);
  if (filters.recipient) exportParams.set("recipient", filters.recipient);
  if (filters.domain) exportParams.set("domain", filters.domain);
  if (filters.dateFrom) exportParams.set("dateFrom", filters.dateFrom);
  if (filters.dateTo) exportParams.set("dateTo", filters.dateTo);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div>
          <Link
            href="/outreach"
            className="text-sm text-text-muted hover:text-text mb-1 inline-block"
          >
            &larr; Back to Outreach
          </Link>
          <h1 className="text-2xl font-bold text-text">Delivery Monitoring</h1>
          <p className="text-sm text-text-muted mt-1">
            Global send attempt tracking across all outreach campaigns.
          </p>
        </div>
        <a
          href={`/api/outreach/delivery/export?${exportParams.toString()}`}
          className="rounded-lg border border-border px-4 py-2 text-sm font-medium text-text hover:bg-surface-overlay transition-colors"
        >
          Export CSV
        </a>
      </div>

      <form className="rounded-xl border border-border bg-surface-raised p-4 grid gap-3 md:grid-cols-7">
        <select
          name="campaignId"
          defaultValue={filters.campaignId || ""}
          className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-primary"
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
          className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-primary"
        >
          <option value="">All statuses</option>
          <option value="sent">Sent</option>
          <option value="failed">Failed</option>
        </select>
        <select
          name="mode"
          defaultValue={filters.mode || ""}
          className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-primary"
        >
          <option value="">All types</option>
          <option value="live">Live Sends</option>
          <option value="test">Test Sends</option>
        </select>
        <input
          name="recipient"
          defaultValue={filters.recipient || ""}
          placeholder="Recipient contains..."
          className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-primary"
        />
        <input
          name="domain"
          defaultValue={filters.domain || ""}
          placeholder="Domain (e.g. gmail.com)"
          className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-primary"
        />
        <input
          type="date"
          name="dateFrom"
          defaultValue={filters.dateFrom || ""}
          className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-primary"
        />
        <input
          type="date"
          name="dateTo"
          defaultValue={filters.dateTo || ""}
          className="rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text outline-none focus:border-primary"
        />

        <div className="md:col-span-6 flex items-center gap-2">
          <button
            type="submit"
            className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white hover:bg-primary-dark transition-colors"
          >
            Apply filters
          </button>
          <Link
            href="/outreach/delivery"
            className="rounded-lg border border-border px-4 py-2 text-sm text-text hover:bg-surface-overlay transition-colors"
          >
            Clear
          </Link>
        </div>
      </form>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="rounded-xl border border-border bg-surface-raised p-4">
          <p className="text-sm text-text-muted">Filtered Attempts</p>
          <p className="text-3xl font-bold text-text mt-1">{totalItems}</p>
        </div>
        <div className="rounded-xl border border-green-500/20 bg-green-500/10 p-4">
          <p className="text-sm text-green-400">Sent</p>
          <p className="text-3xl font-bold text-green-400 mt-1">{sentCount}</p>
        </div>
        <div className="rounded-xl border border-red-500/20 bg-red-500/10 p-4">
          <p className="text-sm text-red-400">Failed</p>
          <p className="text-3xl font-bold text-red-400 mt-1">{failedCount}</p>
        </div>
        <div className="rounded-xl border border-border bg-surface-raised p-4">
          <p className="text-sm text-text-muted">Failure Rate</p>
          <p className="text-3xl font-bold text-text mt-1">{failRate}%</p>
        </div>
      </div>

      <section className="rounded-xl border border-border bg-surface-raised p-4">
        {logs.length === 0 ? (
          <p className="text-sm text-text-faint">No delivery attempts found for current filters.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1100px]">
              <thead>
                <tr className="border-b border-border">
                  <th className="px-2 py-2 text-left text-[11px] uppercase tracking-wide text-text-faint">When</th>
                  <th className="px-2 py-2 text-left text-[11px] uppercase tracking-wide text-text-faint">Campaign</th>
                  <th className="px-2 py-2 text-left text-[11px] uppercase tracking-wide text-text-faint">Type</th>
                  <th className="px-2 py-2 text-left text-[11px] uppercase tracking-wide text-text-faint">Business</th>
                  <th className="px-2 py-2 text-left text-[11px] uppercase tracking-wide text-text-faint">Recipient</th>
                  <th className="px-2 py-2 text-left text-[11px] uppercase tracking-wide text-text-faint">Status</th>
                  <th className="px-2 py-2 text-left text-[11px] uppercase tracking-wide text-text-faint">Subject</th>
                  <th className="px-2 py-2 text-left text-[11px] uppercase tracking-wide text-text-faint">Provider Response</th>
                  <th className="px-2 py-2 text-left text-[11px] uppercase tracking-wide text-text-faint">Error</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <tr key={log.id} className="border-b border-border/70">
                    <td className="px-2 py-2 text-xs text-text-muted whitespace-nowrap">
                      {new Date(log.attemptedAt).toLocaleString()}
                    </td>
                    <td className="px-2 py-2 text-xs text-text">
                      {log.campaign?.name || "--"}
                    </td>
                    <td className="px-2 py-2 text-xs text-text-muted">
                      {log.campaign?.category === "system-test" ? "Test" : "Live"}
                    </td>
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
                    <td className="px-2 py-2 text-xs text-text break-all">{log.recipient}</td>
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
                    <td className="px-2 py-2 text-xs text-text max-w-[320px] truncate" title={log.subject}>
                      {log.subject}
                    </td>
                    <td className="px-2 py-2 text-xs text-text-muted max-w-[320px] truncate" title={log.providerResponse || ""}>
                      {log.providerResponse || "--"}
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

      <Pagination
        currentPage={currentPage}
        totalPages={totalPages}
        totalItems={totalItems}
        pageSize={PAGE_SIZE}
      />
    </div>
  );
}
