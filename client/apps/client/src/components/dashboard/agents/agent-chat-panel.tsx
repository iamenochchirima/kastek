"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Activity, Bot, LoaderCircle, MessageSquare, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  cancelAgentRun,
  clearPlatformConversations,
  createNewPlatformConversation,
  getAgentRun,
  getAgentModelCatalog,
  getPlatformConversation,
  resolvePlatformConversation,
  sendPlatformMessage,
  streamAgentRun,
  updateKasiAiConversation,
  type AgentModel,
  type AgentModelCatalog,
  type AgentModelProvider,
  type AgentConversation,
  type AgentMessage,
} from "@/lib/agent-platform";
import { AgentChatComposer } from "./agent-chat-composer";
import { AgentMessageMedia, agentMessageHasMedia } from "./agent-message-media";
import { AgentAuthorizationAction } from "./agent-authorization-action";

const testChatActiveRunStatuses = new Set(["received", "queued", "running", "awaiting_approval", "awaiting_human", "awaiting_external_event"]);
const testChatTerminalRunStatuses = new Set(["completed", "failed", "cancelled", "expired"]);

function testChatRunProgress(status: string) {
  if (status === "awaiting_approval") return "Waiting for approval…";
  if (status === "awaiting_human") return "Waiting for a workspace member…";
  if (status === "awaiting_external_event") return "Waiting for an external event…";
  if (status === "queued" || status === "received") return "Run accepted; waiting to start…";
  if (status === "completed") return "Run completed";
  if (status === "failed") return "Run failed";
  if (status === "cancelled") return "Run cancelled";
  if (status === "expired") return "Run expired";
  return "Agent is working…";
}

function testChatRunEventLabel(event: string, data: Record<string, unknown>) {
  const name = typeof data.name === "string" ? data.name : "";
  if (event.includes("tool")) return name ? `Tool: ${name}` : "Tool activity";
  if (event.includes("model")) return "Model response";
  if (event.includes("context")) return "Context prepared";
  if (event.includes("approval")) return "Approval required";
  if (event.includes("failed")) return "Run failed";
  if (event.includes("completed")) return "Run completed";
  return event.replace(/^agent\./, "");
}

