import { Link } from "react-router";
import { useNavigate } from "react-router";
import { AgentComposer, AgentConversationScroll, AgentContextUsage, AgentMessage } from "@kasitek-labs/ui/agent";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, LoaderCircle, Plus, Square, MessageCircle as Bot, Send as ArrowUp, X } from "@/components/ui/interface-icons";
import "./agents-workspace.css";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirmationDialog } from "@/components/ui/confirmation-provider";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { growthAgents, isActiveTask, safeGrowthRoute, type GrowthAgentArtifact, type GrowthAgentTask } from "@/lib/growth-agents";
import { AgentSources, GrowthAgentMarkdown } from "./agent-content";
export { AgentSources } from "./agent-content";
import { useGrowthAgents } from "./agent-provider";
import { ContextControl } from "./agent-context";
import { taskFailureLabel } from "./agent-progress";
import { growthExecution } from "@/lib/growth-agent-presentation";
import { useGrowthSubagent } from "./agent-subagent";
import { AgentDraftReview } from "./agent-review";
import { GrowthExecution } from "./agent-execution";


function TaskResults({ task }: { task: GrowthAgentTask }) {
  const [artifact, setArtifact] = useState<GrowthAgentArtifact | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const openArtifact = async (id: string) => {
    setBusy(true); setError(null);
    const abort = new AbortController(); controller.current = abort;
    try { const result = await growthAgents.artifact(task.id, id, abort.signal); if (!abort.signal.aborted) setArtifact(result.artifact); }
    catch (cause) { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : "Unable to open this result."); }
    finally { if (!abort.signal.aborted) setBusy(false); }
  };
  const download = safeGrowthRoute(artifact?.downloadPath);
  return <><div className="flex flex-wrap gap-2">{task.results?.map((result) => { const route = safeGrowthRoute(result.route); return route ? <Link key={result.id} to={route} className="inline-flex min-h-9 max-w-full items-center gap-2 rounded-md border border-border px-3 py-2 text-xs font-medium hover:bg-secondary"><span className="truncate">{result.title}</span><ArrowUpRight className="size-3.5 shrink-0" /></Link> : result.artifactId ? <Button key={result.id} type="button" variant="outline" size="sm" disabled={busy} onClick={() => void openArtifact(result.artifactId!)}>{result.title}</Button> : <span key={result.id} className="text-xs text-muted-foreground">{result.title}</span>; })}</div>{error ? <p className="mt-2 text-xs text-destructive" role="alert">{error}</p> : null}<Dialog open={Boolean(artifact)} onOpenChange={(open) => { if (!open) setArtifact(null); }}><DialogContent className="sm:max-w-2xl"><DialogHeader><DialogTitle>{artifact?.title}</DialogTitle><DialogDescription className="sr-only">Agent result</DialogDescription></DialogHeader><div className="min-w-0 whitespace-pre-wrap break-words text-sm">{artifact?.text || "No preview available."}</div>{download ? <div className="flex justify-end"><Button asChild size="sm"><a href={download} download>Download</a></Button></div> : null}</DialogContent></Dialog></>;
}

