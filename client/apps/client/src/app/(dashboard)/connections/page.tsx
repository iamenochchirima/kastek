import WhatsappManualConnectionCard from "@/components/dashboard/settings/whatsapp-manual-connection-card";
import { ConnectionsManager } from "@/components/dashboard/connections/connections-manager";
import type { WhatsappConnectionView, WorkspaceConnection } from "@/lib/connections";
import { getRustSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";
import { redirect } from "next/navigation";

export const metadata = {
  title: "Connections | KasiTek",
};

export default async function ConnectionsPage() {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");

  const [sharedResponse, whatsappResponse] = await Promise.all([
    fetchRustJson<{ connections: WorkspaceConnection[] }>("/api/connections").catch(() => ({ connections: [] })),
    fetchRustJson<{ connections: WhatsappConnectionView[] }>("/api/whatsapp/connections").catch(() => ({ connections: [] })),
  ]);

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

        <ConnectionsManager connections={sharedResponse.connections} />

        <section id="whatsapp-setup" className="scroll-mt-6">
          <WhatsappManualConnectionCard connections={whatsappResponse.connections} mode="maintenance" />
        </section>
      </div>
    </div>
  );
}
