"use client";

import * as React from "react";
import { Button } from "./button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./dialog.js";
import { Textarea } from "./textarea.js";
import { Switch } from "./switch.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./select.js";

interface MemoryAssertion { context: "unspecified" | "current" | "hypothetical"; conflict: "not_assessed" | "reported" | "resolved" }
export interface AgentMemoryItem { id: string; revision: number; content: string; status: "candidate" | "accepted" | "forgotten"; origin?: "user_supplied" | "model_candidate"; assertion?: MemoryAssertion; updatedAt?: string; expiresAt?: string | null }
export interface AgentMemoryPage { memories: AgentMemoryItem[]; candidates: AgentMemoryItem[]; nextOffset?: number | null }
export interface AgentMemoryMutation { expectedRevision: number; action: "accept" | "correct" | "forget"; content?: string; assertion?: MemoryAssertion; requestKey: string }
export interface AgentMemoryPanelProps {
  open: boolean; onOpenChange: (open: boolean) => void; scopeKey: string;
  onCloseAutoFocus?: React.ComponentProps<typeof DialogContent>["onCloseAutoFocus"];
  load: (page?: { offset?: number; limit?: number }) => Promise<AgentMemoryPage>;
  mutate: (id: string, input: AgentMemoryMutation) => Promise<unknown>;
  enabled?: boolean; onEnabledChange?: (enabled: boolean, requestKey: string) => Promise<unknown>;
}
type Selection = { item: AgentMemoryItem; action: AgentMemoryMutation["action"] };

