"use client";

import * as React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PiArrowDown, PiArrowUp, PiArrowLeft, PiArrowSquareOut, PiCheck, PiCaretRight, PiCircle, PiSpinnerGap, PiWarningCircle, PiMagnifyingGlass, PiFileText } from "react-icons/pi";
import { Button } from "./button.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./dialog.js";
import { cn } from "./utils.js";
import { agentIsActive, agentStateLabel, formatAgentDuration, safeAgentLink, orderAgentEntries } from "./agent-state.js";

export { agentIsActive, agentStateLabel, formatAgentDuration, mergeAgentEntries, safeAgentLink, orderAgentEntries } from "./agent-state.js";

export interface AgentOperation {
  id: string;
  label: string;
  state: string;
  kind?: string;
  startedAt?: string;
  details?: React.ReactNode;
  detailAvailability?: "available" | "unavailable" | "redacted" | "unsupported";
}

export interface AgentSubagent { id: string; name: string; state: string; assignment?: string; createdAt?: string }
export interface AgentExecution {
  id: string;
  state: string;
  label?: string;
  updates?: { id: string; text: string; createdAt?: string }[];
  operations?: AgentOperation[];
  children?: AgentSubagent[];
  output?: string | null;
  context?: { estimatedInputTokens?: number | null; windowTokens?: number | null; utilizationPercent?: number | null };
  diagnostics?: { label: string; value: string | number | null }[];
  elapsedMs?: number | null;
  observedAt?: string;
  approach?: { objective: string; steps: { id: string; title: string; state: string }[]; questions: string[] };
}

export function AgentMessageContent({ text, resolveLink, remarkPlugins = [], format = "markdown" }: { text: string; resolveLink?: (href: string) => string | null; remarkPlugins?: React.ComponentProps<typeof ReactMarkdown>["remarkPlugins"]; format?: "markdown" | "plain" }) {
  if (format === "plain") return <p className="whitespace-pre-wrap break-words text-sm leading-7 [overflow-wrap:anywhere]">{text}</p>;
  return <div className="agent-message-content min-w-0 break-words text-sm leading-7 [overflow-wrap:anywhere]">
    <ReactMarkdown remarkPlugins={[remarkGfm, ...(remarkPlugins ?? [])]} skipHtml components={{
      p: ({ children }) => <p className="mt-3 first:mt-0">{children}</p>,
      h1: ({ children }) => <h3 className="mt-5 text-base font-semibold first:mt-0">{children}</h3>,
      h2: ({ children }) => <h4 className="mt-5 text-sm font-semibold first:mt-0">{children}</h4>,
      h3: ({ children }) => <h5 className="mt-4 text-sm font-medium">{children}</h5>,
      ul: ({ children }) => <ul className="mt-2 list-disc space-y-1 pl-5">{children}</ul>,
      ol: ({ children }) => <ol className="mt-2 list-decimal space-y-1 pl-5">{children}</ol>,
      blockquote: ({ children }) => <blockquote className="my-3 border-l-2 border-border pl-3 text-muted-foreground">{children}</blockquote>,
      a: ({ href, title, children }) => { const resolved = href ? (resolveLink ? resolveLink(href) : href) : null; const safe = resolved ? safeAgentLink(resolved) : null; return safe ? <a href={safe} title={title} aria-label={title || undefined} target={safe.startsWith("http") ? "_blank" : undefined} rel="noreferrer" className="underline underline-offset-4">{children}</a> : <span>{children}</span>; },
      img: ({ alt }) => <span>{alt}</span>,
      code: ({ children, className }) => <code className={cn("rounded bg-secondary px-1 py-0.5 font-mono text-xs", className)}>{children}</code>,
      pre: ({ children }) => <pre className="my-3 max-w-full overflow-x-auto rounded-lg bg-secondary p-3 text-xs leading-6">{children}</pre>,
      table: ({ children }) => <div className="my-3 max-w-full overflow-x-auto"><table className="w-full text-left text-xs">{children}</table></div>,
      th: ({ children }) => <th className="border-b border-border px-2 py-2 font-medium">{children}</th>,
      td: ({ children }) => <td className="border-b border-border px-2 py-2 align-top">{children}</td>,
    }}>{text}</ReactMarkdown>
  </div>;
}

