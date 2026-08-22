import { redirect } from "next/navigation";
import { getRustSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";
import type { AgentHandoffQueue } from "@/lib/agent-platform";
import { AgentConversationsPageClient } from "@/components/dashboard/agents/agent-conversations-page-client";

export const metadata = { title: "Agent Conversations | KasiTek" };

export default async function AgentConversationsPage() {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");
  const initialQueue = await fetchRustJson<AgentHandoffQueue>(
    "/api/agents/conversations/handoffs?status=pending,claimed&limit=100",
  ).catch((): AgentHandoffQueue => ({ items: [], nextBefore: null }));

  return <AgentConversationsPageClient initialQueue={initialQueue} />;
}
