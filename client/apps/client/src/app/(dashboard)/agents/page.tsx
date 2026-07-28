import { getRustSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";
import { redirect } from "next/navigation";
import {
  AgentsPageClient,
  type AgentListItem,
  type WhatsappConnectionOption,
} from "@/components/dashboard/agents/agents-page-client";

export const metadata = {
  title: "Agents | KasiTek",
};

type AgentActivityItem = {
  id: string;
  kind: string;
  createdAt: string;
  botName: string;
  title: string;
  status: string | null;
  channel: string | null;
  responseTimeMs: number | null;
  detail: string | null;
};

export default async function AgentsPage() {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");

  const response = await fetchRustJson<{ bots: AgentListItem[] }>("/api/bots").catch(() => ({
    bots: [],
  }));
  const whatsappResponse = await fetchRustJson<{
    connections: WhatsappConnectionOption[];
  }>("/api/whatsapp/connections").catch(() => ({
    connections: [],
  }));
  const activityResponse = await fetchRustJson<{ activity: AgentActivityItem[] }>("/api/bots/activity").catch(() => ({ activity: [] }));

  return (
    <AgentsPageClient
      initialAgents={response.bots}
      whatsappConnections={whatsappResponse.connections}
      activity={activityResponse.activity}
    />
  );
}
