import { redirect } from "@/lib/navigation";

export default async function AgentFeaturePage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  redirect(`/app/agents/${encodeURIComponent(agentId)}?section=deploy`);
}
