import { notFound, redirect } from "@/lib/navigation";
import { AgentDetailPageClient } from "@/components/dashboard/agents/agent-detail-page-client";
import type { AgentDefinition, AgentVersion } from "@/lib/agent-platform";
import { getSession } from "@/lib/session";
import { fetchApiJson } from "@/lib/api-client";

export const metadata = { title: "Agent details | KasiTek" };

export default async function AgentDetailPage({ params }: { params: Promise<{ agentId: string }> }) {
  const session = await getSession();
  if (!session?.user?.id) redirect("/login");
  const { agentId } = await params;
  const agents = await fetchApiJson<{ agents: AgentDefinition[] }>("/api/agents").catch(() => ({ agents: [] }));
  const agent = agents.agents.find((candidate) => candidate.id === agentId);
  if (!agent) notFound();
  const versions = await fetchApiJson<{ versions: AgentVersion[] }>(`/api/agents/${encodeURIComponent(agentId)}/versions`).catch(() => ({ versions: [] }));
  return <AgentDetailPageClient agent={agent} initialVersions={versions.versions} />;
}