async function waitForTestChatRunTerminal(runId: string, signal: AbortSignal) {
  for (let attempt = 0; attempt < 75; attempt += 1) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const result = await getAgentRun(runId);
      if (testChatTerminalRunStatuses.has(result.run.status)) return result;
    } catch {
      // Keep polling. The durable run remains authoritative when a status request briefly fails.
    }
    await new Promise<void>((resolve, reject) => {
      const abort = () => { window.clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
      const timer = window.setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 800);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  return null;
}

export function AgentChatPanel({ installationId, active, agentName, modal = false, initialModelProvider, initialModel }: { installationId: string; active: boolean; agentName?: string; modal?: boolean; initialModelProvider?: AgentModelProvider; initialModel?: string }) {
  const [conversation, setConversation] = useState<AgentConversation | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [clearConfirmation, setClearConfirmation] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [lastRunId, setLastRunId] = useState<string | null>(null);
  const [runProgress, setRunProgress] = useState("Preparing request…");
  const [runEvents, setRunEvents] = useState<Array<{ event: string; label: string }>>([]);
  const [modelCatalog, setModelCatalog] = useState<AgentModelCatalog | null>(null);
  const [modelCatalogLoading, setModelCatalogLoading] = useState(false);
  const [selectedModelProvider, setSelectedModelProvider] = useState<AgentModelProvider | null>(initialModelProvider ?? null);
  const [selectedModel, setSelectedModel] = useState(initialModel ?? "");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const streamAbort = useRef<AbortController | null>(null);
  const sendLocked = useRef(false);
  const watchedRun = useRef<string | null>(null);

  const watchRun = useCallback(async (runId: string, controller: AbortController) => {
    setActiveRunId(runId);
    setLastRunId(runId);
    setSending(true);
    setRunProgress("Run accepted; building context…");
    let terminal = false;
    let cursor = 0;
    for (let attempt = 0; attempt < 3 && !terminal; attempt += 1) {
      try {
        const streamed = await streamAgentRun(runId, (event) => {
          const sequence = Number(event.data.sequence_number);
          if (Number.isSafeInteger(sequence)) cursor = Math.max(cursor, sequence);
          const label = testChatRunEventLabel(event.event, event.data);
          setRunEvents((current) => [...current.filter((entry) => entry.event !== event.event || entry.label !== label), { event: event.event, label }].slice(-5));
          if (event.event.includes("tool")) setRunProgress(typeof event.data.name === "string" ? `Tool activity: ${event.data.name}` : "Tool activity in progress…");
          else if (event.event.includes("model")) setRunProgress("Model response in progress…");
          else if (event.event.includes("context")) setRunProgress("Context prepared; starting model…");
          else if (event.event.includes("approval")) setRunProgress("Waiting for approval…");
          else if (event.event.includes("failed")) setRunProgress("Run failed");
          else if (event.event.includes("completed")) setRunProgress("Run completed");
        }, controller.signal, cursor);
        cursor = streamed.lastSequence;
        terminal = streamed.terminal;
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") throw cause;
        setRunProgress("Live updates interrupted; checking the durable run…");
        break;
      }
    }
    const result = terminal ? await getAgentRun(runId) : await waitForTestChatRunTerminal(runId, controller.signal);
    if (!result) {
      setRunProgress("Run is still processing; refresh to check its latest status.");
      return null;
    }
    setRunProgress(testChatRunProgress(result.run.status));
    setRunEvents((current) => [...current.filter((entry) => entry.event !== `run.${result.run.status}`), { event: `run.${result.run.status}`, label: testChatRunProgress(result.run.status) }].slice(-5));
    if (result.run.status !== "completed") throw new Error(result.run.error?.message || `Run ${result.run.status.replaceAll("_", " ")}`);
    return result;
  }, []);

  const refresh = useCallback(async (conversationId?: string) => {
    const response = conversationId ? await getPlatformConversation(conversationId) : await resolvePlatformConversation(installationId);
    setConversation(response.conversation);
    if (response.conversation.model_provider && response.conversation.model) {
      setSelectedModelProvider(response.conversation.model_provider as AgentModelProvider);
      setSelectedModel(response.conversation.model);
    }
    setMessages([...response.messages].sort((left, right) => Number(left.sequence_number) - Number(right.sequence_number)));
    const activeRun = response.activeRuns?.find((run) => testChatActiveRunStatuses.has(run.status));
    if (activeRun && watchedRun.current !== activeRun.id) {
      watchedRun.current = activeRun.id;
      const controller = new AbortController();
      streamAbort.current = controller;
      setActiveRunId(activeRun.id);
      setLastRunId(activeRun.id);
      setSending(true);
      setRunProgress(testChatRunProgress(activeRun.status));
      void watchRun(activeRun.id, controller).then(() => getPlatformConversation(response.conversation.id)).then((latest) => {
        setConversation(latest.conversation);
        setMessages([...latest.messages].sort((left, right) => Number(left.sequence_number) - Number(right.sequence_number)));
      }).catch((cause) => {
        if (!(cause instanceof DOMException && cause.name === "AbortError")) setError(cause instanceof Error ? cause.message : "Agent test failed");
      }).finally(() => {
        if (watchedRun.current === activeRun.id) watchedRun.current = null;
      });
    }
  }, [installationId, watchRun]);

  useEffect(() => {
    if (!active) {
      setLoading(false);
      return;
    }
    void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : "Unable to open test chat")).finally(() => setLoading(false));
  }, [active, refresh]);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setModelCatalogLoading(true);
    void getAgentModelCatalog()
      .then((catalog) => {
        if (cancelled) return;
        setModelCatalog(catalog);
        const fallback = catalog.models.find((item) => item.isWorkspaceDefault) ?? catalog.models[0];
        if (fallback) {
          setSelectedModelProvider((current) => current ?? fallback.provider);
          setSelectedModel((current) => current || fallback.model);
        }
      })
      .catch(() => {
        if (!cancelled) setModelCatalog(null);
      })
      .finally(() => {
        if (!cancelled) setModelCatalogLoading(false);
      });
    return () => { cancelled = true; };
  }, [active]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [messages, sending]);

  useEffect(() => () => {
    streamAbort.current?.abort();
    streamAbort.current = null;
    watchedRun.current = null;
  }, []);

  const pickerModels = useMemo<AgentModel[]>(() => {
    const models = modelCatalog?.models ?? [];
    if (!selectedModel || !selectedModelProvider || models.some((item) => item.provider === selectedModelProvider && item.model === selectedModel)) return models;
    return [{ provider: selectedModelProvider, model: selectedModel, label: selectedModel, description: "Saved model is not in the current catalog.", tier: "balanced" }, ...models];
  }, [modelCatalog, selectedModel, selectedModelProvider]);

  const selectedModelEntry = pickerModels.find((item) => item.provider === selectedModelProvider && item.model === selectedModel);

  const changeModel = async (value: string, provider: AgentModelProvider) => {
    const previousModel = selectedModel;
    const previousProvider = selectedModelProvider;
    setSelectedModel(value);
    setSelectedModelProvider(provider);
    setError(null);
    if (!conversation) return;
    try {
      const updated = await updateKasiAiConversation(conversation.id, { modelProvider: provider, model: value });
      setConversation(updated);
    } catch (cause) {
      setSelectedModel(previousModel);
      setSelectedModelProvider(previousProvider);
      setError(cause instanceof Error ? cause.message : "Unable to change this chat's model");
    }
  };

  const send = async () => {
    const message = draft.trim();
    if (!message || sending || !active || !conversation || sendLocked.current) return;
    sendLocked.current = true;
    const optimisticId = `optimistic-${crypto.randomUUID()}`;
    const optimistic: AgentMessage = { id: optimisticId, conversation_id: conversation.id, direction: "inbound", message_type: "text", content: { text: message }, sequence_number: Number.MAX_SAFE_INTEGER, created_at: new Date().toISOString() };
    setDraft("");
    setSending(true);
    setError(null);
    setLastRunId(null);
    setRunProgress("Sending message…");
    setRunEvents([]);
    setMessages((current) => [...current, optimistic]);
    let acceptedRunId: string | null = null;
    try {
      let targetConversation = conversation;
      if (selectedModelProvider && selectedModel.trim() && (conversation.model_provider !== selectedModelProvider || conversation.model !== selectedModel.trim())) {
        targetConversation = await updateKasiAiConversation(conversation.id, { modelProvider: selectedModelProvider, model: selectedModel.trim() });
        setConversation(targetConversation);
      }
      const accepted = await sendPlatformMessage(installationId, { message, idempotencyKey: crypto.randomUUID(), conversationId: targetConversation.id, context: { route: window.location.pathname, pageTitle: document.title } });
      acceptedRunId = accepted.runId;
      setMessages((current) => [...current.filter((entry) => entry.id !== optimisticId), accepted.message]);
      setConversation(accepted.conversation);
      setLastRunId(accepted.runId);
      setRunEvents([{ event: "run.received", label: "Run accepted" }]);
      const controller = new AbortController();
      streamAbort.current = controller;
      watchedRun.current = accepted.runId;
      await watchRun(accepted.runId, controller);
      await refresh(accepted.conversation.id);
    } catch (cause) {
      if (!(cause instanceof DOMException && cause.name === "AbortError")) {
        setMessages((current) => acceptedRunId ? current : current.filter((entry) => entry.id !== optimisticId));
        setDraft(message);
        setError(cause instanceof Error ? cause.message : "Agent test failed");
        if (acceptedRunId) setRunProgress("Run failed");
      }
    } finally {
      sendLocked.current = false;
      streamAbort.current = null;
      watchedRun.current = null;
      setActiveRunId(null);
      setSending(false);
    }
  };

  const startNewChat = async () => {
    if (!active || sending || loading) return;
    setLoading(true);
    setError(null);
    setLastRunId(null);
    setRunEvents([]);
    try {
      const response = await createNewPlatformConversation(installationId);
      setConversation(response.conversation);
      setMessages([...response.messages].sort((left, right) => Number(left.sequence_number) - Number(right.sequence_number)));
      setDraft("");
      setRunProgress("Ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to start a new test chat");
    } finally {
      setLoading(false);
    }
  };

  const clearChats = async () => {
    if (!active || sending || loading || clearing) return;
    setClearConfirmation(false);
    setClearing(true);
    setLoading(true);
    setError(null);
    setLastRunId(null);
    setRunEvents([]);
    try {
      const response = await clearPlatformConversations(installationId);
      setConversation(response.conversation);
      setMessages([...response.messages].sort((left, right) => Number(left.sequence_number) - Number(right.sequence_number)));
      setDraft("");
      setRunProgress("Ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to clear test chats");
    } finally {
      setClearing(false);
      setLoading(false);
    }
  };

  const stop = async () => {
    if (!activeRunId) return;
    setRunProgress("Cancellation requested…");
    await cancelAgentRun(activeRunId).catch(() => undefined);
    streamAbort.current?.abort();
    setActiveRunId(null);
    setSending(false);
  };

  return <Card className="relative h-full min-h-0 overflow-hidden border-border/80 shadow-sm">
    <div className="flex h-full min-h-0 flex-col">
      <header className={`flex shrink-0 flex-col gap-3 border-b border-border bg-card px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6 ${modal ? "pr-12" : ""}`}>
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary"><Bot className="h-5 w-5" /></div>
          <div><h2 className="text-lg font-semibold text-foreground">{agentName ? `${agentName} chat` : "Test chat"}</h2><p className="mt-0.5 text-sm text-muted-foreground">Try a conversation with this agent.</p></div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <Badge className={`gap-1.5 ${active ? "border-status-success/30 bg-status-success-soft text-status-success" : "border-status-attention/30 bg-status-attention-soft text-status-attention"}`}><span className={`h-1.5 w-1.5 rounded-full ${active ? "bg-status-success" : "bg-status-attention"}`} />{active ? "Ready" : "Paused"}</Badge>
          {conversation ? <span className="hidden text-muted-foreground sm:inline">Conversation saved</span> : null}
          <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5" disabled={!active || loading || sending || clearing} onClick={() => setClearConfirmation(true)}><Trash2 className="h-3.5 w-3.5" />Clear chats</Button>
          <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5" disabled={!active || loading || sending || clearing} onClick={() => void startNewChat()}><Plus className="h-3.5 w-3.5" />New chat</Button>
        </div>
      </header>

      {!active ? <div className="border-b border-border bg-status-attention-soft px-5 py-3 text-sm text-status-attention sm:px-6">Resume this installation to start testing.</div> : null}

      <div className="min-h-0 flex-1 overflow-y-auto bg-secondary/10 px-4 py-6 sm:px-6" aria-live="polite">
        <div className="mx-auto flex min-h-full max-w-3xl flex-col justify-end gap-5">
          {loading ? <div className="flex min-h-[300px] items-center justify-center"><p className="text-sm text-muted-foreground">Loading conversation…</p></div> : messages.length ? <>
            {messages.map((message) => {
              const isUser = message.direction === "inbound";
              const isSystem = message.direction === "system";
              const text = typeof message.content?.text === "string" ? message.content.text : "";
              return <div key={message.id} className={`flex ${isSystem ? "justify-center" : isUser ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[88%] rounded-2xl px-4 py-3 text-sm leading-6 shadow-sm sm:max-w-[78%] ${isSystem ? "rounded-lg border border-border bg-card text-muted-foreground" : isUser ? "rounded-br-md bg-primary text-primary-foreground" : "rounded-bl-md border border-border bg-card text-foreground"}`}>
                  <div className={`mb-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${isSystem ? "text-muted-foreground" : isUser ? "text-primary-foreground/70" : "text-muted-foreground"}`}>{isSystem ? "System" : isUser ? "You" : "Agent"}</div>
                  <AgentMessageMedia message={message} />
                  {text ? <p className="whitespace-pre-wrap">{text}</p> : !agentMessageHasMedia(message) ? <p className="whitespace-pre-wrap">(No text content)</p> : null}
                  <AgentAuthorizationAction message={message} />
                  <p className={`mt-1 text-[10px] ${isUser ? "text-primary-foreground/60" : "text-muted-foreground"}`}>{new Date(message.created_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</p>
                </div>
              </div>;
            })}
            {(sending || lastRunId) ? <div className="rounded-xl border border-border bg-card px-4 py-3 text-xs shadow-sm"><div className="flex items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-2 text-muted-foreground"><Activity className="h-3.5 w-3.5 shrink-0 text-primary" /><span className="truncate">{runProgress}</span>{sending ? <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" /> : null}</div>{lastRunId ? <Link href={`/agents/activity/${encodeURIComponent(lastRunId)}`} className="shrink-0 font-medium text-primary hover:underline">View activity</Link> : null}</div>{runEvents.length ? <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Run activity">{runEvents.map((entry, index) => <span key={`${entry.event}-${index}`} className={`rounded-full px-2 py-0.5 text-[10px] ${entry.event.includes("failed") ? "bg-destructive/10 text-destructive" : entry.event.includes("approval") ? "bg-status-attention-soft text-status-attention" : "bg-secondary text-muted-foreground"}`}>{entry.label}</span>)}</div> : null}</div> : null}
          </> : <div className="flex min-h-[300px] flex-col items-center justify-center text-center"><div className="grid h-14 w-14 place-items-center rounded-2xl bg-primary/10 text-primary"><MessageSquare className="h-6 w-6" /></div><h3 className="mt-4 text-base font-semibold text-foreground">Start a conversation</h3><p className="mt-1 max-w-sm text-sm leading-6 text-muted-foreground">Send a message below to see how this agent responds.</p></div>}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {error ? <div className="shrink-0 border-t border-destructive/20 bg-destructive/10 px-5 py-3 text-sm text-destructive" role="alert">{error}</div> : null}
      <AgentChatComposer
        value={draft}
        onChange={setDraft}
        onSubmit={() => void send()}
        model={selectedModelEntry}
        models={pickerModels}
        onModelChange={(value, provider) => void changeModel(value, provider)}
        modelDisabled={modelCatalogLoading || !pickerModels.length}
        disabled={!active || loading || !conversation}
        sending={sending}
        onStop={() => void stop()}
        placeholder="Message this agent…"
        className="bg-card p-4 sm:p-5"
        ariaLabel="Message this agent"
      />
      <Dialog open={clearConfirmation} onOpenChange={setClearConfirmation}><DialogContent className="max-w-md"><DialogHeader><div className="flex h-11 w-11 items-center justify-center rounded-full bg-destructive/10 text-destructive"><Trash2 className="h-5 w-5" aria-hidden="true" /></div><DialogTitle>Clear test chats?</DialogTitle><DialogDescription>This clears this agent’s private chats and starts a new one. Customer and inbox conversations are not affected.</DialogDescription></DialogHeader><DialogFooter><Button type="button" variant="outline" onClick={() => setClearConfirmation(false)}>Cancel</Button><Button type="button" variant="destructive" onClick={() => void clearChats()}>Clear chats</Button></DialogFooter></DialogContent></Dialog>
    </div>
  </Card>;
}
