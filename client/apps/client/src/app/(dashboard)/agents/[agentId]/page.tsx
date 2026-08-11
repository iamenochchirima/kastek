import { notFound, redirect } from "next/navigation";
import { AgentDetailPageClient } from "@/components/dashboard/agents/agent-detail-page-client";
import type { AgentDefinition, AgentVersion } from "@/lib/agent-platform";
import { getRustSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";

export const metadata = { title: "Agent details | KasiTek" };

export default async function AgentDetailPage({ params }: { params: Promise<{ agentId: string }> }) {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");
  const { agentId } = await params;
  const agents = await fetchRustJson<{ agents: AgentDefinition[] }>("/api/agents").catch(() => ({ agents: [] }));
  const agent = agents.agents.find((candidate) => candidate.id === agentId);
  if (!agent) notFound();
  const versions = await fetchRustJson<{ versions: AgentVersion[] }>(`/api/agents/${encodeURIComponent(agentId)}/versions`).catch(() => ({ versions: [] }));
  return <AgentDetailPageClient agent={agent} initialVersions={versions.versions} />;
}
