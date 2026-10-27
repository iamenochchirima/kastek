import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { UserGroupIcon } from "@hugeicons/core-free-icons";
import { Button } from "@/components/ui/button";
import type { InboxConversation } from "./inbox";
import "./inbox-handoff.css";

type Action = "claim" | "assign" | "unassign" | "takeover" | "resolve" | "reopen" | "return";
type Member = { id: string; displayName: string };

export function inboxAssigneeName(id: string | null, members: Member[]) {
  return id ? members.find(member => member.id === id)?.displayName ?? "Unknown teammate" : "Unassigned";
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
  const { state, assigneeAccountId } = conversation;
  const mine = assigneeAccountId === accountId;
  const disabled = busy || pending;
  const name = inboxAssigneeName(assigneeAccountId, members);
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
      {owner ? <div className="inbox-handoff-assign"><select aria-label="Assign conversation" className="task-filter" value={assignee} disabled={disabled} onChange={event => setAssignee(event.target.value)}><option value="">Select teammate</option>{members.map(member => <option key={member.id} value={member.id}>{member.displayName}</option>)}</select><Button size="sm" variant="outline" disabled={!assignee || disabled} onClick={() => onCommand("assign", { assigneeAccountId: assignee })}>Assign</Button></div> : null}
    </div>
  </section>;
}
