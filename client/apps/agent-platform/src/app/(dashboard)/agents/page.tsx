import { getRustSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";
import { redirect } from "next/navigation";
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
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");
  const { template, view } = await searchParams;
  const initialView: AgentView = view === "external" ? "external" : "agents";

  await fetchRustJson<{ id: string }>("/api/agents/kasiai/ensure", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  }).catch(() => null);
  const agentResult = await fetchRustJson<{ agents: AgentListItem[]; counts?: AgentAudienceCounts }>("/api/agents")
    .then((value) => ({ value, unavailable: false }))
    .catch(() => ({ value: { agents: [] as AgentListItem[], counts: undefined }, unavailable: true }));
  const operations = await fetchRustJson<AgentOperationsSummary>("/api/agents/operations/summary").catch(() => null);
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
