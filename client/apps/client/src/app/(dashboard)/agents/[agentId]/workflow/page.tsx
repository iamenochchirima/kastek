import { notFound, redirect } from "next/navigation";
import { AgentWorkflowPageClient } from "@/components/dashboard/agents/agent-workflow-page-client";
import type { AgentDefinition, AgentVersion } from "@/lib/agent-platform";
import { getRustSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";

export const metadata = { title: "Edit workflow | KasiTek" };

export default async function AgentWorkflowPage({ params }: { params: Promise<{ agentId: string }> }) {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");
  const { agentId } = await params;
  const agents = await fetchRustJson<{ agents: AgentDefinition[] }>("/api/agents").catch(() => ({ agents: [] }));
  const agent = agents.agents.find((candidate) => candidate.id === agentId);
  if (!agent) notFound();
  // The detail page already gates this action to hosted agents. Keep the
  // route tolerant of older records whose creation profile metadata is
  // missing, but never expose the hosted workflow editor for external-only
  // installations.
  if (agent.execution_mode === "external_connected") redirect(`/agents/${encodeURIComponent(agent.id)}`);
  const versions = await fetchRustJson<{ versions: AgentVersion[] }>(`/api/agents/${encodeURIComponent(agentId)}/versions`).catch(() => ({ versions: [] }));
  return <AgentWorkflowPageClient agent={agent} initialVersions={versions.versions} />;
}
