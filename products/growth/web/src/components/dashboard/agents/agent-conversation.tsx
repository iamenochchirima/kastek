import { Link } from "react-router";
import { useNavigate } from "react-router";
import { AgentContextUsage, AgentMessage } from "@kasitek-labs/ui/agent";
import { AssistantChat, AssistantChatComposer, applyAssistantStreamEvent, type AssistantChatStream, type AssistantChatTurn, type AssistantMessage, type AssistantStreamEvent, type AssistantStreamState } from "@kasitek-labs/ui/assistant";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, LoaderCircle, Plus, MessageCircle as Bot, Send as ArrowUp, X } from "@/components/ui/interface-icons";
import "./agents-workspace.css";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirmationDialog } from "@/components/ui/confirmation-provider";
import { isActiveTask, type GrowthAgentSource, type GrowthAgentTask } from "@/lib/growth-agents";
import { AgentSources, GrowthAgentMarkdown } from "./agent-content";
export { AgentSources } from "./agent-content";
import { useGrowthAgents } from "./agent-provider";
import { ContextControl } from "./agent-context";
import { taskFailureLabel } from "./agent-progress";
import { growthExecution } from "@/lib/growth-agent-presentation";
import { useGrowthSubagent } from "./agent-subagent";
import { AgentDraftReview } from "./agent-review";
import { GrowthExecution } from "./agent-execution";
import { TaskResults } from "./agent-results";
import { GrowthAgentModelPicker } from "./agent-model-picker";

function growthStreamEvent(input: { reconnecting: boolean; liveStatus: string | null; error: string | null; task?: GrowthAgentTask }): AssistantStreamEvent | null {
  if (input.reconnecting) return { type: "status", state: "reconnecting" };
  if (input.liveStatus === "polling" && input.task) return { type: "status", state: "polling" };
  if (input.error) return { type: "failed", message: input.error };
  if (!input.task) return null;
  if (input.task.state === "completed") return { type: "completed", message: { id: input.task.id, role: "assistant", text: input.task.output ?? "" } };
  if (input.task.state === "uncertain") return { type: "uncertain", message: "Task outcome is unknown." };
  if (["failed", "refused", "incomplete", "cancelled"].includes(input.task.state)) return { type: "failed", message: input.task.errorCode ?? "Task did not complete." };
  return { type: "status", state: input.task.state };
}


