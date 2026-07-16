import WhatsappManualConnectionCard from "@/components/dashboard/settings/whatsapp-manual-connection-card";
import { getRustSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";
import { redirect } from "next/navigation";

export const metadata = {
  title: "Connections | KasiTek",
};

export default async function ConnectionsPage() {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");

  const connectionResponse = await fetchRustJson<{
    connections: Array<{
      id: string;
      phoneNumberId: string;
      phoneDisplayNumber: string | null;
      wabaId: string;
      currentQualityRating: string;
      dailyLimitEstimate: number | null;
      verified: boolean;
      createdAt: string;
    }>;
  }>("/api/whatsapp/connections").catch(() => ({ connections: [] }));

  return (
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1600px] space-y-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Connections</h1>
          <p className="mt-2 max-w-2xl text-muted-foreground">
            Connect the external accounts your workspace uses. A connection can support Inbox,
            campaigns, agents, and social publishing according to your workspace access.
          </p>
        </div>

        <WhatsappManualConnectionCard connections={connectionResponse.connections} mode="maintenance" />
      </div>
    </div>
  );
}
