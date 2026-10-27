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

export function InboxHandoff({ conversation, accountId, owner, members, busy, pending, onCommand }: {
  conversation: InboxConversation;
  accountId: string;
  owner: boolean;
  members: Member[];
  busy: boolean;
  pending: boolean;
  onCommand(action: Action, extra?: { assigneeAccountId: string }): void;
}) {
  const [assignee, setAssignee] = useState("");
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

  return <section className={`inbox-handoff inbox-handoff--${state}`} aria-label="Conversation ownership">
    <div className="inbox-handoff-summary"><span className="inbox-handoff-icon" aria-hidden="true"><HugeiconsIcon icon={UserGroupIcon} size={18} /></span><div><h3>{title}</h3><p>{detail}</p></div></div>
    <div className="inbox-handoff-actions">
      {!assigneeAccountId ? <Button size="sm" variant="outline" disabled={disabled} onClick={() => onCommand("claim")}>Assign to me</Button> : null}
      {mine && state !== "human_owned" && state !== "resolved" ? <Button size="sm" disabled={disabled} onClick={() => onCommand("takeover")}>Take over</Button> : null}
      {mine && (state === "human_owned" || state === "handoff_pending") ? <Button size="sm" variant="outline" disabled={disabled} onClick={() => onCommand("return")}>Return to automation</Button> : null}
      {mine && state !== "resolved" ? <Button size="sm" variant="outline" disabled={disabled} onClick={() => onCommand("resolve")}>Resolve</Button> : null}
      {mine && state === "resolved" ? <Button size="sm" variant="outline" disabled={disabled} onClick={() => onCommand("reopen")}>Reopen</Button> : null}
      {(owner || mine) && assigneeAccountId ? <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onCommand("unassign")}>Unassign</Button> : null}
      {owner ? <details className="inbox-handoff-assignment"><summary>Assign teammate</summary><div className="inbox-handoff-assign"><input aria-label="Search teammates" className="task-filter" placeholder="Search teammates" value={query} onChange={event=>setQuery(event.target.value)} /><select aria-label="Assign conversation" className="task-filter" value={assignee} disabled={disabled || loading} onChange={event => setAssignee(event.target.value)}><option value="">Select teammate</option>{options.map(member => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select><Button size="sm" variant="outline" disabled={!assignee || disabled} onClick={() => onCommand("assign", { assigneeAccountId: assignee })}>Assign</Button>{cursor ? <Button size="sm" variant="ghost" disabled={loading} onClick={()=>void loadMore()}>More teammates</Button>:null}{loading ? <span role="status">Loading teammates…</span>:null}{loadError ? <><span role="alert">{loadError}</span><Button size="sm" variant="ghost" onClick={()=>cursor ? void loadMore() : setRetry(value=>value+1)}>Retry</Button></>:null}</div></details> : null}
    </div>
  </section>;
}
