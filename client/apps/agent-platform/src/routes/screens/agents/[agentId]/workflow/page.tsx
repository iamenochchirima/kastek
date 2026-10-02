import { notFound, redirect } from "@/lib/navigation";
import { AgentWorkflowPageClient } from "@/components/dashboard/agents/agent-workflow-page-client";
import type { AgentDefinition, AgentVersion } from "@/lib/agent-platform";
import { getSession } from "@/lib/session";
import { fetchApiJson } from "@/lib/api-client";

export const metadata = { title: "Edit workflow | KasiTek" };

export default async function AgentWorkflowPage({ params }: { params: Promise<{ agentId: string }> }) {
  const session = await getSession();
  if (!session?.user?.id) redirect("/login");
  const { agentId } = await params;
  const agents = await fetchApiJson<{ agents: AgentDefinition[] }>("/api/agents").catch(() => ({ agents: [] }));
  const agent = agents.agents.find((candidate) => candidate.id === agentId);
  if (!agent) notFound();
  // The detail page already gates this action to hosted agents. Keep the
  // route tolerant of older records whose creation profile metadata is
  // missing, but never expose the hosted workflow editor for external-only
  // installations.
  if (agent.execution_mode === "external_connected") redirect(`/agents/${encodeURIComponent(agent.id)}`);
  const versions = await fetchApiJson<{ versions: AgentVersion[] }>(`/api/agents/${encodeURIComponent(agentId)}/versions`).catch(() => ({ versions: [] }));
  return <AgentWorkflowPageClient agent={agent} initialVersions={versions.versions} />;
}
