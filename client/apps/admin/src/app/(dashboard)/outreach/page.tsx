import { fetchFromCore } from "@/lib/admin-auth";
import Link from "next/link";
import CampaignsTable from "@/components/admin/campaigns-table";
import OutreachDeleteAllButton from "@/components/admin/outreach-delete-all";
import AddOutreachLead from "@/components/admin/add-outreach-lead";
import OutreachSyncDraftsButton from "@/components/admin/outreach-sync-drafts-button";
import { AdminMetric, AdminPageHeader } from "@/components/admin/page-header";
import { buttonClassName } from "@/components/ui/button";
import { Download, Mail, Plus } from "lucide-react";

type Campaign = {
  id: string;
  name: string;
  category: string;
  status: string;
  totalLeads: number;
  emailsSent: number;
  replies: number;
  createdAt: string;
};

export default async function OutreachPage() {
  const res = await fetchFromCore("/api/admin/outreach");
  const campaigns: Campaign[] = res.ok ? await res.json() : [];

  // Aggregate stats from campaign-level data
  const totalLeads = campaigns.reduce((s, c) => s + c.totalLeads, 0);
  const totalSent = campaigns.reduce((s, c) => s + c.emailsSent, 0);
  const totalReplied = campaigns.reduce((s, c) => s + c.replies, 0);
  const responseRate = totalSent > 0 ? Math.round((totalReplied / totalSent) * 100) : 0;
  const totalPending = totalLeads - totalSent;

  // By category: group campaigns by category
  type CategoryStats = { total: number; sent: number; replied: number };
  const categoryMap: Record<string, CategoryStats> = {};
  for (const c of campaigns) {
    if (!categoryMap[c.category]) {
      categoryMap[c.category] = { total: 0, sent: 0, replied: 0 };
    }
    categoryMap[c.category].total += c.totalLeads;
    categoryMap[c.category].sent += c.emailsSent;
    categoryMap[c.category].replied += c.replies;
  }
  const sortedCategories = Object.entries(categoryMap).sort((a, b) => b[1].total - a[1].total);

  return (
    <div className="admin-page">
      <AdminPageHeader title="AI services" description={`${campaigns.length} campaign${campaigns.length === 1 ? "" : "s"} with ${totalLeads} total leads.`} actions={<>
          <Link
            href="/outreach/delivery"
            className={buttonClassName({ variant: "secondary" })}
          >
            <Download className="size-4" />Delivery log
          </Link>
          <Link
            href="/outreach/drafts"
            className={buttonClassName({ variant: "secondary" })}
          >
            <Mail className="size-4" />Email drafts
          </Link>
          <OutreachSyncDraftsButton />
          {campaigns.length > 0 && <OutreachDeleteAllButton campaignCount={campaigns.length} leadCount={totalLeads} />}
          {campaigns.length > 0 && (
            <AddOutreachLead
              campaigns={campaigns.map((c) => ({ id: c.id, name: c.name, category: c.category }))}
            />
          )}
          <Link
            href="/outreach/import"
            className={buttonClassName()}
          >
            <Plus className="size-4" />Import
          </Link>
      </>} />

      {/* Overall Stats */}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><AdminMetric label="Total leads" value={totalLeads} detail={`${totalPending} pending`} /><AdminMetric label="Emails sent" value={totalSent} detail={`${totalLeads > 0 ? Math.round((totalSent / totalLeads) * 100) : 0}% of leads`} tone="info" /><AdminMetric label="Replied" value={totalReplied} detail={`${responseRate}% response rate`} tone="attention" /><AdminMetric label="Campaigns" value={campaigns.length} detail={`${campaigns.filter((c) => c.status === "active").length} active`} tone="success" /></div>

      {/* Pipeline Breakdown */}
      <div className="grid md:grid-cols-2 gap-6">
        <div className="v-card p-[var(--density-card-padding)]">
          <h2 className="text-base font-semibold tracking-[-0.01em] text-foreground">Outreach pipeline</h2>
          <div className="space-y-3">
            <PipelineRow label="Pending" count={totalPending} total={totalLeads} color="bg-secondary" />
            <PipelineRow label="Sent" count={totalSent} total={totalLeads} color="bg-status-info" />
            <PipelineRow label="Replied" count={totalReplied} total={totalLeads} color="bg-brand-2" />
          </div>
        </div>

        {/* By Category */}
        <div className="v-card p-[var(--density-card-padding)]">
          <h2 className="text-base font-semibold tracking-[-0.01em] text-foreground">By category</h2>
          {sortedCategories.length === 0 ? (
            <p className="text-sm text-muted-foreground">No leads imported yet</p>
          ) : (
            <div className="space-y-3 max-h-80 overflow-y-auto">
              {sortedCategories.map(([category, stats]) => {
                const catRate = stats.sent > 0 ? Math.round((stats.replied / stats.sent) * 100) : 0;
                return (
                  <div key={category} className="border-b border-border pb-3 last:border-0 last:pb-0">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium capitalize text-foreground">
                        {category.replace(/-/g, " ")}
                      </span>
                      <span className="text-xs text-muted-foreground">{stats.total} leads</span>
                    </div>
                    <div className="flex gap-2 text-xs">
                      <span className="text-muted-foreground">{stats.total - stats.sent} pending</span>
                      <span className="text-status-info">{stats.sent} sent</span>
                      <span className="text-brand-2">{stats.replied} replied</span>
                      {catRate > 0 && (
                        <span className="ml-auto text-muted-foreground">{catRate}% rate</span>
                      )}
                    </div>
                    <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-secondary">
                      {stats.replied > 0 && (
                        <div className="bg-brand-2" style={{ width: `${(stats.replied / stats.total) * 100}%` }} />
                      )}
                      {stats.sent > 0 && (
                        <div className="bg-status-info" style={{ width: `${((stats.sent - stats.replied) / stats.total) * 100}%` }} />
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
      <CampaignsTable campaigns={campaigns} />
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
        <span className="text-sm text-muted-foreground">{label}</span>
        <span className="text-sm font-semibold text-foreground">
          {count} <span className="font-normal text-muted-foreground">({pct}%)</span>
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-secondary">
        <div
          className={`h-full rounded-full ${color} transition-all`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}
