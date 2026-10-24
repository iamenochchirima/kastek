import { Link } from "react-router";
import { useEffect } from "react";
import { ArrowLeft } from "lucide-react";
import { useGrowthAgents } from "./agent-provider";
import { AgentConversation } from "./agent-conversation";

export function GrowthConversationPage({ conversationId, taskId }: { conversationId: string; taskId?: string }) {
  const { openConversation } = useGrowthAgents();
  useEffect(() => { void openConversation(conversationId, false, taskId); }, [conversationId, taskId, openConversation]);
  return <div className="flex h-[calc(100dvh-4rem)] min-h-0 flex-col"><div className="shrink-0 border-b border-border px-4 py-2"><Link to="/agents" className="inline-flex min-h-8 items-center gap-2 text-xs text-muted-foreground hover:text-foreground"><ArrowLeft className="size-3.5" />Agents</Link></div><div className="min-h-0 flex-1"><AgentConversation expanded /></div></div>;
}
