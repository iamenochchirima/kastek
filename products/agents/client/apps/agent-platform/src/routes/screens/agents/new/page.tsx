import { redirect } from "@/lib/navigation";
import { PlannedFeature } from "@/components/platform/overview";

export default async function CreateAgentPage({ searchParams }: { searchParams: Promise<{ template?: string; draft?: string }> }) {
  const { template, draft } = await searchParams;
  if (draft) redirect(`/app/studio?agent=${encodeURIComponent(draft)}`);
  if (template) return <PlannedFeature title="Agent templates" description="Template-based setup is not connected in this initial frontend. You can create a hosted agent with your own instructions in Studio." action={{ href: "/app/studio/new", label: "Create in Studio" }} />;
  redirect("/app/studio/new");
}
