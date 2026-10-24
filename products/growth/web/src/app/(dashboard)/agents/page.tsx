import { redirect } from "react-router";
import { getWorkspaceSession } from "@/lib/core-auth";
import { AgentsWorkspace } from "@/components/dashboard/agents/agent-workspace";

export function meta() { return [{ title: "Agents | KasiTek" }, { name: "robots", content: "noindex, nofollow" }]; }
export async function clientLoader() {
  if (!await getWorkspaceSession()) throw redirect("/login");
  return {  };
}

export default function AgentsPage() {
  return <AgentsWorkspace />;
}
