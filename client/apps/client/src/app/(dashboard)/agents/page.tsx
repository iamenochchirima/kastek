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

export default async function AgentsPage({
  searchParams,
}: {
  searchParams: Promise<{ template?: string }>;
}) {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");
  const { template } = await searchParams;

  const response = await fetchRustJson<{ bots: AgentListItem[] }>("/api/bots").catch(() => ({
    bots: [],
  }));
  const whatsappResponse = await fetchRustJson<{
    connections: WhatsappConnectionOption[];
  }>("/api/whatsapp/connections").catch(() => ({
    connections: [],
  }));
  return (
    <AgentsPageClient
      initialAgents={response.bots}
      whatsappConnections={whatsappResponse.connections}
      initialTemplateKey={template}
    />
  );
}
