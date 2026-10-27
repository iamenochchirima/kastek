import { Link } from "react-router";
import { useNavigate } from "react-router";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, LoaderCircle, Plus, Square, MessageCircle as Bot, ChevronDown, Send as ArrowUp, UserRound, X } from "@/components/ui/interface-icons";
import "./agents-workspace.css";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useConfirmationDialog } from "@/components/ui/confirmation-provider";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { growthAgents, isActiveTask, safeGrowthRoute, taskStateLabel, type GrowthAgentArtifact, type GrowthAgentSource, type GrowthAgentTask } from "@/lib/growth-agents";
import { cn } from "@/lib/utils";
import { safeSourceLink, sourceCitations } from "@/lib/growth-agent-sources";
import { useGrowthAgents } from "./agent-provider";
import { ContextControl } from "./agent-context";
import { AgentDraftReview } from "./agent-review";

export function AgentSources({ sources }: { sources: GrowthAgentSource[] }) {
  if (!sources.length) return null;
  return <details className="mt-3 text-xs"><summary className="cursor-pointer text-muted-foreground">Sources · {sources.length}</summary><ol className="mt-2 list-decimal space-y-2 pl-5">{sources.map((source) => { const href = safeSourceLink(source); return <li key={source.id}>{href ? <a href={href} target={href.startsWith("/") ? undefined : "_blank"} rel="noreferrer" className="text-primary underline underline-offset-2">{source.title}</a> : <span className="text-muted-foreground">{source.title}</span>}</li>; })}</ol></details>;
}
function AgentMarkdown({ text, sources = [] }: { text: string; sources?: GrowthAgentSource[] }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm, sourceCitations(sources)]} skipHtml components={{
    p: ({ children }) => <p className="mt-3 first:mt-0">{children}</p>,
    h1: ({ children }) => <h3 className="mt-4 text-base font-semibold first:mt-0">{children}</h3>,
    h2: ({ children }) => <h4 className="mt-4 text-sm font-semibold first:mt-0">{children}</h4>,
    ul: ({ children }) => <ul className="mt-2 list-disc space-y-1 pl-5">{children}</ul>,
    ol: ({ children }) => <ol className="mt-2 list-decimal space-y-1 pl-5">{children}</ol>,
    a: ({ href, title, children }) => { let safe: string | null = safeGrowthRoute(href); if (!safe && href) { try { const url = new URL(href); if (["https:", "http:"].includes(url.protocol)) safe = url.href; } catch { /* Leave unsafe links as plain text. */ } } return safe ? <a href={safe} title={title} aria-label={title || undefined} target={safe.startsWith("/") ? undefined : "_blank"} rel="noreferrer" className="text-primary underline underline-offset-2">{children}</a> : <span>{children}</span>; },
    code: ({ children, className }) => <code className={cn("rounded bg-secondary px-1 py-0.5 text-xs", className && "my-2 block overflow-x-auto p-3")}>{children}</code>,
    table: ({ children }) => <div className="my-3 overflow-x-auto"><table className="w-full text-left text-xs">{children}</table></div>,
    th: ({ children }) => <th className="border-b border-border px-2 py-2 font-medium">{children}</th>,
    td: ({ children }) => <td className="border-b border-border px-2 py-2 align-top">{children}</td>,
  }}>{text}</ReactMarkdown>;
}

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
  const stayAtBottom = useRef(true);
  const composer = useRef<HTMLTextAreaElement | null>(null);
  const [showActivity, setShowActivity] = useState(false);
  const feature = agents.bootstrap?.features.find((item) => item.id === agents.conversation?.featureId);
  const running = agents.tasks.filter(isActiveTask);
  const task = running[0];
  const blocked = agents.loading || agents.sending || agents.unconfirmed || running.length > 0 || !agents.conversation;
  useEffect(() => {
    if (!stayAtBottom.current) return;
    const frame = requestAnimationFrame(() => scroll.current?.scrollTo({ top: scroll.current.scrollHeight }));
    return () => cancelAnimationFrame(frame);
  }, [agents.messages.length, agents.reviews.length, agents.tasks, agents.loading]);
  const stop = async () => {
    if (task && await confirm({ title: "Stop this task?", description: "Changes already saved will remain.", confirmLabel: "Stop task" })) await agents.cancel(task.id);
  };
  const pendingReviews = agents.reviews.filter((review) => !["expired", "rejected"].includes(review.state));
  return <section className="growth-agent-chat flex h-full min-h-0 min-w-0 flex-col bg-background" aria-label="Agent conversation">
    <header className="growth-agent-chat-header flex shrink-0 items-center gap-2 border-b border-border px-4">
      <span className="grid size-8 shrink-0 place-items-center text-foreground"><Bot className="size-4" /></span>
      <div className="min-w-0 flex-1"><h2 className="truncate text-sm font-semibold">{expanded ? agents.conversation?.title || feature?.name || "Growth assistant" : feature?.name || "Growth assistant"}</h2></div>
      <Button type="button" variant="ghost" size="icon" aria-label="New conversation" disabled={agents.loading || agents.sending} onClick={() => void agents.start(agents.conversation?.featureId || "assistant").then((id) => { if (expanded && id) { agents.closePanel(); navigate(`/agents/conversations/${encodeURIComponent(id)}`); } })}><Plus className="size-4" /></Button>
      {!expanded && agents.conversation ? <Button asChild variant="ghost" size="icon"><Link to={`/agents/conversations/${encodeURIComponent(agents.conversation.id)}`} onClick={agents.closePanel} aria-label="Expand conversation"><ArrowUpRight className="size-4" /></Link></Button> : null}
      {onClose ? <Button type="button" variant="ghost" size="icon" aria-label="Close assistant" onClick={onClose}><X className="size-4" /></Button> : null}
    </header>
    <div ref={scroll} onScroll={() => { const element = scroll.current; if (element) stayAtBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80; }} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5">
      <div className="mx-auto max-w-3xl space-y-6">
        {agents.loading ? <div className="space-y-4" role="status" aria-label="Loading conversation"><Skeleton className="ml-auto h-16 w-2/3" /><Skeleton className="h-5 w-5/6" /><Skeleton className="h-5 w-2/3" /></div> : <>
          {agents.hasOlder ? <div className="text-center"><Button type="button" variant="ghost" size="sm" onClick={() => { stayAtBottom.current = false; void agents.older(); }}>Load earlier messages</Button></div> : null}
          {!agents.messages.length && agents.conversation ? <div className="py-12 text-center"><Bot className="mx-auto mb-3 size-6 text-primary" /><h3 className="text-base font-medium">What would you like to work on?</h3></div> : null}
          {agents.messages.map((message) => <article key={message.id} data-message-id={message.id} data-role={message.role} className="growth-agent-chat-message"><span className="growth-agent-chat-avatar">{message.role === "user" ? <UserRound className="size-4" /> : <Bot className="size-4" />}</span><div className="min-w-0 max-w-[calc(100%-40px)]"><div className="growth-agent-chat-bubble max-w-none"><span className="sr-only">{message.role === "user" ? "You" : "Agent"}</span>{message.role === "assistant" ? <AgentMarkdown text={message.text} sources={message.sources} /> : <p className="whitespace-pre-wrap">{message.text}</p>}{message.sources ? <AgentSources sources={message.sources} /> : null}</div><time dateTime={message.createdAt} className="growth-agent-chat-time">{new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(message.createdAt))}</time></div></article>)}
          {agents.tasks.filter((item) => item.output && !agents.messages.some((message) => message.role === "assistant" && message.taskId === item.id)).map((item) => <article key={item.id} className="min-w-0 break-words text-sm leading-6"><AgentMarkdown text={item.output!} sources={item.sources} />{item.sources ? <AgentSources sources={item.sources} /> : null}</article>)}
          {pendingReviews.map((review) => <AgentDraftReview key={review.id} review={review} />)}
          {agents.tasks.filter((item) => item.results?.length).map((item) => <TaskResults key={item.id} task={item} />)}
          {agents.tasks.filter((item) => ["failed", "uncertain", "refused", "cancelled", "incomplete"].includes(item.state)).map((item) => <p key={item.id} className="rounded-md border border-border px-3 py-2 text-xs text-muted-foreground" role="status">{taskStateLabel[item.state]}{item.state === "uncertain" ? ". An action may have completed. Check its result before repeating it." : ""}</p>)}
        </>}
      </div>
    </div>
    {running.length || agents.events.length ? <div className="shrink-0 border-t border-border px-4 py-2"><button type="button" className="flex min-h-8 w-full items-center gap-2 text-left text-xs text-muted-foreground" aria-expanded={showActivity} onClick={() => setShowActivity((value) => !value)}>{task && ["accepted", "queued", "working"].includes(task.state) ? <LoaderCircle className="size-3.5 animate-spin" /> : null}<span className="flex-1">{task ? taskStateLabel[task.state] : "Task activity"}</span><ChevronDown className="size-3.5" /></button>{showActivity ? <ol className="max-h-32 space-y-1 overflow-y-auto pb-2 text-xs text-muted-foreground">{agents.events.slice(-12).map((event) => <li key={event.id}>{event.message || (event.state ? taskStateLabel[event.state] : "Task updated")}</li>)}</ol> : null}</div> : null}
    {agents.reconnecting ? <p className="px-4 py-2 text-xs text-muted-foreground" role="status">Reconnecting. Your task continues in the background.</p> : null}
    {agents.error ? <div className="flex flex-wrap items-center gap-2 border-t border-destructive/20 bg-destructive/5 px-4 py-3 text-sm" role="alert"><span className="min-w-0 flex-1 text-destructive">{agents.error}</span>{agents.unconfirmed ? <Button type="button" variant="outline" size="sm" disabled={agents.sending} onClick={() => void agents.send()}>Retry message</Button> : agents.conversation ? <Button type="button" variant="outline" size="sm" onClick={() => { agents.setError(null); void agents.refresh().catch((cause: unknown) => agents.setError(cause instanceof Error ? cause.message : "Unable to reconnect.")); }}>Reconnect</Button> : <Button type="button" variant="outline" size="sm" onClick={() => void agents.openGeneral()}>Retry</Button>}</div> : null}
    <form className="shrink-0 border-t border-border bg-background p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]" onSubmit={(event) => { event.preventDefault(); stayAtBottom.current = true; void agents.send(); }}>
      <div className="rounded-lg border border-input bg-card p-2 focus-within:border-primary/50"><textarea ref={composer} aria-label="Message agent" rows={2} value={agents.draft} onChange={(event) => agents.setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (!blocked && agents.draft.trim()) { stayAtBottom.current = true; void agents.send(); } } }} disabled={blocked} placeholder="Message your agent…" className="max-h-48 min-h-14 w-full resize-none bg-transparent px-1 py-1 text-sm outline-none placeholder:text-muted-foreground disabled:opacity-60" />
        <div className="growth-agent-composer-controls"><ContextControl compact /><span className="ml-auto max-w-[min(100%,120px)] truncate rounded-md border border-border px-2 py-1.5 text-[11px] text-muted-foreground" title={feature?.model?.label || agents.bootstrap?.model?.label || "Business default"}>{feature?.model?.label || agents.bootstrap?.model?.label || "Business default"}</span>{task ? <Button type="button" variant="outline" size="sm" disabled={task.state === "cancel_requested"} onClick={() => void stop()}><Square className="mr-1.5 size-3" />Stop</Button> : <Button type="submit" size="icon" className="size-8 rounded-lg" disabled={blocked || !agents.draft.trim()} aria-label="Send message">{agents.sending ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}</Button>}</div>
      </div>
    </form>
  </section>;
}
