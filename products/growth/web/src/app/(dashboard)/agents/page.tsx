import { redirect } from "next/navigation";
import { getWorkspaceSession } from "@/lib/core-auth";
import { AgentsWorkspace } from "@/components/dashboard/agents/agent-workspace";

export const metadata = { title: "Agents | KasiTek" };
export default async function AgentsPage() {
  if (!await getWorkspaceSession()) redirect("/login");
  return <AgentsWorkspace />;
}
