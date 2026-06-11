import { getRustSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";
import { redirect } from "next/navigation";
import { AgentsPageClient, type AgentListItem } from "@/components/dashboard/agents/agents-page-client";

export const metadata = {
  title: "KasiAgents | KasiTek",
};

export default async function AgentsPage() {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");

  const response = await fetchRustJson<{ bots: AgentListItem[] }>("/api/bots").catch(() => ({
    bots: [],
  }));

  return <AgentsPageClient initialAgents={response.bots} />;
}
