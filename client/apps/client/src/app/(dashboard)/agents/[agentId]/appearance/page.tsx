import { notFound, redirect } from "next/navigation";
import { AgentWebsiteChatAppearancePageClient } from "@/components/dashboard/agents/agent-website-chat-appearance-page-client";
import type { AgentDefinition } from "@/lib/agent-platform";
import { getRustSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";

export const metadata = { title: "Website Chat appearance | KasiTek" };

export default async function AgentWebsiteChatAppearancePage({ params }: { params: Promise<{ agentId: string }> }) {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");
  const { agentId } = await params;
  const agents = await fetchRustJson<{ agents: AgentDefinition[] }>("/api/agents").catch(() => ({ agents: [] }));
  const agent = agents.agents.find((candidate) => candidate.id === agentId);
  if (!agent) notFound();
  if (agent.execution_mode === "external_connected" || !agent.installation_id) redirect(`/agents/${encodeURIComponent(agent.id)}`);
  return <AgentWebsiteChatAppearancePageClient agent={agent} />;
}
