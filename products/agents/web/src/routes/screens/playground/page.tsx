import { redirect } from "@/lib/navigation";
import { StudioPage } from "@/components/dashboard/studio/studio-page";
import { getSession } from "@/lib/session";
import { fetchApiJson } from "@/lib/api-client";
import type { AgentDefinition } from "@/lib/agent-platform";

export const metadata = { title: "Playground | KasiTek" };

export default async function PlaygroundRoute({
  searchParams,
}: {
  searchParams: Promise<{ agent?: string }>;
}) {
  const session = await getSession();
  if (!session?.user?.id) redirect("/login");
  const { agent } = await searchParams;
  const result = await fetchApiJson<{ agents: AgentDefinition[] }>("/api/agents?environment=playground")
    .then((value) => ({ agents: value.agents, unavailable: false }))
    .catch(() => ({ agents: [] as AgentDefinition[], unavailable: true }));
  return <StudioPage initialAgents={result.agents} initialAgentId={agent} agentsUnavailable={result.unavailable} surface="playground" />;
}
