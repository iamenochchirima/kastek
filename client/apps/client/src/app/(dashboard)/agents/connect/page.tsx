import { redirect } from "next/navigation";
import { getRustSession } from "@/lib/rust-auth";
import { AgentConnectionWizard } from "@/components/dashboard/agents/agent-connection-wizard";

export const metadata = { title: "Connect external agent | KasiTek" };

export default async function AgentConnectPage() {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");
  return <AgentConnectionWizard />;
}
