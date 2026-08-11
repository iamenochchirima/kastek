import { getRustSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";
import { redirect } from "next/navigation";
import {
  AgentsPageClient,
  type AgentListItem,
} from "@/components/dashboard/agents/agents-page-client";
import type { AgentTemplate } from "@/lib/agent-platform";

export const metadata = {
  title: "Agents | KasiTek",
};

export default async function AgentsPage({
  searchParams,
}: {
  searchParams: Promise<{ template?: string }>;
}) {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");
  const { template } = await searchParams;

  const installation = await fetchRustJson<{ id: string }>("/api/agents/kasiai/ensure", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  }).catch(() => null);
  const response = await fetchRustJson<{ agents: AgentListItem[] }>("/api/agents").catch(() => ({ agents: [] }));
  const templates = await fetchRustJson<{ templates: AgentTemplate[] }>("/api/agents/templates").catch(() => ({ templates: [] }));
  return (
    <AgentsPageClient
      initialAgents={response.agents}
      kasiaiInstallationId={installation?.id ?? null}
      initialTemplates={templates.templates}
      initialTemplateKey={template}
    />
  );
}