export function AgentConversation({ expanded = false, onClose }: { expanded?: boolean; onClose?: () => void }) {
  const agents = useGrowthAgents();
  const navigate = useNavigate();
  const { confirm } = useConfirmationDialog();
  const scroll = useRef<HTMLDivElement | null>(null);
  const composer = useRef<HTMLTextAreaElement | null>(null);
  const specialistResult = useGrowthSubagent(`${agents.scopeKey}:${agents.conversation?.id ?? ""}`, () => composer.current?.focus({ preventScroll: true }));
  const feature = agents.bootstrap?.features.find((item) => item.id === agents.conversation?.featureId);
  const running = agents.tasks.filter(isActiveTask);
  const task = running[0];
  const latest = [...agents.tasks].sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const canSteer = Boolean(task?.canSteer && task.state !== "cancel_requested");
  const blocked = agents.loading || agents.sending || agents.unconfirmed || Boolean(task && !canSteer) || !agents.conversation;
  const stop = async () => {
    if (task && await confirm({ title: "Stop this task?", description: "Changes already saved will remain.", confirmLabel: "Stop task" })) await agents.cancel(task.id);
  };
  const turns = [...agents.messages.reduce((groups, message) => {
    const id = message.taskId ?? message.id;
    const turn = groups.get(id) ?? { id, messages: [] as typeof agents.messages, task: agents.tasks.find(task => task.id === message.taskId) };
    turn.messages.push(message); groups.set(id, turn); return groups;
  }, new Map<string, { id: string; messages: typeof agents.messages; task: GrowthAgentTask | undefined }>()).values()];
  const pendingReviews = agents.reviews.filter((review) => !["expired", "rejected"].includes(review.state));
  const taskDetails = (item?: GrowthAgentTask) => item ? <section data-task-id={item.id} aria-label="Task details" className="mt-3 space-y-3">
    {item.errorCode === "EVIDENCE_UNAVAILABLE" ? <p role="status" className="text-xs text-muted-foreground">Sources unavailable</p> : null}
    <GrowthExecution task={{ ...item, output: !agents.messages.some(message => message.role === "assistant" && message.taskId === item.id) ? item.output : null }} onOpenSubagent={(child, button) => specialistResult.open(item.id, child, button)} renderOutput={text => <AgentMessage role="assistant"><GrowthAgentMarkdown text={text} sources={item.sources} /><AgentSources sources={item.sources ?? []} /></AgentMessage>} />
    {pendingReviews.filter(review => review.taskId === item.id).map(review => <AgentDraftReview key={review.id} review={review} />)}
    {item.results?.length ? <TaskResults task={item} /> : null}
    {["failed", "uncertain", "refused", "cancelled", "incomplete"].includes(item.state) ? <div className="flex flex-wrap items-center gap-3 rounded-md border border-border px-3 py-2"><p className="min-w-0 flex-1 text-xs text-muted-foreground" role="status">{taskFailureLabel(item)}</p>{item.canContinue && !running.length ? <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-8" disabled={agents.sending || agents.loading || agents.unconfirmed} onClick={() => void agents.continueTask(item.id)}>{agents.continuingTaskId === item.id ? <LoaderCircle className="mr-1.5 size-3 animate-spin" /> : null}Continue</Button> : null}</div> : null}
  </section> : null;
  return <section className="growth-agent-chat flex h-full min-h-0 min-w-0 flex-col bg-background" aria-label="Agent conversation">
    <header className="growth-agent-chat-header flex shrink-0 items-center gap-2 border-b border-border px-4">
      <span className="grid size-8 shrink-0 place-items-center text-foreground"><Bot className="size-4" /></span>
      <div className="min-w-0 flex-1"><h2 className="truncate text-sm font-semibold">{expanded ? agents.conversation?.title || feature?.name || "Growth assistant" : feature?.name || "Growth assistant"}</h2></div>
      <Button type="button" variant="ghost" size="icon" aria-label="New conversation" disabled={agents.loading || agents.sending} onClick={() => { if (expanded) navigate("/agents"); void agents.start(agents.conversation?.featureId || "assistant").then((id) => { if (expanded && id) { agents.closePanel(); navigate(`/agents/conversations/${encodeURIComponent(id)}`); } }); }}><Plus className="size-4" /></Button>
      {!expanded && agents.conversation ? <Button asChild variant="ghost" size="icon"><Link to={`/agents/conversations/${encodeURIComponent(agents.conversation.id)}`} onClick={agents.closePanel} aria-label="Expand conversation"><ArrowUpRight className="size-4" /></Link></Button> : null}
      {onClose ? <Button type="button" variant="ghost" size="icon" aria-label="Close assistant" onClick={onClose}><X className="size-4" /></Button> : null}
    </header>
    <AgentConversationScroll ref={scroll} resetKey={`${agents.scopeKey}:${agents.conversation?.id ?? ""}`}>
        {agents.loading ? <div className="space-y-4" role="status" aria-label="Loading conversation"><Skeleton className="ml-auto h-16 w-2/3" /><Skeleton className="h-5 w-5/6" /><Skeleton className="h-5 w-2/3" /></div> : <>
          {agents.hasOlder ? <div className="text-center"><Button type="button" variant="ghost" size="sm" onClick={() => void agents.older()}>Load earlier messages</Button></div> : null}
          {!agents.messages.length && agents.conversation ? <div className="py-12 text-center"><Bot className="mx-auto mb-3 size-6 text-primary" /><h3 className="text-base font-medium">What would you like to work on?</h3></div> : null}
          {turns.map(turn => <div key={turn.id} className="space-y-4">
            {turn.messages.filter(message => message.role === "user").map(message => <AgentMessage key={message.id} id={message.id} role="user" createdAt={message.createdAt} text={message.text} />)}
            {taskDetails(turn.task)}
            {turn.messages.filter(message => message.role === "assistant").map(message => <AgentMessage key={message.id} id={message.id} role="assistant" createdAt={message.createdAt}><GrowthAgentMarkdown text={message.text} sources={message.sources} />{message.sources ? <AgentSources sources={message.sources} /> : null}</AgentMessage>)}
          </div>)}
          {agents.tasks.filter(item => !agents.messages.some(message => message.taskId === item.id)).map(item => <section key={item.id} aria-label="Earlier task" className="space-y-3"><p className="text-xs text-muted-foreground">{item.priorTaskId ? "Continued work" : "Earlier task"} · {new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(new Date(item.createdAt))}</p>{taskDetails(item)}</section>)}
        </>}
    </AgentConversationScroll>
    {agents.liveStatus === "polling" && running.length && !agents.reconnecting ? <p className="px-4 py-2 text-xs text-muted-foreground" role="status">Live stream unavailable. Checking updates.</p> : null}
    {agents.reconnecting ? <p className="px-4 py-2 text-xs text-muted-foreground" role="status">Reconnecting. Your task continues in the background.</p> : null}
    {agents.error ? <div className="flex flex-wrap items-center gap-2 border-t border-destructive/20 bg-destructive/5 px-4 py-3 text-sm" role="alert"><span className="min-w-0 flex-1 text-destructive">{agents.error}</span>{agents.unconfirmed ? <Button type="button" variant="outline" size="sm" disabled={agents.sending} onClick={() => void agents.send()}>Retry message</Button> : agents.conversation ? <Button type="button" variant="outline" size="sm" onClick={() => { agents.setError(null); void agents.refresh().catch((cause: unknown) => agents.setError(cause instanceof Error ? cause.message : "Unable to reconnect.")); }}>Reconnect</Button> : <Button type="button" variant="outline" size="sm" onClick={() => void agents.openGeneral()}>Retry</Button>}</div> : null}
    <AgentComposer textareaRef={composer} value={agents.draft} onChange={agents.setDraft} onSubmit={() => void agents.send()} disabled={blocked} maxLength={canSteer ? 4000 : 131072} placeholder={canSteer ? "Add instructions…" : "Message your agent…"} label="Message agent" sendButton={null}
      context={<div className="flex min-w-0 flex-wrap items-center gap-x-2">{latest ? <AgentContextUsage context={growthExecution(latest).context} diagnostics={growthExecution(latest).diagnostics} /> : null}<ContextControl compact /></div>}
      actions={<div className="flex min-w-0 flex-wrap items-center justify-end gap-2"><span className="hidden max-w-28 truncate text-[11px] text-muted-foreground sm:block" title={feature?.model?.label || agents.bootstrap?.model?.label || "Business default"}>{feature?.model?.label || agents.bootstrap?.model?.label || "Business default"}</span>{task?.canContinue ? <Button type="button" variant="outline" size="sm" disabled={agents.sending} onClick={() => void agents.continueTask(task.id)}>{agents.continuingTaskId === task.id ? <LoaderCircle className="mr-1.5 size-3 animate-spin" /> : null}Continue</Button> : null}{task ? <Button type="button" variant="outline" size="sm" disabled={agents.sending || task.state === "cancel_requested"} onClick={() => void stop()}><Square className="mr-1.5 size-3" />Stop</Button> : null}{!task || canSteer ? <Button type="submit" size="icon" className="size-8 rounded-lg" disabled={blocked || !agents.draft.trim()} aria-label={canSteer ? "Send instructions" : "Send message"}>{agents.sending ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}</Button> : null}</div>} />
    {specialistResult.dialog}
  </section>;
}
