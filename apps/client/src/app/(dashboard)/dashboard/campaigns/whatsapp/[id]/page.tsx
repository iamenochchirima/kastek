import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import CampaignStatusBadge from "@/components/dashboard/campaigns/campaign-status-badge";
import LaunchCampaignControls from "@/components/dashboard/campaigns/launch-campaign-controls";

const RECIPIENT_STATUS_COLORS: Record<string, string> = {
  PENDING: "text-text-muted",
  QUEUED: "text-blue-300",
  SENT: "text-amber-300",
  DELIVERED: "text-green-300",
  READ: "text-green-400",
  FAILED: "text-red-300",
  BLOCKED: "text-red-400",
  UNSUBSCRIBED: "text-zinc-300",
  SKIPPED: "text-zinc-400",
};

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const campaign = await prisma.whatsappCampaign.findUnique({
    where: { id },
    select: { name: true },
  });

  return {
    title: campaign ? `${campaign.name} | WhatsApp Campaign` : "WhatsApp Campaign",
  };
}

export default async function WhatsappCampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const { id } = await params;

  const [campaign, statusBreakdown, sendEvents] = await Promise.all([
    prisma.whatsappCampaign.findFirst({
      where: { id, userId: session.user.id },
      include: {
        connection: {
          select: {
            phoneDisplayNumber: true,
            phoneNumberId: true,
            currentQualityRating: true,
            dailyLimitEstimate: true,
          },
        },
        template: {
          select: {
            templateName: true,
            language: true,
            status: true,
            body: true,
          },
        },
        recipients: {
          include: {
            contact: {
              select: {
                fullName: true,
                phone: true,
                location: true,
                tags: true,
              },
            },
          },
          orderBy: { createdAt: "desc" },
          take: 100,
        },
      },
    }),
    prisma.whatsappCampaignRecipient.groupBy({
      by: ["status"],
      where: { campaignId: id },
      _count: true,
    }),
    prisma.whatsappSendEvent.findMany({
      where: { campaignId: id },
      include: { contact: { select: { fullName: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
  ]);

  if (!campaign) notFound();

  const successRate = campaign.totalRecipients
    ? Math.round((campaign.deliveredCount / campaign.totalRecipients) * 100)
    : 0;
  const breakdown = Object.fromEntries(statusBreakdown.map((row) => [row.status, row._count])) as Record<
    string,
    number
  >;
  const topErrors = Array.from(
    sendEvents.reduce((map, event) => {
      const key = event.errorMessage || event.errorCode;
      if (!key) return map;
      map.set(key, (map.get(key) || 0) + 1);
      return map;
    }, new Map<string, number>())
  )
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <Link
        href="/dashboard/campaigns/whatsapp"
        className="inline-flex items-center gap-1 text-sm text-text-muted no-underline hover:text-text"
      >
        ← Back to WhatsApp Campaigns
      </Link>

      <div className="rounded-xl border border-border bg-surface p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="mb-2 text-3xl font-semibold tracking-tight">{campaign.name}</h1>
            <p className="text-sm text-text-muted">
              {campaign.description || "No description provided."}
            </p>
          </div>
          <CampaignStatusBadge status={campaign.status} />
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <StatCard label="Recipients" value={campaign.totalRecipients} />
          <StatCard label="Sent" value={campaign.sentCount} />
          <StatCard label="Delivered" value={campaign.deliveredCount} />
          <StatCard label="Failed" value={campaign.failedCount + campaign.blockedCount} />
          <StatCard label="Success rate" value={`${successRate}%`} />
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="Read" value={campaign.readCount} />
          <StatCard label="Blocked" value={campaign.blockedCount} />
          <StatCard label="Unsubscribed" value={campaign.unsubscribedCount} />
          <StatCard label="Queued / pending" value={(breakdown.QUEUED || 0) + (breakdown.PENDING || 0)} />
        </div>
      </div>

      <LaunchCampaignControls campaignId={campaign.id} status={campaign.status} />

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="rounded-xl border border-border bg-surface p-5">
          <h2 className="mb-4 text-sm font-semibold">Template</h2>
          <div className="space-y-2 text-sm">
            <Row label="Name" value={campaign.template?.templateName || campaign.templateName} />
            <Row label="Language" value={campaign.template?.language || campaign.templateLanguage} />
            <Row label="Status" value={campaign.template?.status || "Unknown"} />
            {campaign.template?.body ? <Row label="Body" value={campaign.template.body} /> : null}
          </div>
        </section>

        <section className="rounded-xl border border-border bg-surface p-5">
          <h2 className="mb-4 text-sm font-semibold">Connection</h2>
          <div className="space-y-2 text-sm">
            <Row
              label="Number"
              value={campaign.connection.phoneDisplayNumber || campaign.connection.phoneNumberId}
            />
            <Row label="Quality" value={campaign.connection.currentQualityRating} />
            <Row
              label="Daily limit"
              value={campaign.connection.dailyLimitEstimate?.toString() || "Unknown"}
            />
            <Row
              label="Scheduled"
              value={
                campaign.scheduledAt ? campaign.scheduledAt.toLocaleString("en-ZA") : "Not scheduled"
              }
            />
          </div>
        </section>
      </div>

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="mb-4 text-sm font-semibold">Analytics</h2>
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="rounded-lg border border-border bg-surface-2 p-4">
            <h3 className="mb-3 text-sm font-semibold text-text">Recipient status breakdown</h3>
            <div className="space-y-2 text-sm">
              {["PENDING", "QUEUED", "SENT", "DELIVERED", "READ", "FAILED", "BLOCKED", "UNSUBSCRIBED", "SKIPPED"].map(
                (status) => (
                  <div key={status} className="flex items-center justify-between">
                    <span className="text-text-muted">{status.toLowerCase()}</span>
                    <span className="font-medium text-text">{breakdown[status] || 0}</span>
                  </div>
                )
              )}
            </div>
          </div>

          <div className="rounded-lg border border-border bg-surface-2 p-4">
            <h3 className="mb-3 text-sm font-semibold text-text">Top failure reasons</h3>
            {topErrors.length === 0 ? (
              <p className="text-sm text-text-muted">No failures recorded yet.</p>
            ) : (
              <div className="space-y-2 text-sm">
                {topErrors.map(([reason, count]) => (
                  <div key={reason} className="flex items-start justify-between gap-4">
                    <span className="text-text-muted">{reason}</span>
                    <span className="font-medium text-text">{count}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="mb-4 text-sm font-semibold">Recipients (latest 100)</h2>
        <div className="overflow-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-text-muted">
              <tr>
                <th className="px-3 py-2 text-left">Contact</th>
                <th className="px-3 py-2 text-left">Phone</th>
                <th className="px-3 py-2 text-left">Tags</th>
                <th className="px-3 py-2 text-left">Status</th>
                <th className="px-3 py-2 text-left">Error</th>
              </tr>
            </thead>
            <tbody>
              {campaign.recipients.map((recipient) => (
                <tr key={recipient.id} className="border-t border-border">
                  <td className="px-3 py-2">{recipient.contact.fullName || "-"}</td>
                  <td className="px-3 py-2">{recipient.contact.phone}</td>
                  <td className="px-3 py-2">{recipient.contact.tags.join(", ") || "-"}</td>
                  <td
                    className={`px-3 py-2 font-medium ${
                      RECIPIENT_STATUS_COLORS[recipient.status] || "text-text"
                    }`}
                  >
                    {recipient.status.toLowerCase()}
                  </td>
                  <td className="px-3 py-2 text-xs text-red-300">
                    {recipient.errorMessage || recipient.errorCode || "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="mb-4 text-sm font-semibold">Send event log (latest 100)</h2>
        {sendEvents.length === 0 ? (
          <p className="text-sm text-text-muted">No send events recorded yet.</p>
        ) : (
          <div className="overflow-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="bg-surface-2 text-text-muted">
                <tr>
                  <th className="px-3 py-2 text-left">Time</th>
                  <th className="px-3 py-2 text-left">Contact</th>
                  <th className="px-3 py-2 text-left">Phone</th>
                  <th className="px-3 py-2 text-left">Status</th>
                  <th className="px-3 py-2 text-left">Message ID</th>
                  <th className="px-3 py-2 text-left">Error</th>
                </tr>
              </thead>
              <tbody>
                {sendEvents.map((event) => (
                  <tr key={event.id} className="border-t border-border">
                    <td className="px-3 py-2 text-xs text-text-dim">
                      {event.createdAt.toLocaleString("en-ZA")}
                    </td>
                    <td className="px-3 py-2">{event.contact?.fullName || "-"}</td>
                    <td className="px-3 py-2">{event.phone}</td>
                    <td
                      className={`px-3 py-2 font-medium ${
                        RECIPIENT_STATUS_COLORS[event.status] || "text-text"
                      }`}
                    >
                      {event.status.toLowerCase()}
                    </td>
                    <td className="px-3 py-2 text-xs text-text-dim">{event.whatsappMessageId || "-"}</td>
                    <td className="px-3 py-2 text-xs text-red-300">
                      {event.errorMessage || event.errorCode || "-"}
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

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border border-border bg-surface-2 p-4">
      <p className="text-xs text-text-muted">{label}</p>
      <p className="mt-1 text-xl font-semibold text-text">{value}</p>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-3">
      <span className="w-24 shrink-0 text-text-dim">{label}</span>
      <span className="whitespace-pre-line text-text">{value}</span>
    </div>
  );
}
