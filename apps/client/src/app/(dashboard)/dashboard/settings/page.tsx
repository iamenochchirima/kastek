import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import WhatsappManualConnectionCard from "@/components/dashboard/settings/whatsapp-manual-connection-card";

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
      <h1 className="mb-2 font-serif text-3xl">Settings</h1>
      <p className="text-text-muted">
        Manage existing integrations. New WhatsApp connections now start from Campaigns.
      </p>

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
