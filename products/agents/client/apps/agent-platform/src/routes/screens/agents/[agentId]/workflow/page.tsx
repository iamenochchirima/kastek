import { notFound } from "@/lib/navigation";
import { fetchApiJson } from "@/lib/api-client";
import { PlannedFeature } from "@/components/platform/overview";
import type { AgentDefinition } from "@/lib/agent-platform";

export default async function AgentFeaturePage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const { agents } = await fetchApiJson<{ agents: AgentDefinition[] }>("/api/agents");
  const agent = agents.find(candidate => candidate.id === agentId);
  if (!agent) notFound();
  return <PlannedFeature title={"Workflow editor · " + agent.name} description="The workflow canvas test and deployment flow is not integrated in this initial frontend. Use Studio for supported version editing and playground tests." action={{ href: `/app/studio?agent=${encodeURIComponent(agent.id)}`, label: "Open Studio" }} />;
}
