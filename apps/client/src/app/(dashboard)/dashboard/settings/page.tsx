import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import WhatsappManualConnectionCard from "@/components/dashboard/settings/whatsapp-manual-connection-card";
import InboxAlertControls from "@/components/dashboard/inbox/inbox-alert-controls";

export const metadata = {
  title: "Settings | KasiAI",
};

export default async function SettingsPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const connections = await prisma.whatsappConnection.findMany({
    where: {
      userId: session.user.id,
    },
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
    orderBy: {
      createdAt: "desc",
    },
  });

  return (
    <div className="space-y-6">
      <h1 className="mb-2 text-3xl font-semibold tracking-tight">Settings</h1>
      <p className="text-text-muted">
        Manage existing integrations. New WhatsApp connections now start from Campaigns.
      </p>

      <section className="rounded-xl border border-border bg-surface p-5">
        <h2 className="text-lg font-semibold text-text">Inbox Alerts</h2>
        <p className="mt-1 text-sm text-text-muted">
          Control desktop popups and sound alerts for new inbound WhatsApp messages while the app
          is open in your browser.
        </p>
        <div className="mt-4">
          <InboxAlertControls title="KasiAI Inbox Alerts" showStatus compact={false} />
        </div>
      </section>

      <WhatsappManualConnectionCard
        connections={connections.map((connection) => ({
          ...connection,
          createdAt: connection.createdAt.toISOString(),
        }))}
        mode="maintenance"
      />
    </div>
  );
}
