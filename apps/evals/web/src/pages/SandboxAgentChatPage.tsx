import { useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, MessageSquare, Plus, Send } from "lucide-react";
import type { ProductAgent, ProductChatMessage, ProductChatResult } from "../../../shared/types";
import { api, errorMessage } from "../api";
import { EmptyState, ErrorBox, Loading, PageHeader, StatusBadge } from "../components";

export default function SandboxAgentChatPage() {
  const { id = "", agentRefId = "" } = useParams();
  const [search, setSearch] = useSearchParams();
  const sessionId = search.get("session") ?? undefined;
  const [agent, setAgent] = useState<ProductAgent | null>(null);
  const [messages, setMessages] = useState<ProductChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const thread = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api<{ agents: ProductAgent[] }>(`/api/sandboxes/${encodeURIComponent(id)}/product-agents`)
      .then((value) => {
        if (cancelled) return;
        const found = value.agents.find((item) => item.refId === agentRefId);
        if (!found) throw new Error("Agent not found in this sandbox");
        setAgent(found);
      })
      .catch((value) => { if (!cancelled) setError(errorMessage(value)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id, agentRefId]);

  useEffect(() => {
    if (!sessionId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    setError(null);
    api<{ messages: ProductChatMessage[] }>(
      `/api/sandboxes/${encodeURIComponent(id)}/sessions/${encodeURIComponent(sessionId)}/messages`,
    )
      .then((value) => { if (!cancelled) setMessages(value.messages); })
      .catch((value) => { if (!cancelled) setError(errorMessage(value)); });
    return () => { cancelled = true; };
  }, [id, sessionId]);

  useEffect(() => {
    const element = thread.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages, sending]);

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text || sending || !agent) return;
    setSending(true);
    setError(null);
    setInput("");
    try {
      const result = await api<ProductChatResult>(`/api/sandboxes/${encodeURIComponent(id)}/chat`, {
        method: "POST",
        body: JSON.stringify({
          agentRefId,
          message: text,
          ...(sessionId ? { sessionId } : {}),
        }),
      });
      setMessages(result.messages);
      if (!sessionId) setSearch({ session: result.session.id }, { replace: true });
    } catch (value) {
      setInput(text);
      setError(errorMessage(value));
    } finally {
      setSending(false);
    }
  }

  if (loading) return <Loading label="Loading agent" />;
  if (error && !agent) return <ErrorBox message={error} />;
  if (!agent) return <ErrorBox message="Agent not found in this sandbox" />;

  return (
    <>
      <PageHeader
        eyebrow={agent.product === "growth" ? "Growth agent" : "Agents agent"}
        title={agent.name}
        description={agent.model?.label ?? "Workspace default model"}
        actions={
          <>
            <Link className="button ghost" to={`/sandboxes/${id}`}><ArrowLeft size={15} /> Sandbox</Link>
            <Link className="button ghost" to={`/sandboxes/${id}/chat/${agentRefId}`}><Plus size={15} /> New chat</Link>
          </>
        }
      />
      <section className="panel chat-panel">
        <div className="panel-head">
          <div>
            <h2>Conversation</h2>
            <p className="muted">
              {agent.ready ? "Ready" : "Draft"}
              {agent.revision ? ` · revision ${agent.revision}` : ""}
            </p>
          </div>
          <StatusBadge status={agent.ready ? "ready" : "draft"} />
        </div>
        {!agent.ready && (
          <ErrorBox message="This agent is still a draft. Publish it in the product before starting a conversation." />
        )}
        {error && <ErrorBox message={error} />}
        <div className="chat-thread" ref={thread}>
          {messages.length === 0 ? (
            <div className="chat-empty">
              <MessageSquare size={22} />
              <div className="muted">Start a conversation with {agent.name}.</div>
            </div>
          ) : messages.map((message) => (
            <div className={`message ${message.role}`} key={message.id}>
              {message.text}
            </div>
          ))}
          {sending && <div className="message assistant pending">Working…</div>}
        </div>
        <form className="chat-form" onSubmit={send}>
          <textarea
            className="textarea grow"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={`Message ${agent.name}`}
            disabled={sending || !agent.ready}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <button className="button" type="submit" disabled={sending || !agent.ready || !input.trim()}>
            <Send size={15} /> Send
          </button>
        </form>
      </section>
    </>
  );
}
