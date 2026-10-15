import { notFound } from "@/lib/navigation";
import { fetchApiJson } from "@/lib/api-client";
import { PlannedFeature } from "@/components/platform/overview";
import type { AgentDefinition } from "@/lib/agent-platform";

export default async function AgentFeaturePage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const { agents } = await fetchApiJson<{ agents: AgentDefinition[] }>("/api/agents");
  const agent = agents.find(candidate => candidate.id === agentId);
  if (!agent) notFound();
  return <PlannedFeature title={"Website appearance · " + agent.name} description="Website publishing and appearance controls are not connected in this initial frontend." action={{ href: `/app/studio?agent=${encodeURIComponent(agent.id)}`, label: "Open Studio" }} />;
}
