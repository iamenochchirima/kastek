import { getSession } from "@/lib/session";
import { fetchApiJson } from "@/lib/api-client";
import type { AgentDefinition } from "@/lib/agent-platform";
import { redirect } from "@/lib/navigation";
import { StudioPage } from "@/components/dashboard/studio/studio-page";

export const metadata = { title: "Studio | KasiTek" };

export default async function StudioRoute({
  searchParams,
}: {
  searchParams: Promise<{ agent?: string; installationId?: string }>;
}) {
  const session = await getSession();
  if (!session?.user?.id) redirect("/login");

  const { agent, installationId } = await searchParams;
  const result = await fetchApiJson<{ agents: AgentDefinition[] }>("/api/agents?environment=playground")
    .then((value) => ({ agents: value.agents, unavailable: false }))
    .catch(() => ({ agents: [] as AgentDefinition[], unavailable: true }));
  const returnAgentId = agent ?? (installationId
    ? result.agents.find((candidate) => candidate.installation_id === installationId)?.id
    : undefined);

  return <StudioPage initialAgents={result.agents} initialAgentId={returnAgentId} agentsUnavailable={result.unavailable} />;
}
