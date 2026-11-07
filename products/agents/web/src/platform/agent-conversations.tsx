import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PiChatCircle as Chat, PiClockCounterClockwise as History, PiPlus as Plus } from "react-icons/pi";
import { Button } from "@/components/ui/button";
import { api, message, organizationPath, type ConversationSummary, type Page } from "./api";
import { ErrorMessage, Loading } from "./shell";

const stateLabels: Record<string, string> = { automation_active: "Active", handoff_pending: "Needs a person", human_owned: "With support", resolved: "Resolved" };
const timeLabel = (date: string) => new Date(date).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export function AgentConversations({ organizationId, agentId, onNewChat }: { organizationId: string; agentId: string; onNewChat: () => void }) {
  const path = `${organizationPath(organizationId)}/conversations?agentId=${encodeURIComponent(agentId)}`;
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null), [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true; setConversations(null); setCursor(null); setError("");
    api<Page<"conversations", ConversationSummary>>(path)
      .then(result => { if (live) { setConversations(result.conversations); setCursor(result.nextCursor); } })
      .catch(reason => { if (live) setError(message(reason)); });
    return () => { live = false; };
  }, [path]);
  async function more() {
    if (!cursor || busy) return;
    setBusy(true);
    try {
      const result = await api<Page<"conversations", ConversationSummary>>(`${path}&cursor=${encodeURIComponent(cursor)}`);
      setConversations(current => [...(current ?? []), ...result.conversations]); setCursor(result.nextCursor);
    } catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  }
  return <section className="agent-section agent-conversations-page">
    <header className="agent-section-heading"><div><h1>Conversations</h1><p>Customer chats handled by this agent.</p></div><Button size="sm" onClick={onNewChat}><Plus size={15} />New chat</Button></header>
    <ErrorMessage value={error} />
    {!conversations && !error ? <Loading /> : null}
    {conversations?.length ? <div className="agent-conversation-list">{conversations.map(conversation => <Link key={conversation.id} className="agent-conversation-row" to={`/app/agents/${agentId}/conversations/${conversation.id}`}>
      <span className="agent-conversation-icon"><Chat size={17} /></span>
      <span className="agent-conversation-main"><span className="agent-conversation-title">{conversation.title || "Untitled conversation"}</span><span className="agent-conversation-meta">{timeLabel(conversation.updatedAt)}</span></span>
      <span className="agent-conversation-state" data-state={conversation.state}>{stateLabels[conversation.state] ?? conversation.state}</span>
    </Link>)}</div> : conversations?.length === 0 ? <div className="agent-section-empty"><span><History size={22} /></span><p>No conversations yet</p><Button size="sm" variant="outline" onClick={onNewChat}>Start a chat</Button></div> : null}
    {cursor ? <Button variant="outline" size="sm" disabled={busy} onClick={() => void more()}>{busy ? "Loading…" : "Load older conversations"}</Button> : null}
  </section>;
}
