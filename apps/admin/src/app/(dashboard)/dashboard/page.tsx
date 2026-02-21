import { prisma } from "@kasiai/database";
import Link from "next/link";

const STATUS_COLORS: Record<string, string> = {
  new: "bg-blue-500/15 text-blue-400",
  contacted: "bg-purple-500/15 text-purple-400",
  interested: "bg-yellow-500/15 text-yellow-400",
  quoted: "bg-orange-500/15 text-orange-400",
  won: "bg-green-500/15 text-green-400",
  lost: "bg-white/5 text-text-faint",
};

export default async function DashboardPage() {
  const [total, byStatus, bySource, recentLeads, recentConversations, conversationCount, outreachCampaigns] = await Promise.all([
    prisma.quoteRequest.count(),
    prisma.quoteRequest.groupBy({
      by: ["status"],
      _count: true,
    }),
    prisma.quoteRequest.groupBy({
      by: ["source"],
      _count: true,
    }),
    prisma.quoteRequest.findMany({
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
    prisma.conversation.findMany({
      orderBy: { lastMessageAt: "desc" },
      take: 5,
      include: {
        messages: {
          orderBy: { timestamp: "desc" },
          take: 1,
        },
      },
    }),
    prisma.conversation.count(),
    prisma.outreachCampaign.findMany({
      where: { status: { in: ["active", "draft"] } },
    }),
  ]);

  const outreachSent = outreachCampaigns.reduce((s, c) => s + c.emailsSent, 0);
  const outreachReplies = outreachCampaigns.reduce((s, c) => s + c.replies, 0);
  const outreachRate = outreachSent > 0 ? Math.round((outreachReplies / outreachSent) * 100) : 0;

  const statusMap = Object.fromEntries(
    byStatus.map((s) => [s.status, s._count])
  );
  const sourceMap = Object.fromEntries(
    bySource.map((s) => [s.source, s._count])
  );

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-text">Dashboard</h1>
        <Link
          href="/leads/new"
          className="bg-primary hover:bg-primary-dark text-white px-4 py-2 rounded-lg text-sm font-medium transition-colors"
        >
          + Add Lead
        </Link>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-6 gap-4">
        <StatCard label="Total Leads" value={total} color="bg-surface-raised border border-border text-text" />
        <StatCard label="New" value={statusMap.new || 0} color="bg-blue-500/10 border border-blue-500/20 text-blue-400" />
        <StatCard label="Interested" value={statusMap.interested || 0} color="bg-yellow-500/10 border border-yellow-500/20 text-yellow-400" />
        <StatCard label="Won" value={statusMap.won || 0} color="bg-green-500/10 border border-green-500/20 text-green-400" />
        <StatCard label="Conversations" value={conversationCount} color="bg-purple-500/10 border border-purple-500/20 text-purple-400" />
        <StatCard label="Outreach Sent" value={outreachSent} color="bg-cyan-500/10 border border-cyan-500/20 text-cyan-400" />
      </div>

      {/* Two column layout */}
      <div className="grid md:grid-cols-2 gap-6">
        {/* Leads by Source */}
        <div className="bg-surface-raised rounded-xl border border-border p-6">
          <h2 className="font-semibold mb-4 text-text">Leads by Source</h2>
          <div className="space-y-3">
            {Object.entries(sourceMap).length === 0 ? (
              <p className="text-text-faint text-sm">No leads yet</p>
            ) : (
              Object.entries(sourceMap)
                .sort((a, b) => b[1] - a[1])
                .map(([source, count]) => (
                  <div key={source} className="flex items-center justify-between">
                    <span className="text-sm text-text-muted capitalize">
                      {source.replace(/_/g, " ")}
                    </span>
                    <span className="text-sm font-semibold text-text">{count}</span>
                  </div>
                ))
            )}
          </div>
        </div>

        {/* Leads by Status */}
        <div className="bg-surface-raised rounded-xl border border-border p-6">
          <h2 className="font-semibold mb-4 text-text">Leads by Status</h2>
          <div className="space-y-3">
            {["new", "contacted", "interested", "quoted", "won", "lost"].map(
              (status) => (
                <div key={status} className="flex items-center justify-between">
                  <span
                    className={`text-xs font-medium px-2.5 py-1 rounded-full capitalize ${
                      STATUS_COLORS[status] || ""
                    }`}
                  >
                    {status}
                  </span>
                  <span className="text-sm font-semibold text-text">
                    {statusMap[status] || 0}
                  </span>
                </div>
              )
            )}
          </div>
        </div>
      </div>

      {/* Recent Leads */}
      <div className="bg-surface-raised rounded-xl border border-border p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-text">Recent Leads</h2>
          <Link href="/leads" className="text-primary text-sm font-medium hover:underline">
            View all
          </Link>
        </div>
        {recentLeads.length === 0 ? (
          <p className="text-text-faint text-sm">No leads yet. Add your first lead!</p>
        ) : (
          <div className="space-y-1">
            {recentLeads.map((lead) => (
              <Link
                key={lead.id}
                href={`/leads/${lead.id}`}
                className="flex items-center justify-between p-3 rounded-lg hover:bg-surface-overlay transition-colors"
              >
                <div>
                  <p className="font-medium text-sm text-text">{lead.businessName}</p>
                  <p className="text-text-faint text-xs">{lead.contactPerson} &middot; {lead.email}</p>
                </div>
                <span
                  className={`text-xs font-medium px-2.5 py-1 rounded-full capitalize ${
                    STATUS_COLORS[lead.status] || ""
                  }`}
                >
                  {lead.status}
                </span>
              </Link>
            ))}
          </div>
        )}
      </div>
      {/* Outreach Summary */}
      <div className="bg-surface-raised rounded-xl border border-border p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-text">Outreach Campaigns</h2>
          <Link href="/outreach" className="text-primary text-sm font-medium hover:underline">
            View all
          </Link>
        </div>
        {outreachCampaigns.length === 0 ? (
          <p className="text-text-faint text-sm">No active campaigns. <Link href="/outreach/import" className="text-primary hover:underline">Import leads</Link> to get started.</p>
        ) : (
          <div className="space-y-3">
            {outreachCampaigns.slice(0, 5).map((c) => {
              const rate = c.emailsSent > 0 ? Math.round((c.replies / c.emailsSent) * 100) : 0;
              return (
                <Link key={c.id} href={`/outreach/${c.id}`} className="flex items-center justify-between p-3 rounded-lg hover:bg-surface-overlay transition-colors">
                  <div>
                    <p className="font-medium text-sm text-text">{c.name}</p>
                    <p className="text-text-faint text-xs">{c.totalLeads} leads &middot; {c.emailsSent} sent &middot; {rate}% rate</p>
                  </div>
                  <span className={`text-xs font-medium px-2.5 py-1 rounded-full capitalize ${c.status === "active" ? "bg-green-500/15 text-green-400" : "bg-white/5 text-text-faint"}`}>
                    {c.status}
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </div>

      {/* Recent Conversations */}
      <div className="bg-surface-raised rounded-xl border border-border p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-semibold text-text">Recent Conversations</h2>
          <Link href="/conversations" className="text-primary text-sm font-medium hover:underline">
            View all
          </Link>
        </div>
        {recentConversations.length === 0 ? (
          <p className="text-text-faint text-sm">No conversations yet.</p>
        ) : (
          <div className="space-y-1">
            {recentConversations.map((conv) => {
              const lastMsg = conv.messages[0];
              return (
                <Link
                  key={conv.id}
                  href={`/conversations/${conv.id}`}
                  className="flex items-center justify-between p-3 rounded-lg hover:bg-surface-overlay transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-lg">{conv.channel === "whatsapp" ? "💬" : "🌐"}</span>
                    <div className="min-w-0">
                      <p className="font-medium text-sm text-text truncate">
                        {conv.customerName || conv.customerIdentifier}
                      </p>
                      {lastMsg && (
                        <p className="text-text-faint text-xs truncate">
                          {lastMsg.content}
                        </p>
                      )}
                    </div>
                  </div>
                  <span className="text-xs text-text-faint shrink-0 ml-2">
                    {conv.lastMessageAt.toLocaleDateString()}
                  </span>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className={`rounded-xl p-5 ${color}`}>
      <p className="text-sm opacity-70">{label}</p>
      <p className="text-3xl font-bold mt-1">{value}</p>
    </div>
  );
}
