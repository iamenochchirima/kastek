import { useEffect, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { UserGroupIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import type { InboxConversation } from "./inbox";
import { api, message, organizationPath } from "./api";
import { useWorkspace } from "./shell";
import "./inbox-handoff.css";

type Action = "claim" | "assign" | "unassign" | "takeover" | "resolve" | "reopen" | "return";
type Member = { id: string; displayName: string };

export function inboxAssigneeName(id: string | null, members: Member[], displayName?: string | null) {
  return id ? displayName ?? members.find(member => member.id === id)?.displayName ?? "Unknown teammate" : "Unassigned";
}

export async function focusAfterHandoff(action: string, origin: HTMLElement, operation: () => Promise<boolean>, getSection: () => HTMLElement | null) {
  const startedFocused = document.activeElement === origin;
  let movedElsewhere = false;
  const observeFocus = (event: FocusEvent) => {
    if (event.target !== origin && event.target !== document.body) movedElsewhere = true;
  };
  document.addEventListener("focusin", observeFocus);
  try {
    const succeeded = await operation();
    if (!succeeded || !startedFocused) return;
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const section = getSection();
    if (movedElsewhere || !section || (document.activeElement !== origin && document.activeElement !== document.body)) return;
    const control = (name: string) => section.querySelector<HTMLElement>(`[data-handoff-focus="${name}"]`);
    const target = action === "takeover" || action === "reopen" || action === "reply" ? document.getElementById("inbox-reply")
      : action === "resolve" ? control("reopen")
      : action === "unassign" ? control("claim")
      : action === "assign" ? control("assignment")
      : control("takeover") || control("reopen");
    const destination = target || control("summary");
    if (destination instanceof HTMLButtonElement || destination instanceof HTMLTextAreaElement) {
      if (destination.disabled) await new Promise<void>(resolve => {
        const observer = new MutationObserver(() => { if (!destination.disabled) { observer.disconnect(); clearTimeout(timeout); resolve(); } });
        const timeout = window.setTimeout(() => { observer.disconnect(); resolve(); }, 1000);
        observer.observe(destination, { attributes: true, attributeFilter: ["disabled"] });
        if (!destination.disabled) { observer.disconnect(); clearTimeout(timeout); resolve(); }
      });
    }
    if (!movedElsewhere && getSection() === section && (document.activeElement === origin || document.activeElement === document.body)) destination?.focus();
  } finally { document.removeEventListener("focusin", observeFocus); }
}

export function InboxHandoff({ conversation, accountId, owner, members, busy, pending, onCommand }: {
  conversation: InboxConversation;
  accountId: string;
  owner: boolean;
  members: Member[];
  busy: boolean;
  pending: boolean;
  onCommand(action: Action, extra?: { assigneeAccountId: string }): Promise<boolean>;
}) {
  const [assignee, setAssignee] = useState("");
  const section = useRef<HTMLElement>(null);
  function moveAfterCommand(action: Action, origin: HTMLElement, extra?: { assigneeAccountId: string }) {
    return focusAfterHandoff(action, origin, () => onCommand(action, extra), () => section.current);
  }
  const { organizationId } = useWorkspace();
  const [query, setQuery] = useState(""), [search, setSearch] = useState("");
  const [options, setOptions] = useState<Member[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false), [loadError, setLoadError] = useState("");
  const [retry, setRetry] = useState(0), generation = useRef(0);
  useEffect(() => { const timer=window.setTimeout(()=>setSearch(query.trim()),250); return ()=>window.clearTimeout(timer); },[query]);
  useEffect(() => {
    if (!owner) return;
    let live=true; const requestGeneration=generation; requestGeneration.current++; setLoading(true); setLoadError(""); setOptions([]); setCursor(null); setAssignee("");
    const path=`${organizationPath(organizationId)}/inbox/members?limit=50&search=${encodeURIComponent(search)}`;
    api<{members:Member[];nextCursor:string|null}>(path).then(result=>{if(live){setOptions(result.members);setCursor(result.nextCursor);}}).catch(error=>{if(live)setLoadError(message(error));}).finally(()=>{if(live)setLoading(false);});
    return ()=>{live=false;requestGeneration.current++;};
  },[organizationId,owner,search,retry]);
  async function loadMore() {
    if(!cursor || loading)return;
    const currentSearch=search, currentGeneration=generation.current;
    setLoading(true);setLoadError("");
    try {
      const path=`${organizationPath(organizationId)}/inbox/members?limit=50&search=${encodeURIComponent(currentSearch)}&cursor=${encodeURIComponent(cursor)}`;
      const result=await api<{members:Member[];nextCursor:string|null}>(path);
      if(generation.current===currentGeneration){setOptions(previous=>[...previous,...result.members.filter(member=>!previous.some(existing=>existing.id===member.id))]);setCursor(result.nextCursor);}
    } catch(error) {if(generation.current===currentGeneration)setLoadError(message(error));} finally {if(generation.current===currentGeneration)setLoading(false);}
  }
  const { state, assigneeAccountId } = conversation;
  const mine = assigneeAccountId === accountId;
  const disabled = busy || pending;
  const name = inboxAssigneeName(assigneeAccountId, members, conversation.assigneeDisplayName);
  const title = state === "handoff_pending" ? "Waiting for a person" : state === "human_owned" ? "Human support" : state === "resolved" ? "Conversation resolved" : "Automation active";
  const detail = state === "human_owned" ? mine ? "Assigned to you" : `Assigned to ${name}` : assigneeAccountId ? mine ? "Assigned to you" : `Assigned to ${name}` : "Unassigned";

  return <section ref={section} className={`inbox-handoff inbox-handoff--${state}`} aria-label="Conversation ownership">
    <div className="inbox-handoff-summary"><span className="inbox-handoff-icon" aria-hidden="true"><HugeiconsIcon icon={UserGroupIcon} size={18} /></span><div><h3 tabIndex={-1} data-handoff-focus="summary">{title}</h3><p>{detail}</p></div></div>
    <div className="inbox-handoff-actions">
      {!assigneeAccountId ? <Button size="sm" variant="outline" disabled={disabled} data-handoff-focus="claim" onClick={event => void moveAfterCommand("claim", event.currentTarget)}>Assign to me</Button> : null}
      {mine && state !== "human_owned" && state !== "resolved" ? <Button size="sm" disabled={disabled} data-handoff-focus="takeover" onClick={event => void moveAfterCommand("takeover", event.currentTarget)}>Take over</Button> : null}
      {mine && (state === "human_owned" || state === "handoff_pending") ? <Button size="sm" variant="outline" disabled={disabled} onClick={event => void moveAfterCommand("return", event.currentTarget)}>Return to automation</Button> : null}
      {mine && state !== "resolved" ? <Button size="sm" variant="outline" disabled={disabled} onClick={event => void moveAfterCommand("resolve", event.currentTarget)}>Resolve</Button> : null}
      {mine && state === "resolved" ? <Button size="sm" variant="outline" disabled={disabled} data-handoff-focus="reopen" onClick={event => void moveAfterCommand("reopen", event.currentTarget)}>Reopen</Button> : null}
      {(owner || mine) && assigneeAccountId ? <Button size="sm" variant="ghost" disabled={disabled} onClick={event => void moveAfterCommand("unassign", event.currentTarget)}>Unassign</Button> : null}
      {owner ? <details className="inbox-handoff-assignment" onKeyDown={event => { if (event.key === "Escape" && event.currentTarget.open) { event.preventDefault(); event.currentTarget.open = false; event.currentTarget.querySelector("summary")?.focus(); } }}><summary data-handoff-focus="assignment">Assign teammate</summary><div className="inbox-handoff-assign"><input aria-label="Search teammates" className="task-filter" placeholder="Search teammates" value={query} onChange={event=>setQuery(event.target.value)} /><select aria-label="Assign conversation" className="task-filter" value={assignee} disabled={disabled || loading} onChange={event => setAssignee(event.target.value)}><option value="">Select teammate</option>{options.map(member => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select><Button size="sm" variant="outline" disabled={!assignee || disabled} onClick={event => void moveAfterCommand("assign", event.currentTarget, { assigneeAccountId: assignee })}>Assign</Button>{cursor ? <Button size="sm" variant="ghost" disabled={loading} onClick={()=>void loadMore()}>More teammates</Button>:null}{loading ? <span role="status">Loading teammates…</span>:null}{loadError ? <><span role="alert">{loadError}</span><Button size="sm" variant="ghost" onClick={()=>cursor ? void loadMore() : setRetry(value=>value+1)}>Retry</Button></>:null}</div></details> : null}
    </div>
  </section>;
}
