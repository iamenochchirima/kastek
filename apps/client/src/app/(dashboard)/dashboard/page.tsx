import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { getWhatsappConnectionStats } from "@/lib/whatsapp/connection-stats";
import Link from "next/link";
import { redirect } from "next/navigation";

export const metadata = {
  title: "Overview | KasiAI",
};

const ACTIVE_CAMPAIGN_STATUSES = ["DRAFT", "SCHEDULED", "SENDING", "PAUSED"] as const;

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const [timeRow] = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT NOW() as now`;
  const currentDate = timeRow?.now || new Date("2026-03-03T00:00:00.000Z");
  const since30Days = new Date(currentDate);
  since30Days.setDate(since30Days.getDate() - 30);

  const [
    connections,
    templatesByStatus,
    campaignsAggregate,
    activeCampaigns,
    recentCampaigns,
    contactsAggregate,
    sendBreakdown,
    reviewQueue,
  ] = await Promise.all([
    prisma.whatsappConnection.findMany({
      where: { userId: session.user.id },
      select: {
        id: true,
        phoneDisplayNumber: true,
        phoneNumberId: true,
        currentQualityRating: true,
        dailyLimitEstimate: true,
        verified: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.whatsappTemplate.groupBy({
      by: ["status"],
      where: { userId: session.user.id },
      _count: true,
    }),
    prisma.whatsappCampaign.aggregate({
      where: { userId: session.user.id },
      _count: { _all: true },
      _sum: {
        totalRecipients: true,
        deliveredCount: true,
        readCount: true,
        failedCount: true,
        blockedCount: true,
      },
    }),
    prisma.whatsappCampaign.count({
      where: {
        userId: session.user.id,
        status: { in: [...ACTIVE_CAMPAIGN_STATUSES] },
      },
    }),
    prisma.whatsappCampaign.findMany({
      where: { userId: session.user.id },
      include: {
        connection: {
          select: {
            phoneDisplayNumber: true,
            phoneNumberId: true,
          },
        },
        template: {
          select: {
            templateName: true,
            language: true,
          },
        },
      },
      orderBy: { updatedAt: "desc" },
      take: 5,
    }),
    prisma.whatsappContact.aggregate({
      where: { userId: session.user.id },
      _count: { _all: true },
    }),
    prisma.whatsappSendEvent.groupBy({
      by: ["status"],
      where: {
        userId: session.user.id,
        createdAt: { gte: since30Days },
      },
      _count: true,
    }),
    prisma.whatsappTemplate.findMany({
      where: {
        userId: session.user.id,
        status: { in: ["PENDING", "REJECTED"] },
      },
      include: {
        connection: {
          select: {
            phoneDisplayNumber: true,
            phoneNumberId: true,
          },
        },
      },
      orderBy: { updatedAt: "desc" },
      take: 4,
    }),
  ]);

  const [optedInContacts, excludedContacts] = await Promise.all([
    prisma.whatsappContact.count({
      where: { userId: session.user.id, optIn: true },
    }),
    prisma.whatsappContact.count({
      where: { userId: session.user.id, excluded: true },
    }),
  ]);

  const statsByConnection = await getWhatsappConnectionStats(connections.map((connection) => connection.id));

  const templateStatusMap = Object.fromEntries(
    templatesByStatus.map((entry) => [entry.status, entry._count])
  ) as Record<string, number>;
  const sendStatusMap = Object.fromEntries(
    sendBreakdown.map((entry) => [entry.status, entry._count])
  ) as Record<string, number>;

  const totalDelivered = campaignsAggregate._sum.deliveredCount || 0;
  const totalRead = campaignsAggregate._sum.readCount || 0;
  const totalFailures =
    (campaignsAggregate._sum.failedCount || 0) + (campaignsAggregate._sum.blockedCount || 0);
  const totalRecipients = campaignsAggregate._sum.totalRecipients || 0;
  const deliveryRate = totalRecipients ? Math.round((totalDelivered / totalRecipients) * 100) : 0;
  const readRate = totalDelivered ? Math.round((totalRead / totalDelivered) * 100) : 0;
  const averageRemainingToday =
    connections.length > 0
      ? Math.round(
          connections.reduce((sum, connection) => {
            const remaining = statsByConnection.get(connection.id)?.estimatedRemainingToday;
            return sum + (remaining || 0);
          }, 0) / connections.length
        )
      : 0;

  return (
    <div className="space-y-8">
      <section className="rounded-[32px] border border-border bg-[radial-gradient(circle_at_top_left,rgba(196,240,77,0.12),transparent_26%),linear-gradient(180deg,rgba(31,31,31,0.98),rgba(20,20,20,0.98))] p-7">
        <div className="flex flex-wrap items-start justify-between gap-5">
          <div className="max-w-3xl">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-accent/20 bg-accent/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-accent">
              Workspace Pulse
            </div>
            <h1 className="text-3xl font-semibold tracking-tight text-text">
              Welcome back, {session.user.name ?? "there"}
            </h1>
            <p className="mt-2 max-w-2xl text-sm text-text-muted">
              Keep an eye on connected numbers, template approvals, campaign performance, and how
              much sending capacity you still have today.
            </p>
          </div>

          <Link
            href="/dashboard/campaigns/whatsapp/new"
            className="rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-bg no-underline transition-all hover:-translate-y-0.5 hover:shadow-[0_4px_20px_rgba(196,240,77,0.25)]"
          >
            Launch Campaign
          </Link>
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <HeroMetric
            label="Connected Numbers"
            value={connections.length.toString()}
            helper={`${connections.filter((item) => item.verified).length} verified`}
          />
          <HeroMetric
            label="Templates Ready"
            value={(templateStatusMap.APPROVED || 0).toString()}
            helper={`${templateStatusMap.PENDING || 0} pending review`}
          />
          <HeroMetric
            label="Active Campaigns"
            value={activeCampaigns.toString()}
            helper={`${campaignsAggregate._count._all} total campaigns`}
          />
          <HeroMetric
            label="Opted-in Contacts"
            value={optedInContacts.toString()}
            helper={`${excludedContacts} excluded`}
          />
        </div>
      </section>

      <section className="grid gap-6 xl:grid-cols-[minmax(0,1.25fr)_360px]">
        <div className="space-y-6">
          <div className="grid gap-4 md:grid-cols-3">
            <MetricCard
              label="Delivery Rate"
              value={`${deliveryRate}%`}
              helper={`${totalDelivered.toLocaleString("en-ZA")} delivered from ${totalRecipients.toLocaleString("en-ZA")} recipients`}
            />
            <MetricCard
              label="Read Rate"
              value={`${readRate}%`}
              helper={`${totalRead.toLocaleString("en-ZA")} reads across all campaigns`}
            />
            <MetricCard
              label="Avg Remaining Today"
              value={averageRemainingToday.toLocaleString("en-ZA")}
              helper="Estimated remaining sends per connected number"
            />
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <section className="rounded-2xl border border-border bg-surface p-5">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-text">Recent Campaigns</h2>
                  <p className="text-sm text-text-muted">Latest updates across your outbound WhatsApp work.</p>
                </div>
                <Link
                  href="/dashboard/campaigns/whatsapp"
                  className="text-sm font-medium text-accent no-underline hover:underline"
                >
                  Open campaigns
                </Link>
              </div>

              {recentCampaigns.length === 0 ? (
                <EmptyState text="No campaigns yet. Create your first WhatsApp campaign to start building activity here." />
              ) : (
                <div className="space-y-3">
                  {recentCampaigns.map((campaign) => (
                    <Link
                      key={campaign.id}
                      href={`/dashboard/campaigns/whatsapp/${campaign.id}`}
                      className="block rounded-2xl border border-border bg-surface-2 p-4 no-underline transition-colors hover:border-border-light hover:bg-surface"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h3 className="font-medium text-text">{campaign.name}</h3>
                          <p className="mt-1 text-xs text-text-dim">
                            {campaign.connection.phoneDisplayNumber || campaign.connection.phoneNumberId}
                          </p>
                        </div>
                        <span className="rounded-full border border-border px-2.5 py-1 text-[11px] uppercase tracking-[0.16em] text-text-muted">
                          {campaign.status}
                        </span>
                      </div>

                      <div className="mt-3 grid gap-3 sm:grid-cols-3">
                        <MiniMetric label="Recipients" value={campaign.totalRecipients} />
                        <MiniMetric label="Delivered" value={campaign.deliveredCount} />
                        <MiniMetric label="Read" value={campaign.readCount} />
                      </div>

                      <p className="mt-3 text-xs text-text-dim">
                        {campaign.template?.templateName || campaign.templateName} ·{" "}
                        {(campaign.template?.language || campaign.templateLanguage).replace("_", "-")} · updated{" "}
                        {campaign.updatedAt.toLocaleDateString("en-ZA")}
                      </p>
                    </Link>
                  ))}
                </div>
              )}
            </section>

            <section className="rounded-2xl border border-border bg-surface p-5">
              <div className="mb-4 flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-text">Review Queue</h2>
                  <p className="text-sm text-text-muted">Templates that still need attention from Meta or from you.</p>
                </div>
                <Link
                  href="/dashboard/templates/whatsapp"
                  className="text-sm font-medium text-accent no-underline hover:underline"
                >
                  Open templates
                </Link>
              </div>

              {reviewQueue.length === 0 ? (
                <EmptyState text="No pending or rejected templates right now." />
              ) : (
                <div className="space-y-3">
                  {reviewQueue.map((template) => (
                    <div key={template.id} className="rounded-2xl border border-border bg-surface-2 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h3 className="font-medium text-text">{template.templateName}</h3>
                          <p className="mt-1 text-xs text-text-dim">
                            {template.connection?.phoneDisplayNumber || template.connection?.phoneNumberId || "No connection"}
                          </p>
                        </div>
                        <span
                          className={`rounded-full border px-2.5 py-1 text-[11px] uppercase tracking-[0.16em] ${
                            template.status === "REJECTED"
                              ? "border-red-500/30 bg-red-500/10 text-red-300"
                              : "border-amber-500/30 bg-amber-500/10 text-amber-300"
                          }`}
                        >
                          {template.status}
                        </span>
                      </div>
                      <p className="mt-3 text-sm text-text-muted">
                        {template.body?.slice(0, 120) || "No body saved."}
                        {template.body && template.body.length > 120 ? "..." : ""}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </section>
          </div>
        </div>

        <div className="space-y-6">
          <section className="rounded-2xl border border-border bg-surface p-5">
            <h2 className="text-lg font-semibold text-text">30-Day Send Breakdown</h2>
            <p className="mt-1 text-sm text-text-muted">
              Status activity pulled from send events in the last 30 days.
            </p>
            <div className="mt-5 space-y-3">
              {[
                ["DELIVERED", sendStatusMap.DELIVERED || 0],
                ["READ", sendStatusMap.READ || 0],
                ["FAILED", sendStatusMap.FAILED || 0],
                ["BLOCKED", sendStatusMap.BLOCKED || 0],
                ["SENT", sendStatusMap.SENT || 0],
              ].map(([label, count]) => (
                <StatusRow
                  key={label}
                  label={label}
                  value={count}
                  total={Math.max(Object.values(sendStatusMap).reduce((sum, value) => sum + value, 0), 1)}
                />
              ))}
            </div>
          </section>

          <section className="rounded-2xl border border-border bg-surface p-5">
            <h2 className="text-lg font-semibold text-text">Connection Health</h2>
            <p className="mt-1 text-sm text-text-muted">Quality rating and throughput headroom for each number.</p>
            <div className="mt-5 space-y-3">
              {connections.length === 0 ? (
                <EmptyState text="No WhatsApp numbers connected yet." compact />
              ) : (
                connections.map((connection) => {
                  const stats = statsByConnection.get(connection.id);
                  return (
                    <div key={connection.id} className="rounded-2xl border border-border bg-surface-2 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h3 className="font-medium text-text">
                            {connection.phoneDisplayNumber || connection.phoneNumberId}
                          </h3>
                          <p className="mt-1 text-xs text-text-dim">{connection.phoneNumberId}</p>
                        </div>
                        <span className="rounded-full border border-border px-2.5 py-1 text-[11px] uppercase tracking-[0.16em] text-text-muted">
                          {connection.currentQualityRating}
                        </span>
                      </div>
                      <div className="mt-3 grid gap-3 grid-cols-2">
                        <MiniMetric label="Sent 24h" value={stats?.sentLast24h || 0} />
                        <MiniMetric label="Remaining" value={stats?.estimatedRemainingToday || 0} />
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </section>
        </div>
      </section>

      <section className="grid gap-4 md:grid-cols-3">
        <MetricCard
          label="All Contacts"
          value={contactsAggregate._count._all.toLocaleString("en-ZA")}
          helper="Total contact records available to segment and target"
        />
        <MetricCard
          label="Excluded Contacts"
          value={excludedContacts.toLocaleString("en-ZA")}
          helper="Contacts currently excluded from marketing sends"
        />
        <MetricCard
          label="Failures Recorded"
          value={totalFailures.toLocaleString("en-ZA")}
          helper="Combined failed and blocked outcomes across all campaigns"
        />
      </section>
    </div>
  );
}

function HeroMetric({
  label,
  value,
  helper,
}: {
  label: string;
  value: string;
  helper: string;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-4 backdrop-blur-sm">
      <p className="text-[11px] uppercase tracking-[0.18em] text-text-dim">{label}</p>
      <p className="mt-2 text-3xl font-semibold text-text">{value}</p>
      <p className="mt-2 text-sm text-text-muted">{helper}</p>
    </div>
  );
}

function MetricCard({
  label,
  value,
  helper,
}: {
  label: string;
  value: string;
  helper: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-5">
      <p className="text-[11px] uppercase tracking-[0.16em] text-text-dim">{label}</p>
      <p className="mt-2 text-3xl font-semibold text-text">{value}</p>
      <p className="mt-2 text-sm text-text-muted">{helper}</p>
    </div>
  );
}

function MiniMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-border bg-bg/50 p-3">
      <p className="text-[10px] uppercase tracking-[0.15em] text-text-dim">{label}</p>
      <p className="mt-1 text-lg font-semibold text-text">{value.toLocaleString("en-ZA")}</p>
    </div>
  );
}

function StatusRow({
  label,
  value,
  total,
}: {
  label: string;
  value: number;
  total: number;
}) {
  const width = `${Math.max((value / total) * 100, value > 0 ? 8 : 0)}%`;

  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-sm">
        <span className="text-text-muted">{label}</span>
        <span className="font-medium text-text">{value.toLocaleString("en-ZA")}</span>
      </div>
      <div className="h-2 rounded-full bg-surface-2">
        <div className="h-full rounded-full bg-accent" style={{ width }} />
      </div>
    </div>
  );
}

function EmptyState({ text, compact = false }: { text: string; compact?: boolean }) {
  return (
    <div
      className={`rounded-2xl border border-dashed border-border bg-surface-2 text-center text-text-muted ${
        compact ? "px-4 py-6 text-sm" : "px-6 py-12 text-sm"
      }`}
    >
      {text}
    </div>
  );
}
