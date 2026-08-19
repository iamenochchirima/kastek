import { getRustSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";
import { redirect } from "next/navigation";
import { CreateAgentPageClient } from "@/components/dashboard/agents/create-agent-page-client";
import type { AgentTemplate } from "@/lib/agent-platform";

export const metadata = { title: "Create agent | KasiTek" };

export default async function CreateAgentPage({
  searchParams,
}: {
  searchParams: Promise<{ template?: string }>;
}) {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");
  const { template: templateKey } = await searchParams;
  const initialTemplate = templateKey
    ? await fetchRustJson<{ templates: AgentTemplate[] }>("/api/agents/templates")
        .then((response) => response.templates.find((template) => template.key === templateKey))
        .catch(() => undefined)
    : undefined;
  return <CreateAgentPageClient initialTemplate={initialTemplate} />;
}
