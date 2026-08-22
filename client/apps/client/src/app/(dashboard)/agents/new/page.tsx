import { getRustSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";
import { redirect } from "next/navigation";
import { CreateAgentPageClient } from "@/components/dashboard/agents/create-agent-page-client";
import type { AgentDefinition, AgentTemplate, AgentVersion } from "@/lib/agent-platform";

export const metadata = { title: "Create agent | KasiTek" };

export default async function CreateAgentPage({
  searchParams,
}: {
  searchParams: Promise<{ template?: string; draft?: string; audience?: string }>;
}) {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");
  const { template: templateKey, draft: draftId, audience } = await searchParams;
  const initialTemplate = templateKey
    ? await fetchRustJson<{ templates: AgentTemplate[] }>("/api/agents/templates")
        .then((response) => response.templates.find((template) => template.key === templateKey))
        .catch(() => undefined)
    : undefined;
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
  const selectedAudience = audience === "customer_service"
    ? "customer_service"
    : audience === "personal"
      ? "personal"
      : initialDraft?.agent.agent_audience === "customer_service"
        ? "customer_service"
        : "personal";
  return <CreateAgentPageClient audience={selectedAudience} initialTemplate={initialTemplate} initialDraft={initialDraft} />;
}
