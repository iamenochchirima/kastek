import { getRustSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";
import type { AgentDefinition } from "@/lib/agent-platform";
import { redirect } from "next/navigation";
import { StudioPage } from "@/components/dashboard/studio/studio-page";

export const metadata = { title: "Studio | KasiTek" };

export default async function StudioRoute({
  searchParams,
}: {
  searchParams: Promise<{ agent?: string }>;
}) {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");

  const { agent } = await searchParams;
  await fetchRustJson<{ id: string }>("/api/agents/kasiai/ensure", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ environment: "playground" }),
  }).catch(() => null);
  const result = await fetchRustJson<{ agents: AgentDefinition[] }>("/api/agents?environment=playground")
    .then((value) => ({ agents: value.agents, unavailable: false }))
    .catch(() => ({ agents: [] as AgentDefinition[], unavailable: true }));

  return <StudioPage initialAgents={result.agents} initialAgentId={agent} agentsUnavailable={result.unavailable} />;
}
