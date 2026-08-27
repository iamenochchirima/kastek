import { getRustSession } from "@/lib/rust-auth";
import { redirect } from "next/navigation";
import { AgentCreationFlowPageClient } from "@/components/dashboard/agents/agent-creation-flow-page-client";

export const metadata = { title: "Create general-purpose agent | KasiTek" };

export default async function CreateGeneralAgentPage({
  searchParams,
}: {
  searchParams: Promise<{ audience?: string }>;
}) {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");
  const { audience } = await searchParams;
  return <AgentCreationFlowPageClient initialAudience={audience === "customer_service" ? "customer_service" : "personal"} initialMode="general" userId={session.user.id} />;
}
