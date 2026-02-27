import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import Link from "next/link";
import CampaignStatusBadge from "@/components/dashboard/campaigns/campaign-status-badge";

export const metadata = {
  title: "Campaigns | KasiAI",
};

export default async function CampaignsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const campaigns = await prisma.whatsappCampaign.findMany({
    where: {
      userId: session.user.id,
    },
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
    orderBy: {
      createdAt: "desc",
    },
  });

  return (
    <div>
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="mb-1 font-serif text-3xl">Marketing Campaigns</h1>
          <p className="text-text-muted">
            Send approved WhatsApp marketing templates to opted-in contacts.
          </p>
        </div>

        <Link
          href="/dashboard/campaigns/new"
          className="rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-bg no-underline transition-all hover:-translate-y-0.5 hover:shadow-[0_4px_20px_rgba(196,240,77,0.25)]"
        >
          New Campaign
        </Link>
      </div>

      {campaigns.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-surface py-16 text-center">
          <div className="mb-3 text-4xl text-text-dim">📣</div>
          <h2 className="mb-2 font-serif text-xl">No campaigns yet</h2>
          <p className="mx-auto mb-6 max-w-md text-sm text-text-muted">
            Create your first WhatsApp bulk campaign using approved marketing templates.
          </p>
          <Link
            href="/dashboard/campaigns/new"
            className="rounded-full bg-accent px-6 py-2.5 text-sm font-semibold text-bg no-underline transition-all hover:-translate-y-0.5"
          >
            Create Campaign
          </Link>
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
                      href={`/dashboard/campaigns/${campaign.id}`}
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
    </div>
  );
}