export function AgentConversation({ expanded = false, onClose }: { expanded?: boolean; onClose?: () => void }) {
  const agents = useGrowthAgents();
  const navigate = useNavigate();
  const { confirm } = useConfirmationDialog();
  const composer = useRef<HTMLTextAreaElement | null>(null);
  const specialistResult = useGrowthSubagent(`${agents.scopeKey}:${agents.conversation?.id ?? ""}`, () => composer.current?.focus({ preventScroll: true }));
  const feature = agents.bootstrap?.features.find((item) => item.id === agents.conversation?.featureId);
  const running = agents.tasks.filter(isActiveTask);
  const task = running[0];
  const latest = [...agents.tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const canSteer = Boolean(task?.canSteer && task.state !== "cancel_requested");
  const blocked = agents.loading || agents.sending || agents.unconfirmed || Boolean(task && !canSteer) || !agents.conversation;
  const [streamState, setStreamState] = useState<AssistantStreamState>({ state: "idle" });
  useEffect(() => {
    const event = growthStreamEvent({ reconnecting: agents.reconnecting, liveStatus: agents.liveStatus, error: agents.error, task });
    if (event) setStreamState(current => applyAssistantStreamEvent(current, event));
  }, [agents.reconnecting, agents.liveStatus, agents.error, task, task?.id, task?.state, task?.output]);
  const stop = async () => {
    if (task && await confirm({ title: "Stop this task?", description: "Changes already saved will remain.", confirmLabel: "Stop task" })) await agents.cancel(task.id);
  };
  const pendingReviews = agents.reviews.filter((review) => !["expired", "rejected"].includes(review.state));
  const taskDetails = (item?: GrowthAgentTask) => item ? <section data-task-id={item.id} aria-label="Task details" className="mt-3 space-y-3">
    {item.errorCode === "EVIDENCE_UNAVAILABLE" ? <p role="status" className="text-xs text-muted-foreground">Sources unavailable</p> : null}
    <GrowthExecution task={{ ...item, output: !agents.messages.some(message => message.role === "assistant" && message.taskId === item.id) ? item.output : null }} onOpenSubagent={(child, button) => specialistResult.open(item.id, child, button)} renderOutput={text => <AgentMessage role="assistant"><GrowthAgentMarkdown text={text} sources={item.sources} /><AgentSources sources={item.sources ?? []} /></AgentMessage>} />
    {pendingReviews.filter(review => review.taskId === item.id).map(review => <AgentDraftReview key={review.id} review={review} />)}
    {item.results?.length ? <TaskResults key={item.results.map(result => result.artifactId ?? result.id).join(":")} task={item} /> : null}
    {["failed", "uncertain", "refused", "cancelled", "incomplete"].includes(item.state) && ((!item.errorCode && !item.boundary) || item.canContinue && !running.length) ? <div className="flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2">{!item.errorCode && !item.boundary ? <p className="min-w-0 flex-1 text-xs text-muted-foreground" role="status">{taskFailureLabel(item)}</p> : null}{item.canContinue && !running.length ? <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" disabled={agents.sending || agents.loading || agents.unconfirmed} onClick={() => void agents.continueTask(item.id)}>{agents.continuingTaskId === item.id ? <LoaderCircle className="mr-1.5 size-3 animate-spin" /> : null}Continue</Button> : null}</div> : null}
  </section> : null;
  const turns: AssistantChatTurn[] = [...agents.messages.reduce((groups, message) => {
    const id = message.taskId ?? message.id;
    const turn = groups.get(id) ?? { id, messages: [] as typeof agents.messages, task: agents.tasks.find(task => task.id === message.taskId) };
    turn.messages.push(message); groups.set(id, turn); return groups;
  }, new Map<string, { id: string; messages: typeof agents.messages; task: GrowthAgentTask | undefined }>()).values()].map(turn => ({
    id: turn.id,
    user: turn.messages.filter(message => message.role === "user").map(message => ({ id: message.id, role: "user" as const, text: message.text, createdAt: message.createdAt })),
    assistant: turn.messages.filter(message => message.role === "assistant").map(message => ({ id: message.id, role: "assistant" as const, text: message.text, createdAt: message.createdAt, sources: message.sources as unknown as AssistantMessage["sources"] })),
    details: taskDetails(turn.task),
  }));
  const earlierTurns = agents.tasks.filter(item => !agents.messages.some(message => message.taskId === item.id)).map(item => <section key={item.id} aria-label="Earlier task" className="space-y-3"><p className="text-xs text-muted-foreground">{item.priorTaskId ? "Continued work" : "Earlier task"} · {new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(new Date(item.createdAt))}</p>{taskDetails(item)}</section>);
  const chatStream: AssistantChatStream = {
    state: streamState.state,
    label: agents.reconnecting ? "Reconnecting. Your task continues in the background." : agents.liveStatus === "polling" && running.length && !agents.reconnecting ? "Live stream unavailable. Checking updates." : undefined,
    error: agents.error || undefined,
    retryLabel: agents.error ? (agents.unconfirmed ? "Retry message" : agents.conversation ? "Reconnect" : "Retry") : undefined,
    onRetry: agents.error ? (agents.unconfirmed ? () => void agents.send() : agents.conversation ? () => { agents.setError(null); void agents.refresh().catch((cause: unknown) => agents.setError(cause instanceof Error ? cause.message : "Unable to reconnect.")); } : () => void agents.openGeneral()) : undefined,
    stopLabel: task ? "Stop" : undefined,
    onStop: task ? () => void stop() : undefined,
    stopDisabled: agents.sending || task?.state === "cancel_requested",
    actions: task?.canContinue ? <Button type="button" variant="outline" size="sm" disabled={agents.sending} onClick={() => void agents.continueTask(task.id)}>{agents.continuingTaskId === task.id ? <LoaderCircle className="mr-1.5 size-3 animate-spin" /> : null}Continue</Button> : undefined,
  };
  return <section className="growth-agent-chat flex h-full min-h-0 min-w-0 flex-col bg-background" aria-label="Agent conversation">
    <header className="growth-agent-chat-header flex shrink-0 items-center gap-2 border-b border-border px-4">
      <span className="grid size-8 shrink-0 place-items-center text-foreground"><Bot className="size-4" /></span>
      <div className="min-w-0 flex-1"><h2 className="truncate text-sm font-semibold">{expanded ? agents.conversation?.title || feature?.name || "Growth assistant" : feature?.name || "Growth assistant"}</h2></div>
      <Button type="button" variant="ghost" size="icon" aria-label="New conversation" disabled={agents.loading || agents.sending} onClick={() => { if (expanded) navigate("/agents"); void agents.start(agents.conversation?.featureId || "assistant").then((id) => { if (expanded && id) { agents.closePanel(); navigate(`/agents/conversations/${encodeURIComponent(id)}`); } }); }}><Plus className="size-4" /></Button>
      {!expanded && agents.conversation ? <Button asChild variant="ghost" size="icon"><Link to={`/agents/conversations/${encodeURIComponent(agents.conversation.id)}`} onClick={agents.closePanel} aria-label="Expand conversation"><ArrowUpRight className="size-4" /></Link></Button> : null}
      {onClose ? <Button type="button" variant="ghost" size="icon" aria-label="Close assistant" onClick={onClose}><X className="size-4" /></Button> : null}
    </header>
    <AssistantChat
      className="h-full"
      scrollKey={`${agents.scopeKey}:${agents.conversation?.id ?? ""}`}
      loading={agents.loading}
      loadingContent={<div className="space-y-4" role="status" aria-label="Loading conversation"><Skeleton className="ml-auto h-16 w-2/3" /><Skeleton className="h-5 w-5/6" /><Skeleton className="h-5 w-2/3" /></div>}
      historyAction={agents.hasOlder ? <Button type="button" variant="ghost" size="sm" onClick={() => void agents.older()}>Load earlier messages</Button> : null}
      empty={Boolean(agents.conversation) && !agents.messages.length}
      emptyTitle="What would you like to work on?"
      emptyIcon={<Bot className="size-6" />}
      turns={turns}
      extra={earlierTurns.length ? <div className="space-y-3">{earlierTurns}</div> : null}
      renderAssistant={message => <GrowthAgentMarkdown text={message.text} sources={message.sources as unknown as GrowthAgentSource[]} />}
      renderSources={sources => <AgentSources sources={sources as unknown as GrowthAgentSource[]} />}
      stream={chatStream}
      composer={<AssistantChatComposer textareaRef={composer} value={agents.draft} onChange={agents.setDraft} onSubmit={() => void agents.send()} disabled={blocked} maxLength={canSteer ? 4000 : 131072} placeholder={canSteer ? "Add instructions…" : "Message your agent…"} label="Message agent" sendButton={null}
        context={<div className="flex min-w-0 flex-wrap items-center gap-x-2">{latest ? <AgentContextUsage context={growthExecution(latest).context} diagnostics={growthExecution(latest).diagnostics} /> : null}<ContextControl compact /></div>}
        actions={<div className="flex min-w-0 flex-wrap items-center justify-end gap-2"><GrowthAgentModelPicker key={`${agents.scopeKey}:${agents.conversation?.featureId ?? "assistant"}`} scopeKey={agents.scopeKey} featureId={agents.conversation?.featureId ?? "assistant"} label={feature?.model?.label || agents.bootstrap?.model?.label || "Default"} canConfigure={agents.bootstrap?.scope.canConfigureAgents === true} disabled={agents.loading || agents.sending || !agents.conversation} onSaved={() => agents.ensureBootstrap(true)} />{!task || canSteer ? <Button type="submit" size="icon" className="size-8 rounded-lg" disabled={blocked || !agents.draft.trim()} aria-label={canSteer ? "Send instructions" : "Send message"}>{agents.sending ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}</Button> : null}</div>} />}
    />
    {specialistResult.dialog}
  </section>;
}
