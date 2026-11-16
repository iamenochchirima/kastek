import { redirect } from "react-router";
import { getWorkspaceSession } from "@/lib/core-auth";
import { GrowthAgentPage } from "@/components/dashboard/agents/agent-page";

export function meta() { return [{ title: "Agent | KasiTek" }, { name: "robots", content: "noindex, nofollow" }]; }
export async function clientLoader({ request }: { request: Request }) {
  if (!await getWorkspaceSession(request)) throw redirect("/login");
  return {};
}

export default function AgentPage() {
  return <GrowthAgentPage />;
}
