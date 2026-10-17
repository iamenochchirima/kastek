import { redirect } from "@/lib/navigation";
import { getSession } from "@/lib/session";
import { PlannedFeature } from "@/components/platform/overview";
import { StudioAgentCreationPage } from "@/components/dashboard/studio/studio-agent-creation-page";

export const metadata = { title: "Create agent | KasiTek" };

export default async function CreateAgentPage({ searchParams }: { searchParams: Promise<{ template?: string; draft?: string }> }) {
  const { template, draft } = await searchParams;
  if (draft) redirect(`/app/agents/${encodeURIComponent(draft)}?section=configuration`);
  if (template) return <PlannedFeature title="Agent templates" description="Templates are not available yet. You can create a support assistant with your own instructions." action={{ href: "/app/agents/new", label: "Create support assistant" }} />;
  const session = await getSession();
  if (!session?.user?.id) redirect("/login");
  return <StudioAgentCreationPage />;
}