export function AgentMemoryPanel({ open, onOpenChange, onCloseAutoFocus, scopeKey, load, mutate, enabled, onEnabledChange }: AgentMemoryPanelProps) {
  const [items, setItems] = React.useState<AgentMemoryItem[]>([]), [nextOffset, setNextOffset] = React.useState<number | null>(null);
  const [loading, setLoading] = React.useState(false), [busy, setBusy] = React.useState(false), [error, setError] = React.useState<string | null>(null);
  const [selection, setSelection] = React.useState<Selection | null>(null), [content, setContent] = React.useState("");
  const [notice, setNotice] = React.useState<string | null>(null);
  const [assertion, setAssertion] = React.useState<MemoryAssertion>({ context: "unspecified", conflict: "not_assessed" });
  const assertionId = React.useId();
  const epoch = React.useRef(0), currentScope = React.useRef(scopeKey), request = React.useRef<{ signature: string; key: string } | null>(null);
  const visible = React.useRef(open), pending = React.useRef(false), mutating = React.useRef(busy);
  const itemsRef = React.useRef(items), selectionRef = React.useRef(selection);
  const opener = React.useRef<HTMLElement | null>(null);
  visible.current = open; mutating.current = busy; itemsRef.current = items; selectionRef.current = selection;
  const scopeMatches=currentScope.current===scopeKey;
  const loadRef = React.useRef(load); loadRef.current = load;
  const changeRequest = (signature: string) => {
    if (request.current?.signature !== signature) request.current = { signature, key: crypto.randomUUID() };
    return request.current.key;
  };
  React.useEffect(() => {
    currentScope.current = scopeKey; epoch.current++; request.current = null;
    setItems([]); setNextOffset(null); setSelection(null); setContent(""); setError(null); setNotice(null); setBusy(false);
  }, [scopeKey]);
  const refresh = React.useCallback(async (offset = 0) => {
    if (offset && pending.current) return;
    const generation = ++epoch.current, expectedScope = scopeKey;
    pending.current = true;
    setLoading(true);
    setError(null);
    try {
      const rows: AgentMemoryItem[] = [], keepCount = offset ? 30 : Math.max(30, itemsRef.current.length);
      let next: number | null = offset;
      do {
        const page = await loadRef.current({ offset: next, limit: 30 });
        if (epoch.current !== generation || currentScope.current !== expectedScope || !visible.current) return;
        rows.push(...page.candidates, ...page.memories);
        const previous = next;
        next = page.nextOffset ?? null;
        if (next !== null && next <= previous) throw new Error("Memory pagination unavailable");
      } while (!offset && next !== null && rows.length < keepCount);
      setItems(previous => offset ? [...new Map([...previous, ...rows].map(item => [item.id, item])).values()] : rows);
      setNextOffset(next);
      if (!offset && selectionRef.current) {
        const selected = selectionRef.current.item, current = rows.find(item => item.id === selected.id);
        if (!current || current.revision !== selected.revision || current.status === "forgotten") {
          setSelection(null); setContent(""); setNotice(null); request.current = null;
        }
      }
    } catch (failure) {
      if (epoch.current === generation && currentScope.current === expectedScope && visible.current) {
        setItems([]); setNextOffset(null); setSelection(null); setContent(""); setNotice(null); request.current = null;
        setError(failure instanceof Error ? failure.message : "Memory unavailable");
      }
    } finally {
      if (epoch.current === generation && currentScope.current === expectedScope) { pending.current = false; setLoading(false); }
    }
  }, [scopeKey]);
  React.useEffect(() => {
    if (!open) { setItems([]); setNextOffset(null); setSelection(null); setContent(""); setError(null); setNotice(null); return; }
    void refresh();
    const revalidate = () => {
      if (document.visibilityState === "visible" && !mutating.current && !pending.current) void refresh();
    };
    const timer = setInterval(revalidate, 5000);
    document.addEventListener("visibilitychange", revalidate);
    return () => { epoch.current++; pending.current = false; clearInterval(timer); document.removeEventListener("visibilitychange", revalidate); };
  }, [open, refresh]);
  const choose = (item: AgentMemoryItem, action: Selection["action"]) => {
    setSelection({ item, action }); setContent(item.content); setError(null); setNotice(null); request.current = null;
    setAssertion(item.assertion ?? { context: "unspecified", conflict: "not_assessed" });
  };
  const submit = async () => {
    if (!selection || busy || selection.action === "correct" && !content.trim()) return;
    const expectedScope = scopeKey, { item, action } = selection;
    const corrected = action === "correct" ? content : undefined;
    const reviewedAssertion = action === "forget" ? undefined : assertion;
    const requestKey = changeRequest(JSON.stringify({ scopeKey, id: item.id, revision: item.revision, action, content: corrected, assertion: reviewedAssertion }));
    setBusy(true); setError(null);
    try {
      await mutate(item.id, { expectedRevision: item.revision, action, ...(corrected !== undefined ? { content: corrected } : {}), ...(reviewedAssertion ? { assertion: reviewedAssertion } : {}), requestKey });
      if (currentScope.current !== expectedScope || !visible.current) return;
      setSelection(null); request.current = null; setNotice(action === "forget" ? "Memory forgotten" : action === "accept" ? "Memory accepted" : "Memory corrected");
      await refresh();
    } catch (failure) {
      if (currentScope.current === expectedScope && visible.current) {
        await refresh();
        if (currentScope.current === expectedScope && visible.current) setError(failure instanceof Error ? failure.message : "Memory could not be updated");
      }
    }
    finally { if (currentScope.current === expectedScope) setBusy(false); }
  };
  const configure = async (value: boolean) => {
    if (!onEnabledChange || busy) return;
    const expectedScope = scopeKey, requestKey = changeRequest(JSON.stringify({ scopeKey, enabled: value }));
    setBusy(true); setError(null);
    try {
      await onEnabledChange(value, requestKey);
      if (currentScope.current !== expectedScope || !visible.current) return;
      request.current = null; setNotice(value ? "Memory enabled" : "Memory disabled"); await refresh();
    } catch (failure) { if (currentScope.current === expectedScope) setError(failure instanceof Error ? failure.message : "Memory setting could not be saved"); }
    finally { if (currentScope.current === expectedScope) setBusy(false); }
  };
  const title = scopeMatches&&selection ? selection.action === "forget" ? "Forget memory?" : selection.action === "accept" ? "Accept memory?" : "Correct memory" : "Memory";
  return <Dialog open={open} onOpenChange={value => { if (!busy) onOpenChange(value); }}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl"
    onOpenAutoFocus={() => { opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
    onCloseAutoFocus={event => { onCloseAutoFocus?.(event); if (!event.defaultPrevented && opener.current?.isConnected && !opener.current.matches(":disabled")) { event.preventDefault(); opener.current.focus({ preventScroll: true }); } }}
    onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onPointerDownOutside={event => { if (busy) event.preventDefault(); }}>
    <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription className="sr-only">Your agent memory for the selected account and client.</DialogDescription></DialogHeader>
    {!scopeMatches?<div role="status" aria-label="Loading memories" className="h-20 animate-pulse rounded-lg bg-secondary"/>:selection ? <div className="space-y-4">
      {selection.action === "correct" ? <label className="block space-y-2 text-sm"><span>Memory</span><Textarea autoFocus value={content} maxLength={8192} onChange={event => setContent(event.target.value)} disabled={busy} className="min-h-36" /></label> : <p className="whitespace-pre-wrap break-words rounded-lg border bg-secondary/30 p-4 text-sm leading-6 [overflow-wrap:anywhere]">{selection.item.content}</p>}
      {selection.action !== "forget" ? <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2"><label className="text-sm" htmlFor={`${assertionId}-context`}>Applies to</label><Select value={assertion.context} onValueChange={value => setAssertion(previous => ({ ...previous, context: value as MemoryAssertion["context"] }))} disabled={busy}><SelectTrigger id={`${assertionId}-context`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="unspecified">Unspecified</SelectItem><SelectItem value="current">Current situation</SelectItem><SelectItem value="hypothetical">Hypothetical scenario</SelectItem></SelectContent></Select></div>
        <div className="space-y-2"><label className="text-sm" htmlFor={`${assertionId}-conflict`}>Conflicts</label><Select value={assertion.conflict} onValueChange={value => setAssertion(previous => ({ ...previous, conflict: value as MemoryAssertion["conflict"] }))} disabled={busy}><SelectTrigger id={`${assertionId}-conflict`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="not_assessed">Not assessed</SelectItem><SelectItem value="reported">Conflict reported</SelectItem><SelectItem value="resolved">Resolved by user</SelectItem></SelectContent></Select></div>
      </div> : null}
      {selection.action === "forget" ? <p className="text-sm text-muted-foreground">Stops future memory recall. Conversation history is separate.</p> : <p className="text-sm text-muted-foreground">Saved as an assertion, not a verified fact.</p>}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => { setSelection(null); setError(null); request.current = null; }}>Cancel</Button><Button type="button" variant={selection.action === "forget" ? "destructive" : "default"} disabled={busy || selection.action === "correct" && !content.trim()} onClick={() => void submit()}>{busy ? "Saving…" : selection.action === "forget" ? "Forget" : selection.action === "accept" ? "Accept" : "Save correction"}</Button></DialogFooter>
    </div> : <div className="space-y-5">
      {enabled !== undefined ? <div className="flex min-h-11 items-center justify-between gap-4"><label htmlFor="agent-memory-enabled" className="text-sm font-medium">Memory</label>{onEnabledChange ? <Switch id="agent-memory-enabled" checked={enabled} disabled={busy} onCheckedChange={value => void configure(value)} aria-label="Enable memory" /> : <span className="text-xs text-muted-foreground">{enabled ? "Enabled" : "Disabled"}</span>}</div> : null}
      {notice ? <p role="status" className="text-sm text-muted-foreground">{notice}</p> : null}
      {error ? <div className="space-y-2"><p role="alert" className="text-sm text-destructive">{error}</p><Button type="button" variant="outline" size="sm" onClick={() => void refresh()} disabled={busy || loading}>Retry</Button></div> : null}
      {loading && !items.length ? <div role="status" aria-label="Loading memories" className="space-y-3">{[0, 1, 2].map(value => <div key={value} className="h-20 animate-pulse rounded-lg bg-secondary motion-reduce:animate-none" />)}</div> : !items.length && !error ? <p className="py-6 text-sm text-muted-foreground">No memories yet</p> : null}
      <div className="space-y-3">{items.map(item => <article key={item.id} className="space-y-3 rounded-lg border p-4"><div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span>{item.status === "candidate" ? "Suggested" : "Accepted"}</span><span>{item.origin === "model_candidate" ? "Agent suggestion" : "User supplied"}</span></div><p className="whitespace-pre-wrap break-words text-sm leading-6 [overflow-wrap:anywhere]">{item.content}</p><div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">{item.assertion?.context === "hypothetical" ? <span>Hypothetical</span> : item.assertion?.context === "current" ? <span>Current situation</span> : null}{item.assertion?.conflict === "reported" ? <span className="text-destructive">Conflict reported</span> : item.assertion?.conflict === "resolved" ? <span>Resolved by user</span> : null}{item.updatedAt ? <time dateTime={item.updatedAt}>Updated {new Date(item.updatedAt).toLocaleDateString()}</time> : null}{item.expiresAt ? <time dateTime={item.expiresAt}>Expires {new Date(item.expiresAt).toLocaleDateString()}</time> : null}</div><div className="flex flex-wrap justify-end gap-2">{item.status === "candidate" ? <Button type="button" size="sm" onClick={() => choose(item, "accept")} disabled={busy || enabled === false}>Review</Button> : <Button type="button" size="sm" variant="outline" onClick={() => choose(item, "correct")} disabled={busy}>Correct</Button>}<Button type="button" size="sm" variant="ghost" onClick={() => choose(item, "forget")} disabled={busy}>Forget</Button></div></article>)}</div>
      {nextOffset !== null ? <Button type="button" variant="outline" disabled={loading || busy} onClick={() => void refresh(nextOffset)}>{loading ? "Loading…" : "Load more"}</Button> : null}
    </div>}
  </DialogContent></Dialog>;
}
