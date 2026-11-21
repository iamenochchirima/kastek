import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, ChevronDown, MessageSquare, Plus, RefreshCw, Send } from "lucide-react";
import type { AgentModelCatalogue, AgentRef, ProductActivity, ProductAgent, ProductChatMessage, ProductChatResult } from "../../../shared/types";
import { ActivityPanel } from "../ActivityPanel";
import { api, errorMessage } from "../api";
import { EmptyState, ErrorBox, Loading, ModelPickerDialog, PageHeader, providerName, StatusBadge } from "../components";

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
  const [restarting, setRestarting] = useState(false);
  const [restartError, setRestartError] = useState<string | null>(null);
  const [catalogue, setCatalogue] = useState<AgentModelCatalogue | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [savingModel, setSavingModel] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [activity, setActivity] = useState<ProductActivity | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  const thread = useRef<HTMLDivElement | null>(null);
  const activityPoll = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api<{ agents: ProductAgent[] }>(`/api/sandboxes/${encodeURIComponent(id)}/product-agents`)
      .then(async (value) => {
        if (cancelled) return;
        const found = value.agents.find((item) => item.refId === agentRefId);
        if (found) {
          setAgent(found);
          return;
        }
        const historical = await api<{ agentRef: AgentRef }>(
          `/api/sandboxes/${encodeURIComponent(id)}/agents/${encodeURIComponent(agentRefId)}`,
        );
        const current = value.agents.find((item) =>
          item.productAgentId === historical.agentRef.productAgentId);
        if (!current) throw new Error("Agent not found in this sandbox");
        setAgent({ ...current, refId: agentRefId });
      })
      .catch((value) => { if (!cancelled) setError(errorMessage(value)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [id, agentRefId]);

  useEffect(() => {
    if (!agent) {
      setCatalogue(null);
      setModelError(null);
      return;
    }
    let cancelled = false;
    setModelError(null);
    api<AgentModelCatalogue>(
      `/api/sandboxes/${encodeURIComponent(id)}/agents/${encodeURIComponent(agentRefId)}/models`,
    )
      .then((value) => { if (!cancelled) setCatalogue(value); })
      .catch((value) => { if (!cancelled) setModelError(errorMessage(value)); });
    return () => { cancelled = true; };
  }, [id, agentRefId, agent?.productAgentId]);

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

  const loadActivity = useCallback(async (taskId?: string) => {
    try {
      const suffix = taskId ? `?taskId=${encodeURIComponent(taskId)}` : "";
      const result = await api<ProductActivity>(
        `/api/sandboxes/${encodeURIComponent(id)}/agents/${encodeURIComponent(agentRefId)}/activity${suffix}`,
      );
      setActivity(result);
      setActivityError(null);
    } catch (value) {
      setActivityError(errorMessage(value));
    }
  }, [id, agentRefId]);

  useEffect(() => {
    if (!sessionId) {
      setActivity(null);
      setActivityError(null);
      return;
    }
    let cancelled = false;
    api<{ session: { latestTaskId: string } }>(
      `/api/sandboxes/${encodeURIComponent(id)}/sessions/${encodeURIComponent(sessionId)}`,
    )
      .then((detail) => {
        if (!cancelled) void loadActivity(detail.session.latestTaskId);
      })
      .catch((value) => {
        if (!cancelled) setActivityError(errorMessage(value));
      });
    return () => { cancelled = true; };
  }, [id, sessionId, loadActivity]);

  useEffect(() => () => {
    if (activityPoll.current) clearInterval(activityPoll.current);
  }, []);

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
    setActivityError(null);
    if (activityPoll.current) clearInterval(activityPoll.current);
    void loadActivity();
    activityPoll.current = setInterval(() => { void loadActivity(); }, 1000);
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
      await loadActivity(result.turn.productTaskId);
    } catch (value) {
      setInput(text);
      setError(errorMessage(value));
    } finally {
      if (activityPoll.current) {
        clearInterval(activityPoll.current);
        activityPoll.current = null;
      }
      setSending(false);
    }
  }

  async function changeModel(value: string) {
    if (!catalogue || savingModel) return;
    setSavingModel(true);
    setModelError(null);
    try {
      const selection = value === "organization_default"
        ? { kind: "organization_default" as const }
        : (() => {
            const [connectionId, modelId] = JSON.parse(value) as [string, string];
            return { kind: "connection" as const, connectionId, modelId };
          })();
      await api(`/api/sandboxes/${encodeURIComponent(id)}/agents/${encodeURIComponent(agentRefId)}/model`, {
        method: "POST",
        body: JSON.stringify(selection),
      });
      const refreshed = await api<AgentModelCatalogue>(
        `/api/sandboxes/${encodeURIComponent(id)}/agents/${encodeURIComponent(agentRefId)}/models`,
      );
      setCatalogue(refreshed);
      const selected = refreshed.current
        ? refreshed.models.find((model) =>
            model.connectionId === refreshed.current!.connectionId && model.modelId === refreshed.current!.modelId)
        : refreshed.defaultModel;
      if (selected) {
        setAgent((current) => current ? {
          ...current,
          model: { label: selected.label, provider: selected.provider, modelId: selected.modelId },
          revision: String(refreshed.revision),
        } : current);
      }
      setModelOpen(false);
    } catch (value) {
      setModelError(errorMessage(value));
    } finally {
      setSavingModel(false);
    }
  }

  async function restartRuntime() {
    if (restarting) return;
    setRestarting(true);
    setRestartError(null);
    try {
      await api(`/api/sandboxes/${encodeURIComponent(id)}/runtime/restart`, { method: "POST" });
      window.location.reload();
    } catch (value) {
      setRestartError(errorMessage(value));
    } finally {
      setRestarting(false);
    }
  }

  if (loading) return <Loading label="Loading agent" />;
  if (error && !agent) {
    return (
      <>
        <PageHeader
          eyebrow="Agent chat"
          title={agentRefId.slice(0, 8)}
          description={`Sandbox ${id.slice(0, 8)}`}
          actions={<Link className="button ghost" to={`/sandboxes/${id}`}><ArrowLeft size={15} /> Sandbox</Link>}
        />
        <section className="panel">
          <ErrorBox message={error} />
          {restartError && <ErrorBox message={restartError} />}
          <div className="button-row">
            <button className="button" onClick={restartRuntime} disabled={restarting}>
              <RefreshCw size={15} /> {restarting ? "Restarting…" : "Restart runtime"}
            </button>
          </div>
        </section>
      </>
    );
  }
  if (!agent) return <ErrorBox message="Agent not found in this sandbox" />;

  const selectedModel = catalogue?.current
    ? catalogue.models.find((model) =>
        model.connectionId === catalogue.current!.connectionId && model.modelId === catalogue.current!.modelId)
    : null;
  const activeModel = catalogue?.inherited ? catalogue?.defaultModel ?? null : selectedModel;
  const modelLabel = activeModel?.label
    ?? catalogue?.current?.modelId
    ?? agent.model?.label
    ?? "Workspace default model";

  return (
    <>
      <PageHeader
        eyebrow={agent.product === "growth" ? "Growth agent" : "Agents agent"}
        title={agent.name}
        description={modelLabel}
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
          <div className="chat-head-side">
            {catalogue && (
              <button
                type="button"
                className="button ghost model-trigger"
                onClick={() => { setModelOpen(true); setModelError(null); }}
                disabled={savingModel || sending}
                title="Choose model"
              >
                <span className="model-trigger-label">Model</span>
                <span className="model-trigger-value">{modelLabel}</span>
                {activeModel && <span className="model-trigger-provider">{providerName(activeModel.provider)}</span>}
                <ChevronDown size={14} />
              </button>
            )}
            <StatusBadge status={agent.ready ? "ready" : "draft"} />
          </div>
        </div>
        {!agent.ready && (
          <ErrorBox message="This agent is still a draft. Publish it in the product before starting a conversation." />
        )}
        {modelError && <ErrorBox message={modelError} />}
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
      <ActivityPanel activity={activity} error={activityError} live={sending} />
      {modelOpen && catalogue && (
        <ModelPickerDialog
          catalogue={catalogue}
          selected={
            catalogue.inherited
              ? "organization_default"
              : catalogue.current
                ? JSON.stringify([catalogue.current.connectionId, catalogue.current.modelId])
                : "organization_default"
          }
          saving={savingModel}
          error={modelError}
          onSave={(value) => void changeModel(value)}
          onClose={() => { if (!savingModel) setModelOpen(false); }}
        />
      )}
    </>
  );
}
