import { notFound } from "@/lib/navigation";
import { fetchApiJson } from "@/lib/api-client";
import { PlannedFeature } from "@/components/platform/overview";
import type { AgentDefinition } from "@/lib/agent-platform";

export default async function AgentFeaturePage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const { agents } = await fetchApiJson<{ agents: AgentDefinition[] }>("/api/agents");
  const agent = agents.find(candidate => candidate.id === agentId);
  if (!agent) notFound();
  return <PlannedFeature title={"Workflow editor · " + agent.name} description="The workflow canvas is not part of the current setup flow. Configure the agent and test its saved version from the agent page." action={{ href: `/app/agents/${encodeURIComponent(agent.id)}?section=configuration`, label: "Back to configuration" }} />;
}
