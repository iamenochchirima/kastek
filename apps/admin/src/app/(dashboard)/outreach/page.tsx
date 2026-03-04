import { prisma } from "@kasitek/database";
import Link from "next/link";
import CampaignsTable from "@/components/admin/campaigns-table";
import OutreachDeleteAllButton from "@/components/admin/outreach-delete-all";
import AddOutreachLead from "@/components/admin/add-outreach-lead";

export default async function OutreachPage() {
  const [campaigns, statusBreakdown, categoryBreakdown] = await Promise.all([
    prisma.outreachCampaign.findMany({
      orderBy: { createdAt: "desc" },
    }),
    prisma.outreachLead.groupBy({
      by: ["emailStatus"],
      _count: true,
    }),
    prisma.outreachLead.groupBy({
      by: ["category", "emailStatus"],
      _count: true,
    }),
  ]);

  const serialized = campaigns.map((c) => ({
    id: c.id,
    name: c.name,
    category: c.category,
    status: c.status,
    totalLeads: c.totalLeads,
    emailsSent: c.emailsSent,
    replies: c.replies,
    createdAt: c.createdAt.toISOString(),
  }));

  // Overall stats
  const totalLeads = campaigns.reduce((sum, c) => sum + c.totalLeads, 0);
  const statusMap = Object.fromEntries(
    statusBreakdown.map((s) => [s.emailStatus, s._count])
  );
  const totalSent = (statusMap.sent || 0) + (statusMap.replied || 0) + (statusMap.interested || 0) + (statusMap.not_interested || 0);
  const totalReplied = (statusMap.replied || 0) + (statusMap.interested || 0) + (statusMap.not_interested || 0);
  const totalInterested = statusMap.interested || 0;
  const totalBounced = statusMap.bounced || 0;
  const totalPending = statusMap.pending || 0;
  const responseRate = totalSent > 0 ? Math.round((totalReplied / totalSent) * 100) : 0;
  const interestRate = totalSent > 0 ? Math.round((totalInterested / totalSent) * 100) : 0;

  // Category stats
  type CategoryStats = {
    total: number;
    pending: number;
    sent: number;
    replied: number;
    interested: number;
    not_interested: number;
    bounced: number;
  };
  const categoryMap: Record<string, CategoryStats> = {};
  for (const row of categoryBreakdown) {
    if (!categoryMap[row.category]) {
      categoryMap[row.category] = {
        total: 0,
        pending: 0,
        sent: 0,
        replied: 0,
        interested: 0,
        not_interested: 0,
        bounced: 0,
      };
    }
    categoryMap[row.category].total += row._count;
    const status = row.emailStatus as keyof CategoryStats;
    if (status in categoryMap[row.category]) {
      (categoryMap[row.category][status] as number) += row._count;
    }
  }

  const sortedCategories = Object.entries(categoryMap).sort(
    (a, b) => b[1].total - a[1].total
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-text">
          AI Services ({campaigns.length} campaigns)
        </h1>
        <div className="flex items-center gap-3">
          {campaigns.length > 0 && <OutreachDeleteAllButton campaignCount={campaigns.length} leadCount={totalLeads} />}
          {campaigns.length > 0 && (
            <AddOutreachLead
              campaigns={campaigns.map((c) => ({ id: c.id, name: c.name, category: c.category }))}
            />
          )}
          <Link
            href="/outreach/import"
            className="bg-primary hover:bg-primary-dark text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
          >
            + Import
          </Link>
        </div>
      </div>

      {/* Overall Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-surface-raised rounded-xl border border-border p-5">
          <p className="text-sm text-text-muted">Total Leads</p>
          <p className="text-3xl font-bold text-text mt-1">{totalLeads}</p>
          <p className="text-xs text-text-faint mt-1">{totalPending} pending</p>
        </div>
        <div className="bg-blue-500/10 rounded-xl border border-blue-500/20 p-5">
          <p className="text-sm text-blue-400">Emails Sent</p>
          <p className="text-3xl font-bold text-blue-400 mt-1">{totalSent}</p>
          <p className="text-xs text-blue-400/60 mt-1">
            {totalLeads > 0 ? Math.round((totalSent / totalLeads) * 100) : 0}% of leads
          </p>
        </div>
        <div className="bg-purple-500/10 rounded-xl border border-purple-500/20 p-5">
          <p className="text-sm text-purple-400">Replied</p>
          <p className="text-3xl font-bold text-purple-400 mt-1">{totalReplied}</p>
          <p className="text-xs text-purple-400/60 mt-1">{responseRate}% response rate</p>
        </div>
        <div className="bg-green-500/10 rounded-xl border border-green-500/20 p-5">
          <p className="text-sm text-green-400">Interested</p>
          <p className="text-3xl font-bold text-green-400 mt-1">{totalInterested}</p>
          <p className="text-xs text-green-400/60 mt-1">{interestRate}% interest rate</p>
        </div>
      </div>

      {/* Pipeline Breakdown */}
      <div className="grid md:grid-cols-2 gap-6">
        <div className="bg-surface-raised rounded-xl border border-border p-6">
          <h2 className="font-semibold mb-4 text-text">Outreach Pipeline</h2>
          <div className="space-y-3">
            <PipelineRow label="Pending" count={totalPending} total={totalLeads} color="bg-white/20" />
            <PipelineRow label="Sent" count={statusMap.sent || 0} total={totalLeads} color="bg-blue-500" />
            <PipelineRow label="Replied" count={statusMap.replied || 0} total={totalLeads} color="bg-purple-500" />
            <PipelineRow label="Interested" count={totalInterested} total={totalLeads} color="bg-green-500" />
            <PipelineRow label="Not Interested" count={statusMap.not_interested || 0} total={totalLeads} color="bg-yellow-500" />
            <PipelineRow label="Bounced" count={totalBounced} total={totalLeads} color="bg-red-500" />
          </div>
        </div>

        {/* By Category */}
        <div className="bg-surface-raised rounded-xl border border-border p-6">
          <h2 className="font-semibold mb-4 text-text">By Category</h2>
          {sortedCategories.length === 0 ? (
            <p className="text-text-faint text-sm">No leads imported yet</p>
          ) : (
            <div className="space-y-3 max-h-80 overflow-y-auto">
              {sortedCategories.map(([category, stats]) => {
                const catSent = stats.sent + stats.replied + stats.interested + stats.not_interested;
                const catReplied = stats.replied + stats.interested + stats.not_interested;
                const catRate = catSent > 0 ? Math.round((catReplied / catSent) * 100) : 0;
                return (
                  <div key={category} className="border-b border-border pb-3 last:border-0 last:pb-0">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium text-text capitalize">
                        {category.replace(/-/g, " ")}
                      </span>
                      <span className="text-xs text-text-muted">{stats.total} leads</span>
                    </div>
                    <div className="flex gap-2 text-xs">
                      <span className="text-text-faint">{stats.pending} pending</span>
                      <span className="text-blue-400">{catSent} sent</span>
                      <span className="text-purple-400">{catReplied} replied</span>
                      <span className="text-green-400">{stats.interested} interested</span>
                      {catRate > 0 && (
                        <span className="text-text-muted ml-auto">{catRate}% rate</span>
                      )}
                    </div>
                    {/* Mini progress bar */}
                    <div className="flex h-1.5 rounded-full overflow-hidden mt-2 bg-white/5">
                      {stats.interested > 0 && (
                        <div className="bg-green-500" style={{ width: `${(stats.interested / stats.total) * 100}%` }} />
                      )}
                      {stats.replied > 0 && (
                        <div className="bg-purple-500" style={{ width: `${(stats.replied / stats.total) * 100}%` }} />
                      )}
                      {stats.not_interested > 0 && (
                        <div className="bg-yellow-500" style={{ width: `${(stats.not_interested / stats.total) * 100}%` }} />
                      )}
                      {stats.sent > 0 && (
                        <div className="bg-blue-500" style={{ width: `${(stats.sent / stats.total) * 100}%` }} />
                      )}
                      {stats.bounced > 0 && (
                        <div className="bg-red-500" style={{ width: `${(stats.bounced / stats.total) * 100}%` }} />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Campaigns Table */}
      <CampaignsTable campaigns={serialized} />
    </div>
  );
}

function PipelineRow({
  label,
  count,
  total,
  color,
}: {
  label: string;
  count: number;
  total: number;
  color: string;
}) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm text-text-muted">{label}</span>
        <span className="text-sm font-semibold text-text">
          {count} <span className="text-text-faint font-normal">({pct}%)</span>
        </span>
      </div>
      <div className="h-2 rounded-full bg-white/5 overflow-hidden">
        <div
          className={`h-full rounded-full ${color} transition-all`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
