import { redirect } from "next/navigation";
import { getRustSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";
import type { AgentHandoffPriority, AgentHandoffQueue, AgentHandoffReason } from "@/lib/agent-platform";
import { AgentConversationsPageClient } from "@/components/dashboard/agents/agent-conversations-page-client";

export const metadata = { title: "Agent Conversations | KasiTek" };

type ConversationQuery = {
  view?: string;
  agentId?: string;
  installationId?: string;
  search?: string;
  channelType?: string;
  reason?: string;
  priority?: string;
};

const viewStatuses: Record<string, string> = {
  handoff: "pending",
  human: "claimed",
  all: "pending,claimed,resolved,expired,cancelled",
};
const handoffReasons = ["customer_requested", "agent_uncertain", "policy_required", "high_value", "configured_workflow", "other"] as const;
const handoffPriorities = ["normal", "high", "urgent"] as const;

export default async function AgentConversationsPage({
  searchParams,
}: {
  searchParams: Promise<ConversationQuery>;
}) {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");
  const query = await searchParams;
  const view = query.view === "human" || query.view === "live" || query.view === "all" ? query.view : "handoff";
  const reason = handoffReasons.includes(query.reason as AgentHandoffReason) ? query.reason as AgentHandoffReason : undefined;
  const priority = handoffPriorities.includes(query.priority as AgentHandoffPriority) ? query.priority as AgentHandoffPriority : undefined;
  const params = new URLSearchParams({ status: viewStatuses[view] ?? "pending", limit: "100" });
  if (query.agentId) params.set("agentId", query.agentId);
  if (query.installationId) params.set("installationId", query.installationId);
  if (query.search) params.set("search", query.search);
  if (query.channelType) params.set("channelType", query.channelType);
  if (reason) params.set("reason", reason);
  if (priority) params.set("priority", priority);
  const initialQueue = await fetchRustJson<AgentHandoffQueue>(
    `/api/agents/conversations/handoffs?${params.toString()}`,
  ).catch((): AgentHandoffQueue => ({ items: [], nextBefore: null }));

  return <AgentConversationsPageClient initialQueue={initialQueue} initialFilters={{ view, agentId: query.agentId, installationId: query.installationId, search: query.search, channelType: query.channelType, reason, priority }} />;
}
