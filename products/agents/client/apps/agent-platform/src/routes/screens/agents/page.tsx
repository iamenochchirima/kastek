import { getSession } from "@/lib/session";
import { fetchApiJson } from "@/lib/api-client";
import { redirect } from "@/lib/navigation";
import {
  AgentsPageClient,
  type AgentView,
  type AgentListItem,
} from "@/components/dashboard/agents/agents-page-client";
import type { AgentAudienceCounts, AgentOperationsSummary } from "@/lib/agent-platform";

export const metadata = {
  title: "Agents | KasiTek",
};

export default async function AgentsPage({
  searchParams,
}: {
  searchParams: Promise<{ template?: string; view?: string }>;
}) {
  const session = await getSession();
  if (!session?.user?.id) redirect("/login");
  const { template, view } = await searchParams;
  const initialView: AgentView = view === "personal" ? "personal" : view === "external" ? "external" : "agents";

  const agentResult = await fetchApiJson<{ agents: AgentListItem[]; counts?: AgentAudienceCounts }>("/api/agents")
    .then((value) => ({ value, unavailable: false }))
    .catch(() => ({ value: { agents: [] as AgentListItem[], counts: undefined }, unavailable: true }));
  const operations = await fetchApiJson<AgentOperationsSummary>("/api/agents/operations/summary").catch(() => null);
  return (
    <AgentsPageClient
      initialAgents={agentResult.value.agents}
      initialCounts={agentResult.value.counts}
      initialTemplateKey={template}
      userId={session.user.id}
      initialView={initialView}
      agentsUnavailable={agentResult.unavailable}
      initialOperations={operations}
    />
  );
}
