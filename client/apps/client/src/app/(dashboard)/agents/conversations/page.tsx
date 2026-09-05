import { redirect } from "next/navigation";
import { getRustSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";
import type { AgentConversation, AgentConversationSummary, AgentHandoffPriority, AgentHandoffQueue, AgentHandoffReason } from "@/lib/agent-platform";
import { AgentConversationsPageClient } from "@/components/dashboard/agents/agent-conversations-page-client";

export const metadata = { title: "Live Chat | KasiTek" };

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
  inbox: "pending",
  mine: "claimed",
  team: "claimed",
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
  const view = query.view === "handoff" ? "inbox" : query.view === "human" ? "mine" : query.view === "inbox" || query.view === "mine" || query.view === "team" || query.view === "live" ? query.view : "all";
  const reason = handoffReasons.includes(query.reason as AgentHandoffReason) ? query.reason as AgentHandoffReason : undefined;
  const priority = handoffPriorities.includes(query.priority as AgentHandoffPriority) ? query.priority as AgentHandoffPriority : undefined;
  const params = new URLSearchParams({ status: viewStatuses[view] ?? "pending", limit: "100" });
  if (view === "mine" || view === "team") params.set("assignment", view);
  if (query.agentId) params.set("agentId", query.agentId);
  if (query.installationId) params.set("installationId", query.installationId);
  if (query.search) params.set("search", query.search);
  if (query.channelType) params.set("channelType", query.channelType);
  if (reason) params.set("reason", reason);
  if (priority) params.set("priority", priority);
  const customerParams = new URLSearchParams({ limit: "100" });
  if (query.agentId) customerParams.set("agentId", query.agentId);
  if (query.installationId) customerParams.set("installationId", query.installationId);
  if (query.search) customerParams.set("search", query.search);
  if (query.channelType) customerParams.set("channelType", query.channelType === "messenger" ? "facebook" : query.channelType);
  const summaryParams = new URLSearchParams();
  if (query.agentId) summaryParams.set("agentId", query.agentId);
  if (query.installationId) summaryParams.set("installationId", query.installationId);
  if (query.search) summaryParams.set("search", query.search);
  if (query.channelType) summaryParams.set("channelType", query.channelType === "messenger" ? "facebook" : query.channelType);
  const initialCustomerConversations = view === "all"
    ? await fetchRustJson<{ items: AgentConversation[] }>(
      `/api/agents/conversations/customer?${customerParams.toString()}`,
    ).catch((): { items: AgentConversation[] } => ({ items: [] }))
    : { items: [] };
  const initialQueue = view === "all"
    ? { items: [], nextBefore: null } as AgentHandoffQueue
    : await fetchRustJson<AgentHandoffQueue>(
      `/api/agents/conversations/handoffs?${params.toString()}`,
    ).catch((): AgentHandoffQueue => ({ items: [], nextBefore: null }));
  const initialSummary = await fetchRustJson<AgentConversationSummary>(
    `/api/agents/conversations/summary${summaryParams.toString() ? `?${summaryParams.toString()}` : ""}`,
  ).catch((): AgentConversationSummary => ({ all: 0, live: 0, inbox: 0, mine: 0, team: 0 }));

  return <AgentConversationsPageClient initialQueue={initialQueue} initialCustomerConversations={initialCustomerConversations.items} initialSummary={initialSummary} initialFilters={{ view, agentId: query.agentId, installationId: query.installationId, search: query.search, channelType: query.channelType, reason, priority }} />;
}