export function AgentMessage({ role, text, children, label, createdAt, id, className }: { role: "user" | "assistant" | "system"; text?: string; children?: React.ReactNode; label?: string; createdAt?: string; id?: string; className?: string }) {
  return <article data-message-id={id} data-role={role} className={cn("agent-message min-w-0", role === "user" ? "ml-auto w-fit max-w-[90%] rounded-2xl bg-secondary px-4 py-3 sm:max-w-[85%]" : "w-full", className)}>
    <span className="sr-only">{label ?? (role === "user" ? "You" : role === "system" ? "Status" : "Agent")}</span>
    {text !== undefined ? role === "user" ? <p className="whitespace-pre-wrap break-words text-sm leading-7 [overflow-wrap:anywhere]">{text}</p> : <AgentMessageContent text={text} /> : null}
    {children}
    {createdAt ? <time className="sr-only" dateTime={createdAt}>{createdAt}</time> : null}
  </article>;
}

export function AgentComposer({ value, onChange, onSubmit, disabled = false, maxLength, placeholder = "Message your agent…", textareaRef, context, actions, sendButton, sendLabel = "Send message", sending = false, rows = 2, label = "Message agent", className, autoFocus }: {
  value: string; onChange: (value: string) => void; onSubmit: () => void; disabled?: boolean; maxLength?: number;
  placeholder?: string; textareaRef?: React.Ref<HTMLTextAreaElement>; context?: React.ReactNode; actions?: React.ReactNode;
  sendButton?: React.ReactNode; sendLabel?: string; sending?: boolean; rows?: number; label?: string; className?: string; autoFocus?: boolean;
}) {
  const blocked = disabled || sending;
  const submit = () => { if (!blocked && value.trim()) onSubmit(); };
  return <form className={cn("agent-composer shrink-0 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]", className)} onSubmit={event => { event.preventDefault(); submit(); }}>
    <div className="mx-auto min-w-0 max-w-3xl rounded-2xl border border-input bg-secondary/40 p-2 focus-within:border-ring/50">
      <textarea ref={textareaRef} aria-label={label} rows={rows} value={value} onChange={event => onChange(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); } }} disabled={disabled} maxLength={maxLength} placeholder={placeholder} autoFocus={autoFocus} className="max-h-48 min-h-14 w-full resize-none bg-transparent px-2 py-1 text-sm leading-6 outline-none placeholder:text-muted-foreground disabled:opacity-60" />
      <div className="flex min-w-0 flex-wrap items-center gap-2 px-1"><div className="min-w-0 flex-1">{context}</div><div className="flex min-w-0 flex-wrap items-center justify-end gap-2">{actions}{sendButton === undefined ? <Button type="submit" size="icon" className="size-9 rounded-full" disabled={blocked || !value.trim()} aria-label={sendLabel}>{sending ? <PiSpinnerGap aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : <PiArrowUp aria-hidden className="size-4" />}</Button> : sendButton}</div></div>
    </div>
  </form>;
}

function StateIcon({ state }: { state: string }) {
  if (state === "completed") return <PiCheck aria-hidden className="size-4 shrink-0 text-muted-foreground" />;
  if (["failed", "uncertain", "incomplete", "refused"].includes(state)) return <PiWarningCircle aria-hidden className="size-4 shrink-0 text-muted-foreground" />;
  if (agentIsActive(state) || state === "started") return <PiSpinnerGap aria-hidden className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none" />;
  return <PiCircle aria-hidden className="size-4 shrink-0 text-muted-foreground" />;
}

export function AgentToolRow({ operation }: { operation: AgentOperation }) {
  const availability = operation.detailAvailability ?? (operation.details ? "available" : "unsupported");
  return <details data-operation-id={operation.id} className="group min-w-0 text-sm">
    <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 rounded-md px-2 py-2 text-muted-foreground hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
      <StateIcon state={operation.state} /><span className="min-w-0 flex-1 break-words">{operation.label}</span><span className="shrink-0 text-xs">{agentStateLabel(operation.state)}</span><PiCaretRight aria-hidden className="size-3 shrink-0 transition-transform group-open:rotate-90" />
    </summary>
    <div className="mb-2 ml-4 min-w-0 border-l border-border py-2 pl-4 text-xs leading-6 text-muted-foreground [overflow-wrap:anywhere]">
      {availability === "available" && operation.details ? operation.details : availability === "redacted" ? "Details are restricted." : availability === "unavailable" ? "Details are unavailable." : "No additional details recorded."}
    </div>
  </details>;
}

