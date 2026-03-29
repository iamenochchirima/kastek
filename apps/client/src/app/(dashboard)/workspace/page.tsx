import { getRustSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";
import { Bell, Bot, Send, Sparkles } from "lucide-react";
import Link from "next/link";
import { redirect } from "next/navigation";

export const metadata = {
  title: "Workspace | KasiTek",
};

const products = [
  {
    name: "KasiAgents",
    href: "/agents",
    description: "Build AI agents, workflows, handoffs, and automation logic.",
    icon: Bot,
  },
  {
    name: "KasiReach",
    href: "/reach",
    description: "Manage contacts, templates, campaigns, and outbound growth systems.",
    icon: Send,
  },
  {
    name: "KasiInbox",
    href: "/inbox",
    description: "Handle live conversations, human replies, and operational follow-up.",
    icon: Bell,
  },
  {
    name: "KasiSocial",
    href: "/social",
    description: "Plan, publish, and analyze social content across channels.",
    icon: Sparkles,
  },
];

export default async function WorkspacePage() {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");

  const workspaceResponse = await fetchRustJson<{
    summary: {
      botCount: number;
      socialPostCount: number;
      connections: Array<{
        id: string;
        phoneDisplayNumber: string | null;
        phoneNumberId: string;
        currentQualityRating: string;
        dailyLimitEstimate: number | null;
        verified: boolean;
        createdAt: string;
        stats: {
          sentLast24h: number;
          estimatedRemainingToday: number | null;
        };
      }>;
      templateStatusMap: Record<string, number>;
      campaignsAggregate: {
        totalCampaigns: number;
        totalRecipients: number;
        deliveredCount: number;
        readCount: number;
        failedCount: number;
        blockedCount: number;
      };
      activeCampaigns: number;
      recentCampaigns: Array<{
        id: string;
        name: string;
        status: string;
        totalRecipients: number;
        deliveredCount: number;
        readCount: number;
        templateName: string;
        connectionLabel: string | null;
      }>;
      contactsAggregate: {
        total: number;
        optedIn: number;
        excluded: number;
      };
      sendStatusMap: Record<string, number>;
      reviewQueue: Array<{
        id: string;
        templateName: string;
        status: string;
        body: string | null;
        connectionLabel: string | null;
      }>;
    };
  }>("/api/workspace/summary");

  const {
    botCount,
    socialPostCount,
    connections,
    templateStatusMap,
    campaignsAggregate,
    activeCampaigns,
    recentCampaigns,
    contactsAggregate,
    sendStatusMap,
    reviewQueue,
  } = workspaceResponse.summary;

  const totalDelivered = campaignsAggregate.deliveredCount || 0;
  const totalRead = campaignsAggregate.readCount || 0;
  const totalFailures =
    (campaignsAggregate.failedCount || 0) + (campaignsAggregate.blockedCount || 0);
  const totalRecipients = campaignsAggregate.totalRecipients || 0;
  const deliveryRate = totalRecipients ? Math.round((totalDelivered / totalRecipients) * 100) : 0;
  const readRate = totalDelivered ? Math.round((totalRead / totalDelivered) * 100) : 0;
  const averageRemainingToday =
    connections.length > 0
      ? Math.round(
          connections.reduce((sum, connection) => {
            const remaining = connection.stats.estimatedRemainingToday;
            return sum + (remaining || 0);
          }, 0) / connections.length,
        )
      : 0;

  return (
    <div className="space-y-6 p-4 sm:space-y-8 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-[1600px] space-y-8">
        <section className="rounded-2xl border border-border bg-card p-5 sm:p-7">
          <div className="flex flex-wrap items-start justify-between gap-5">
            <div className="max-w-3xl">
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-primary">
                Workspace Pulse
              </div>
              <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
                Welcome back, {session.user.name ?? "there"}
              </h1>
              <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
                Keep an eye on connected numbers, template approvals, campaign performance, and how
                your products are performing across the workspace.
              </p>
            </div>

            <Link
              href="/reach/campaigns/create"
              className="w-full rounded-full bg-primary px-5 py-2.5 text-center text-sm font-semibold text-primary-foreground no-underline transition-all hover:-translate-y-0.5 hover:bg-primary/90 sm:w-auto"
            >
              Launch Campaign
            </Link>
          </div>

          <div className="mt-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <HeroMetric
              label="Active Agents"
              value={botCount.toString()}
              helper="Automations currently configured"
            />
            <HeroMetric
              label="Reach Contacts"
              value={contactsAggregate.total.toLocaleString("en-ZA")}
              helper={`${contactsAggregate.optedIn.toLocaleString("en-ZA")} opted in`}
            />
            <HeroMetric
              label="Templates Ready"
              value={(templateStatusMap.APPROVED || 0).toString()}
              helper={`${templateStatusMap.PENDING || 0} pending review`}
            />
            <HeroMetric
              label="Active Campaigns"
              value={activeCampaigns.toString()}
              helper={`${campaignsAggregate.totalCampaigns} total campaigns`}
            />
            <HeroMetric
              label="Scheduled Social"
              value={socialPostCount.toString()}
              helper="Posts queued across social workspaces"
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
              <section className="rounded-2xl border border-border bg-card p-5">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold text-foreground">Recent Campaigns</h2>
                    <p className="text-sm text-muted-foreground">
                      Latest updates across your outbound WhatsApp work.
                    </p>
                  </div>
                  <Link
                    href="/reach/campaigns"
                    className="text-sm font-medium text-primary no-underline hover:underline"
                  >
                    Open campaigns
                  </Link>
                </div>

                {recentCampaigns.length === 0 ? (
                  <EmptyState text="No campaigns yet. Launch your first outbound send from Reach." />
                ) : (
                  <div className="space-y-3">
                    {recentCampaigns.map((campaign) => (
                      <div key={campaign.id} className="rounded-2xl border border-border bg-secondary/40 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <h3 className="font-medium text-foreground">{campaign.name}</h3>
                              <p className="mt-1 text-xs text-muted-foreground">
                              {campaign.templateName || "No template"} ·{" "}
                              {campaign.connectionLabel || "No connection"}
                            </p>
                          </div>
                          <span className="rounded-full border border-border px-2.5 py-1 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                            {campaign.status}
                          </span>
                        </div>
                        <div className="mt-3 grid gap-3 sm:grid-cols-3">
                          <MiniMetric label="Recipients" value={campaign.totalRecipients || 0} />
                          <MiniMetric label="Delivered" value={campaign.deliveredCount || 0} />
                          <MiniMetric label="Read" value={campaign.readCount || 0} />
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="rounded-2xl border border-border bg-card p-5">
                <div className="mb-4 flex items-center justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold text-foreground">Review Queue</h2>
                    <p className="text-sm text-muted-foreground">
                      Templates that still need attention from Meta or from you.
                    </p>
                  </div>
                  <Link
                    href="/reach/templates"
                    className="text-sm font-medium text-primary no-underline hover:underline"
                  >
                    Open templates
                  </Link>
                </div>

                {reviewQueue.length === 0 ? (
                  <EmptyState text="No pending or rejected templates right now." />
                ) : (
                  <div className="space-y-3">
                    {reviewQueue.map((template) => (
                      <div key={template.id} className="rounded-2xl border border-border bg-secondary/40 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <h3 className="font-medium text-foreground">{template.templateName}</h3>
                            <p className="mt-1 text-xs text-muted-foreground">
                              {template.connectionLabel || "No connection"}
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
                        <p className="mt-3 text-sm text-muted-foreground">
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
            <section className="rounded-2xl border border-border bg-card p-5">
              <h2 className="text-lg font-semibold text-foreground">30-Day Send Breakdown</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Status activity pulled from send events in the last 30 days.
              </p>
              <div className="mt-5 space-y-3">
                {([
                  ["DELIVERED", sendStatusMap.DELIVERED || 0],
                  ["READ", sendStatusMap.READ || 0],
                  ["FAILED", sendStatusMap.FAILED || 0],
                  ["BLOCKED", sendStatusMap.BLOCKED || 0],
                  ["SENT", sendStatusMap.SENT || 0],
                ] as Array<[string, number]>).map(([label, count]) => (
                  <StatusRow
                    key={label}
                    label={label}
                    value={count}
                    total={Math.max(Object.values(sendStatusMap).reduce((sum, value) => sum + value, 0), 1)}
                  />
                ))}
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <h2 className="text-lg font-semibold text-foreground">Connection Health</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Quality rating and throughput headroom for each number.
              </p>
              <div className="mt-5 space-y-3">
                {connections.length === 0 ? (
                  <EmptyState text="No WhatsApp numbers connected yet." compact />
                ) : (
                  connections.map((connection) => {
                    return (
                      <div key={connection.id} className="rounded-2xl border border-border bg-secondary/40 p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <h3 className="font-medium text-foreground">
                              {connection.phoneDisplayNumber || connection.phoneNumberId}
                            </h3>
                            <p className="mt-1 text-xs text-muted-foreground">{connection.phoneNumberId}</p>
                          </div>
                          <span className="rounded-full border border-border px-2.5 py-1 text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                            {connection.currentQualityRating}
                          </span>
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-3">
                          <MiniMetric label="Sent 24h" value={connection.stats.sentLast24h || 0} />
                          <MiniMetric label="Remaining" value={connection.stats.estimatedRemainingToday || 0} />
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </section>
          </div>
        </section>

        <section className="grid gap-5 xl:grid-cols-2 2xl:grid-cols-4">
          {products.map((product) => (
            <Link
              key={product.name}
              href={product.href}
              className="rounded-xl border border-border bg-card p-5 no-underline transition-all duration-200 hover:border-primary/20 hover:bg-secondary/40"
            >
              <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-secondary/40">
                <product.icon className="h-5 w-5 text-primary" />
              </div>
              <h2 className="mt-5 text-2xl font-semibold tracking-tight text-foreground">{product.name}</h2>
              <p className="mt-3 text-sm leading-7 text-muted-foreground">{product.description}</p>
              <div className="mt-6 text-sm font-semibold text-primary">Open product</div>
            </Link>
          ))}
        </section>

        <section className="grid gap-4 md:grid-cols-3">
          <MetricCard
            label="All Contacts"
            value={contactsAggregate.total.toLocaleString("en-ZA")}
            helper="Total contact records available to segment and target"
          />
          <MetricCard
            label="Excluded Contacts"
            value={contactsAggregate.excluded.toLocaleString("en-ZA")}
            helper="Contacts currently excluded from marketing sends"
          />
          <MetricCard
            label="Failures Recorded"
            value={totalFailures.toLocaleString("en-ZA")}
            helper="Combined failed and blocked outcomes across all campaigns"
          />
        </section>
      </div>
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
    <div className="rounded-2xl border border-border bg-secondary/35 p-4">
      <p className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{label}</p>
      <p className="mt-2 text-3xl font-semibold text-foreground">{value}</p>
      <p className="mt-2 text-sm text-muted-foreground">{helper}</p>
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
    <div className="rounded-2xl border border-border bg-card p-5">
      <p className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">{label}</p>
      <p className="mt-2 text-3xl font-semibold text-foreground">{value}</p>
      <p className="mt-2 text-sm text-muted-foreground">{helper}</p>
    </div>
  );
}

function MiniMetric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-xl border border-border bg-background/40 p-3">
      <p className="text-[10px] uppercase tracking-[0.15em] text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold text-foreground">{value.toLocaleString("en-ZA")}</p>
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
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium text-foreground">{value.toLocaleString("en-ZA")}</span>
      </div>
      <div className="h-2 rounded-full bg-secondary">
        <div className="h-full rounded-full bg-primary" style={{ width }} />
      </div>
    </div>
  );
}

function EmptyState({ text, compact = false }: { text: string; compact?: boolean }) {
  return (
    <div
      className={`rounded-2xl border border-dashed border-border bg-secondary/35 text-center text-muted-foreground ${
        compact ? "px-4 py-6 text-sm" : "px-6 py-12 text-sm"
      }`}
    >
      {text}
    </div>
  );
}
