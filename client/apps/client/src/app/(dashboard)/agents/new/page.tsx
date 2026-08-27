import { getRustSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";
import { redirect } from "next/navigation";
import { AgentCreationFlowPageClient, type AgentCreationAudience, type AgentCreationKind } from "@/components/dashboard/agents/agent-creation-flow-page-client";
import type { AgentDefinition, AgentTemplate, AgentVersion } from "@/lib/agent-platform";

export const metadata = { title: "Create agent | KasiTek" };

export default async function CreateAgentPage({
  searchParams,
}: {
  searchParams: Promise<{ template?: string; draft?: string; audience?: string; flow?: string }>;
}) {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");
  const { template: templateKey, draft: draftId, audience, flow } = await searchParams;
  const initialDraft = draftId
    ? await fetchRustJson<{ agents: AgentDefinition[] }>("/api/agents")
        .then(async (response) => {
          const agent = response.agents.find((candidate) => candidate.id === draftId);
          if (!agent) return undefined;
          const versions = await fetchRustJson<{ versions: AgentVersion[] }>(`/api/agents/${encodeURIComponent(draftId)}/versions`);
          const version = versions.versions.find((candidate) => candidate.status === "draft") ?? versions.versions[0];
          return version ? { agent, version } : undefined;
        })
        .catch(() => undefined)
    : undefined;
  const requestedAudience: AgentCreationAudience | undefined = audience === "customer_service"
    ? "customer_service"
    : audience === "personal"
      ? "personal"
      : undefined;
  const selectedAudience: AgentCreationAudience | undefined = initialDraft
    ? initialDraft.agent.agent_audience === "customer_service" ? "customer_service" : "personal"
    : requestedAudience ?? (templateKey ? "personal" : undefined);
  // Keep template selection scoped to the chosen audience. A copied or stale
  // URL must not apply a customer-service blueprint to a personal agent.
  const initialTemplate = templateKey && selectedAudience
    ? await fetchRustJson<{ templates: AgentTemplate[] }>(`/api/agents/templates?audience=${selectedAudience}`)
        .then((response) => response.templates.find((template) => template.key === templateKey))
        .catch(() => undefined)
    : undefined;
  const initialMode: AgentCreationKind | undefined = flow === "general"
    ? "general"
    : flow === "custom" || templateKey || initialDraft
      ? "custom"
      : undefined;
  return <AgentCreationFlowPageClient userId={session.user.id} initialAudience={selectedAudience} initialMode={initialMode} initialTemplate={initialTemplate} initialDraft={initialDraft} />;
}
