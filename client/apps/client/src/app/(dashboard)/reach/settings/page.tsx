import InboxAlertControls from "@/components/dashboard/inbox/inbox-alert-controls";
import WhatsappManualConnectionCard from "@/components/dashboard/settings/whatsapp-manual-connection-card";
import { getRustSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";
import { redirect } from "next/navigation";

export const metadata = {
  title: "Settings | KasiTek",
};

export default async function ReachSettingsPage() {
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

  const connections = connectionResponse.connections;

  return (
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1600px] space-y-6">
        <div>
          <h1 className="mb-2 text-3xl font-semibold tracking-tight text-foreground">Settings</h1>
          <p className="text-muted-foreground">
            Manage existing integrations, alert preferences, and WhatsApp connection maintenance.
          </p>
        </div>

        <section className="rounded-xl border border-border bg-card p-5">
          <h2 className="text-lg font-semibold text-foreground">Inbox Alerts</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Control desktop popups and sound alerts for new inbound WhatsApp messages while the app
            is open in your browser.
          </p>
          <div className="mt-4">
            <InboxAlertControls title="KasiTek Inbox Alerts" showStatus compact={false} />
          </div>
        </section>

        <WhatsappManualConnectionCard
          connections={connections}
          mode="maintenance"
        />
      </div>
    </div>
  );
}