export function AgentSubagentRow({ child, onOpen }: { child: AgentSubagent; onOpen?: (child: AgentSubagent, trigger: HTMLButtonElement) => void }) {
  const body = <><StateIcon state={child.state} /><span className="min-w-0 flex-1"><span className="block font-medium text-foreground">{child.name}</span>{child.assignment ? <span className="mt-0.5 line-clamp-2 break-words text-xs text-muted-foreground">{child.assignment}</span> : null}</span><span className="shrink-0 text-xs text-muted-foreground">{agentStateLabel(child.state)}</span>{onOpen ? <PiArrowSquareOut aria-hidden className="size-4 shrink-0 text-muted-foreground" /> : null}</>;
  return onOpen ? <button type="button" data-subagent-id={child.id} className="flex min-h-11 w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm hover:bg-secondary focus-visible:outline-2 focus-visible:outline-ring" aria-label={`Open ${child.name} activity`} onClick={event => onOpen(child, event.currentTarget)}>{body}</button> : <div className="flex min-h-11 items-center gap-3 px-2 py-2 text-sm">{body}</div>;
}

export function AgentContextUsage({ context, diagnostics }: Pick<AgentExecution, "context" | "diagnostics">) {
  if (!context && !diagnostics?.length) return null;
  const percent = context?.utilizationPercent;
  return <details data-agent-context data-dialog-disclosure className="relative min-w-0 text-xs text-muted-foreground" onKeyDown={event => { if (event.key === "Escape" && event.currentTarget.open) { event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}><summary className="min-h-9 w-fit cursor-pointer py-2">{context ? `Context${typeof percent === "number" && Number.isFinite(percent) ? ` · ${Math.round(percent)}%` : ""}` : "Execution details"}</summary>
    <div className="absolute bottom-full left-0 z-50 mb-2 max-h-[min(60dvh,24rem)] w-[min(80vw,24rem)] space-y-3 overflow-auto rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-lg">{context ? <><p>Context capacity, not task progress.</p><dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1"><dt>Estimated input</dt><dd>{context.estimatedInputTokens?.toLocaleString() ?? "Unavailable"}</dd><dt>Model window</dt><dd>{context.windowTokens?.toLocaleString() ?? "Unavailable"}</dd></dl></> : null}
      {diagnostics?.length ? <details><summary className="min-h-9 cursor-pointer py-2">{context ? "Execution details" : "Measurements"}</summary><dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1">{diagnostics.map(item => <React.Fragment key={item.label}><dt>{item.label}</dt><dd className="max-w-48 break-words text-right">{item.value ?? "Unavailable"}</dd></React.Fragment>)}</dl></details> : null}
    </div>
  </details>;
}

export const AgentContextDetails = AgentContextUsage;

export function AgentExecutionView({ execution, onOpenSubagent, children, renderOutput, showContext = false, showStatus = true }: { execution: AgentExecution; onOpenSubagent?: (child: AgentSubagent, trigger: HTMLButtonElement) => void; children?: React.ReactNode; renderOutput?: (text: string) => React.ReactNode; showContext?: boolean; showStatus?: boolean }) {
  const active = agentIsActive(execution.state);
  const elapsed = formatAgentDuration(execution.elapsedMs);
  const [activityOpen, setActivityOpen] = React.useState(active);
  const manuallyOpened = React.useRef(false);
  const inspectSubagent = onOpenSubagent ? (child: AgentSubagent, trigger: HTMLButtonElement) => { manuallyOpened.current = true; onOpenSubagent(child, trigger); } : undefined;
  React.useEffect(() => { if (!active && !manuallyOpened.current) setActivityOpen(false); }, [active]);
  const operations = execution.operations ?? [], specialists = execution.children ?? [];
  const hasActivity = operations.length > 0 || specialists.length > 0;
  const updates = execution.updates ?? [];
  const timeline = orderAgentEntries([
    ...updates.map(update => ({ id: `update:${update.id}`, createdAt: update.createdAt, content: <AgentMessage key={update.id} id={update.id} role="assistant" text={update.text} /> })),
    ...operations.map(operation => ({ id: `operation:${operation.id}`, startedAt: operation.startedAt, content: <AgentToolRow key={operation.id} operation={operation} /> })),
    ...specialists.map(child => ({ id: `child:${child.id}`, createdAt: child.createdAt, content: <AgentSubagentRow key={child.id} child={child} onOpen={inspectSubagent} /> })),
  ]);
  const latestUpdate = orderAgentEntries(updates).at(-1);
  return <section data-execution-id={execution.id} aria-label="Agent work" className="agent-execution min-w-0 space-y-3">
    {showStatus ? <div className="flex min-h-8 items-center gap-2 text-sm text-muted-foreground" role="status"><StateIcon state={execution.state} /><span>{execution.label ?? (execution.state === "completed" && execution.output ? "Response ready" : agentStateLabel(execution.state))}</span>{elapsed ? <span aria-label="Execution time" title="Time since acceptance, including waiting and specialist work." className="text-xs">· {elapsed}</span> : null}{active && specialists.length ? <span className="text-xs">· {specialists.length} {specialists.length === 1 ? "agent" : "agents"}</span> : null}</div> : null}
    {!hasActivity ? updates.map(update => <AgentMessage key={update.id} id={update.id} role="assistant" text={update.text} />) : !activityOpen && latestUpdate ? <AgentMessage id={latestUpdate.id} role="assistant" text={latestUpdate.text} /> : null}
    {execution.approach ? <details className="text-xs text-muted-foreground"><summary className="min-h-9 cursor-pointer py-2">Approach</summary><div className="space-y-3 py-2"><p className="whitespace-pre-wrap break-words">{execution.approach.objective}</p>{execution.approach.steps.length ? <ol className="space-y-2">{execution.approach.steps.map(step => <li key={step.id} className="flex flex-wrap justify-between gap-x-3 gap-y-1"><span>{step.title}</span><span>{agentStateLabel(step.state)}</span></li>)}</ol> : null}{execution.approach.questions.length ? <ul className="list-disc space-y-1 pl-4">{execution.approach.questions.map((question, index) => <li key={index}>{question}</li>)}</ul> : null}</div></details> : null}
    {hasActivity ? <div className="min-w-0"><button type="button" className="flex min-h-9 items-center gap-2 rounded-md text-xs text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring" aria-expanded={activityOpen} onClick={() => { manuallyOpened.current = true; setActivityOpen(value => !value); }}><PiCaretRight aria-hidden className={cn("size-3", activityOpen && "rotate-90")} />Activity{!active ? ` · ${operations.length + specialists.length} items` : ""}</button>{activityOpen ? <div className="space-y-2" onPointerDownCapture={() => { manuallyOpened.current = true; }} onKeyDownCapture={() => { manuallyOpened.current = true; }}>{timeline.map(entry => <React.Fragment key={entry.id}>{entry.content}</React.Fragment>)}</div> : null}</div> : null}
    {execution.output ? <div className="pt-1">{renderOutput ? renderOutput(execution.output) : <AgentMessage role="assistant" text={execution.output} />}</div> : null}
    {children}
    {showContext ? <AgentContextUsage context={execution.context} diagnostics={execution.diagnostics} /> : null}
  </section>;
}

const readingPositions = new Map<string, { top: number; following: boolean }>();

export const AgentConversationScroll = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement> & { resetKey?: string; paused?: boolean }>(function AgentConversationScroll({ children, resetKey, paused = false, className, onScroll, ...props }, forwardedRef) {
  const viewport = React.useRef<HTMLDivElement | null>(null);
  const following = React.useRef(true);
  const [hasNew, setHasNew] = React.useState(false);
  const content = React.useRef<HTMLDivElement | null>(null);
  const pendingRestore = React.useRef<number | null>(null);
  const pausedRef = React.useRef(paused);
  pausedRef.current = paused;
  const remember = React.useCallback(() => {
    const node = viewport.current;
    if (!resetKey || !node || node.clientHeight === 0 || pausedRef.current) return;
    readingPositions.delete(resetKey);
    readingPositions.set(resetKey, { top: node.scrollTop, following: following.current });
    if (readingPositions.size > 100) readingPositions.delete(readingPositions.keys().next().value!);
  }, [resetKey]);
  const anchor = React.useRef<{ element: HTMLElement; top: number } | null>(null);
  const captureAnchor = React.useCallback(() => {
    const node = viewport.current;
    if (!node) return;
    const bounds = node.getBoundingClientRect();
    const elements = content.current?.querySelectorAll<HTMLElement>("[data-message-id], [data-operation-id], [data-subagent-id]");
    const element = elements && Array.from(elements).find(item => item.getBoundingClientRect().bottom > bounds.top);
    anchor.current = element ? { element, top: element.getBoundingClientRect().top } : null;
  }, []);
  const bottom = React.useCallback(() => { const node = viewport.current; if (node) node.scrollTop = node.scrollHeight; following.current = true; setHasNew(false); }, []);
  React.useImperativeHandle(forwardedRef, () => viewport.current!, []);
  React.useLayoutEffect(() => {
    const saved = resetKey ? readingPositions.get(resetKey) : undefined;
    following.current = saved?.following ?? true;
    setHasNew(false);
    pendingRestore.current = saved && !saved.following ? saved.top : null;
    if (saved && !saved.following && viewport.current) viewport.current.scrollTop = saved.top;
    else bottom();
    captureAnchor();
  }, [resetKey, bottom, captureAnchor]);
  React.useLayoutEffect(() => {
    const observer = new ResizeObserver(() => {
      if (pausedRef.current) return;
      if (following.current) bottom();
      else {
        const restored = pendingRestore.current;
        if (restored !== null && viewport.current && viewport.current.scrollHeight - viewport.current.clientHeight >= restored) {
          viewport.current.scrollTop = restored;
          pendingRestore.current = null;
          captureAnchor();
        }
        const previous = anchor.current;
        if (previous?.element.isConnected && viewport.current) viewport.current.scrollTop += previous.element.getBoundingClientRect().top - previous.top;
        setHasNew(true);
      }
      captureAnchor();
      if (pendingRestore.current === null) remember();
    });
    if (content.current) observer.observe(content.current);
    return () => observer.disconnect();
  }, [bottom, captureAnchor, remember]);
  return <div className="relative flex min-h-0 min-w-0 flex-1 flex-col"><div {...props} ref={viewport} data-agent-message-scroll className={cn("min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5", className)} onScroll={event => { if (!pausedRef.current) { const node = event.currentTarget; following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 64; if (following.current) setHasNew(false); captureAnchor(); if (pendingRestore.current === null) remember(); } onScroll?.(event); }}><div ref={content} className="mx-auto min-w-0 max-w-3xl space-y-6">{children}</div></div>{hasNew ? <Button type="button" variant="secondary" size="sm" className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full shadow-sm" onClick={bottom}><PiArrowDown aria-hidden className="size-3" />Jump to latest</Button> : null}</div>;
});

export function AgentSubagentModal({ open, onOpenChange, title, assignment, state, elapsedMs, children, loading, error, onBack, onCloseAutoFocus, viewKey }: { open: boolean; onOpenChange: (open: boolean) => void; title: string; assignment?: string; state?: string; elapsedMs?: number | null; children?: React.ReactNode; loading?: boolean; error?: string | null; onBack?: () => void; onCloseAutoFocus?: React.ComponentProps<typeof DialogContent>["onCloseAutoFocus"]; viewKey?: string }) {
  const elapsed = formatAgentDuration(elapsedMs);
  const active = state ? agentIsActive(state) : false;
  const assignmentTitle = assignment?.split("\n").find(line => line.trim())?.trim();
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent data-agent-subagent-modal onCloseAutoFocus={onCloseAutoFocus} className="inset-0 left-0 top-0 flex h-[100dvh] max-h-[100dvh] w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none p-0 sm:left-1/2 sm:top-1/2 sm:h-[86dvh] sm:max-h-[calc(100dvh-3rem)] sm:max-w-4xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:p-0">
    <header className="agent-specialist-header">{onBack ? <Button type="button" variant="ghost" size="icon" aria-label="Back to previous agent" onClick={onBack}><PiArrowLeft className="size-4" /></Button> : null}<span className="agent-specialist-avatar" aria-hidden><PiMagnifyingGlass /></span><div className="min-w-0 flex-1"><DialogTitle className="agent-specialist-title">{title}</DialogTitle><DialogDescription className={assignmentTitle ? "agent-specialist-subtitle" : "sr-only"} title={assignmentTitle}>{assignmentTitle || "Subagent conversation and live activity"}</DialogDescription>{state ? <div className="agent-specialist-status" role="status" data-active={active}><StateIcon state={state} /><span>{agentStateLabel(state)}</span>{elapsed ? <span aria-label="Execution time" title="Time since acceptance, including waiting and specialist work.">· {elapsed}</span> : null}</div> : null}</div></header>
    <AgentConversationScroll resetKey={viewKey} paused={!open} className="agent-specialist-transcript">
      {assignment ? <details data-agent-assignment className="agent-specialist-assignment"><summary><PiFileText aria-hidden /><span><strong>Assignment</strong><span>{assignmentTitle}</span></span><PiCaretRight aria-hidden /></summary><div><AgentMessageContent text={assignment} /></div></details> : null}
      {loading ? <div role="status" aria-label="Loading agent activity" className="space-y-3"><div className="h-4 w-2/3 animate-pulse rounded bg-secondary motion-reduce:animate-none" /><div className="h-4 w-5/6 animate-pulse rounded bg-secondary motion-reduce:animate-none" /></div> : null}{error ? <p role="alert" className="text-sm text-muted-foreground">{error}</p> : null}{children}
    </AgentConversationScroll>
    {active ? <footer className="agent-specialist-footer"><PiSpinnerGap aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /><span>{title} is working…</span></footer> : null}
  </DialogContent></Dialog>;
}
