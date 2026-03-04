import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import Link from "next/link";
import CampaignStatusBadge from "@/components/dashboard/campaigns/campaign-status-badge";
import { getWhatsappConnectionStats } from "@/lib/whatsapp/connection-stats";
import WhatsappManualConnectionCard from "@/components/dashboard/settings/whatsapp-manual-connection-card";

export const metadata = {
  title: "WhatsApp Campaigns | KasiTek",
};

export default async function WhatsappCampaignsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const [campaigns, connections, templateCount] = await Promise.all([
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
      orderBy: { createdAt: "desc" },
    }),
    prisma.whatsappConnection.findMany({
      where: { userId: session.user.id },
      select: {
        id: true,
        phoneNumberId: true,
        phoneDisplayNumber: true,
        wabaId: true,
        currentQualityRating: true,
        dailyLimitEstimate: true,
        verified: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.whatsappTemplate.count({
      where: { userId: session.user.id },
    }),
  ]);

  const statsByConnection = await getWhatsappConnectionStats(connections.map((connection) => connection.id));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <Link
            href="/dashboard/campaigns"
            className="mb-2 inline-flex items-center gap-1 text-sm text-text-muted no-underline hover:text-text"
          >
            ← Back to Campaigns
          </Link>
          <h1 className="mb-1 text-3xl font-semibold tracking-tight">WhatsApp Campaigns</h1>
          <p className="text-text-muted">
            Manage WhatsApp templates, contacts, campaign history, and outbound broadcasts.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Link
            href="/dashboard/templates/whatsapp"
            className="rounded-lg border border-border px-4 py-2 text-sm text-text no-underline hover:border-border-light"
          >
            Templates ({templateCount})
          </Link>
          <Link
            href="/dashboard/campaigns/whatsapp/new"
            className="rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-bg no-underline transition-all hover:-translate-y-0.5 hover:shadow-[0_4px_20px_rgba(196,240,77,0.25)]"
          >
            New Campaign
          </Link>
        </div>
      </div>

      {!connections.length ? (
        <div className="space-y-6">
          <div className="rounded-xl border border-dashed border-border bg-surface py-12 text-center">
            <div className="mb-3 text-4xl text-text-dim">📣</div>
            <h2 className="mb-2 text-xl font-semibold tracking-tight">Connect WhatsApp to start campaigning</h2>
            <p className="mx-auto max-w-2xl text-sm text-text-muted">
              WhatsApp campaigns depend on your number connection, approved templates, and opted-in
              contacts. Connect your Meta WhatsApp Cloud API here first.
            </p>
          </div>

          <WhatsappManualConnectionCard
            connections={connections.map((connection) => ({
              ...connection,
              createdAt: connection.createdAt.toISOString(),
            }))}
            mode="setup"
          />
        </div>
      ) : (
        <>
          <div className="grid gap-4 lg:grid-cols-2">
            {connections.map((connection) => {
              const stats = statsByConnection.get(connection.id);
              return (
                <div key={connection.id} className="rounded-xl border border-border bg-surface p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 className="text-base font-semibold text-text">
                        {connection.phoneDisplayNumber || "Unnamed WhatsApp number"}
                      </h2>
                      <p className="mt-1 text-xs text-text-dim">{connection.phoneNumberId}</p>
                    </div>
                    <span className="rounded-full border border-border px-2.5 py-1 text-xs text-text-muted">
                      Quality {connection.currentQualityRating}
                    </span>
                  </div>

                  <div className="mt-4 grid gap-3 sm:grid-cols-3">
                    <Metric
                      label="Current limit"
                      value={connection.dailyLimitEstimate?.toLocaleString("en-ZA") || "Unknown"}
                    />
                    <Metric
                      label="Remaining"
                      value={stats?.estimatedRemainingToday?.toLocaleString("en-ZA") || "Unknown"}
                    />
                    <Metric
                      label="Sent 24h"
                      value={stats?.sentLast24h.toLocaleString("en-ZA") || "0"}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          {campaigns.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-surface py-16 text-center">
              <div className="mb-3 text-4xl text-text-dim">📣</div>
              <h2 className="mb-2 text-xl font-semibold tracking-tight">No WhatsApp campaigns yet</h2>
              <p className="mx-auto mb-6 max-w-md text-sm text-text-muted">
                Start by creating or syncing templates, then launch your first WhatsApp campaign.
              </p>
              <div className="flex justify-center gap-3">
                <Link
                  href="/dashboard/templates/whatsapp"
                  className="rounded-lg border border-border px-4 py-2 text-sm text-text no-underline hover:border-border-light"
                >
                  Manage Templates
                </Link>
                <Link
                  href="/dashboard/campaigns/whatsapp/new"
                  className="rounded-full bg-accent px-6 py-2.5 text-sm font-semibold text-bg no-underline transition-all hover:-translate-y-0.5"
                >
                  Create Campaign
                </Link>
              </div>
            </div>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border bg-surface">
              <table className="w-full text-sm">
                <thead className="border-b border-border bg-surface-2 text-text-muted">
                  <tr>
                    <th className="px-4 py-3 text-left">Campaign</th>
                    <th className="px-4 py-3 text-left">Status</th>
                    <th className="px-4 py-3 text-left">Template</th>
                    <th className="px-4 py-3 text-left">Recipients</th>
                    <th className="px-4 py-3 text-left">Delivered</th>
                    <th className="px-4 py-3 text-left">Failed</th>
                    <th className="px-4 py-3 text-left">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((campaign) => (
                    <tr key={campaign.id} className="border-t border-border hover:bg-surface-2/40">
                      <td className="px-4 py-3">
                        <Link
                          href={`/dashboard/campaigns/whatsapp/${campaign.id}`}
                          className="font-medium text-text no-underline hover:text-accent"
                        >
                          {campaign.name}
                        </Link>
                        <p className="text-xs text-text-dim">
                          {campaign.connection.phoneDisplayNumber || campaign.connection.phoneNumberId}
                        </p>
                      </td>
                      <td className="px-4 py-3">
                        <CampaignStatusBadge status={campaign.status} />
                      </td>
                      <td className="px-4 py-3 text-text-muted">
                        {campaign.template?.templateName || campaign.templateName}
                        <p className="text-xs text-text-dim">
                          {campaign.template?.language || campaign.templateLanguage}
                        </p>
                      </td>
                      <td className="px-4 py-3">{campaign.totalRecipients}</td>
                      <td className="px-4 py-3">{campaign.deliveredCount}</td>
                      <td className="px-4 py-3">{campaign.failedCount + campaign.blockedCount}</td>
                      <td className="px-4 py-3 text-xs text-text-dim">
                        {campaign.createdAt.toLocaleDateString("en-ZA")}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface-2 p-3">
      <p className="text-[11px] uppercase tracking-[0.15em] text-text-dim">{label}</p>
      <p className="mt-1 text-lg font-semibold text-text">{value}</p>
    </div>
  );
}
