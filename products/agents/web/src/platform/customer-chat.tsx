import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError, message, readStored, writeStored } from "./api";
import { CustomerMessages, HistoryNavigation, type CustomerTimeline, type InboxConversation } from "./inbox";
import { ErrorMessage } from "./shell";

export function CustomerChat({ path, token, deploymentId }: { path: string; token: string; deploymentId: string }) {
  const [timeline, setTimeline] = useState<CustomerTimeline | null>(null), [body, setBody] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [notifications, setNotifications] = useState(false), [notificationBusy, setNotificationBusy] = useState(false);
  const readSequence = useRef("");
  const key = `agents.customer.pending.${deploymentId}.${token}`, [pending, setPending] = useState<{ requestKey: string; body: string } | null>(() => readStored(key));
  const conversation = useRef<string | null>(null), generation = useRef(0), requestSequence = useRef(0);
  const [before, setBefore] = useState<string | null>(null), pageRef = useRef(before); pageRef.current = before;
  function historyPage(value: string | null) { pageRef.current = value; requestSequence.current++; setTimeline(null); setBefore(value); }
  async function refresh(id: string) {
    const expectedPage = pageRef.current, expectedGeneration = generation.current, request = ++requestSequence.current;
    const current = () => conversation.current === id && generation.current === expectedGeneration && pageRef.current === expectedPage && requestSequence.current === request;
    try {
      const result = await api<CustomerTimeline>(`${path}/customer-conversations/${id}/messages?limit=100${expectedPage ? `&before=${expectedPage}` : ""}`, undefined, "GET", token);
      if (current()) setTimeline(result);
    } catch (error) { if (current()) { setTimeline(null); throw error; } }
  }
  useEffect(() => { let live = true; generation.current++; conversation.current = null; pageRef.current = null; setBefore(null); setTimeline(null);
    setNotifications(false); setInitialized(false); readSequence.current = "";
    api<{ conversation: InboxConversation | null }>(`${path}/customer-conversations`, {}, "POST", token).then(async result => { if (!live) return; setInitialized(true); if (!result.conversation) return; conversation.current = result.conversation.id; void api<{state:string}>(`${path}/customer-conversations/${result.conversation.id}/followup`,undefined,"GET",token).then(value=>{if(live)setNotifications(value.state==="verified")}).catch(()=>{}); await refresh(result.conversation.id); }).catch(e => { if (live) setError(message(e)); });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Invalidate requests from the old visitor session.
    return () => { live = false; generation.current++; conversation.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, token]);
  useEffect(() => {
    let live = true, refreshing = false;
    const poll = () => { if (!conversation.current || refreshing) return; refreshing = true; void refresh(conversation.current).catch(e => { if (live) setError(message(e)); }).finally(() => { refreshing = false; }); };
    poll(); const timer = window.setInterval(poll, 1500);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Invalidate requests from the old history page.
    return () => { live = false; requestSequence.current++; window.clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, token, before]);
  useEffect(() => {
    const id = conversation.current, sequence = timeline?.messages.at(-1)?.sequence;
    if (!notifications || !id || !sequence || before !== null || document.visibilityState !== "visible" || readSequence.current === sequence) return;
    readSequence.current = sequence;
    void api(`${path}/customer-conversations/${id}/followup/read`,{sequence},"POST",token).catch(()=>{if(readSequence.current===sequence)readSequence.current=""});
  }, [timeline,notifications,before,path,token]);
  async function stopNotifications() {
    if (!conversation.current || notificationBusy) return;
    setNotificationBusy(true); setError("");
    try { await api(`${path}/customer-conversations/${conversation.current}/followup/revoke`,{},"POST",token); setNotifications(false); }
    catch (e) { setError(message(e)); } finally { setNotificationBusy(false); }
  }
  async function send(event?: FormEvent) { event?.preventDefault(); if (!initialized || busy) return; const id = conversation.current, acceptedGeneration = generation.current, input = pending ?? { requestKey: crypto.randomUUID(), body: body.trim() }; if (!input.body) return;
    let activeId = id; const current = () => generation.current === acceptedGeneration && conversation.current === activeId;
    setPending(input); writeStored(key, input); setBusy(true); setError("");
    try { const result = await api<{conversation: InboxConversation}>(id ? `${path}/customer-conversations/${id}/messages` : `${path}/customer-conversations/messages`, input, "POST", token); if (!current()) return; activeId = result.conversation.id; conversation.current = activeId; setPending(null); writeStored(key, null); setBody(""); await refresh(activeId); }
    catch (e) { if (!current()) return; setError(message(e)); if (e instanceof ApiError && e.status < 500) { setPending(null); writeStored(key, null); setBody(input.body); } }
    finally { if (generation.current === acceptedGeneration) setBusy(false); }
  }
  return <section className="space-y-4"><p className="text-xs text-muted-foreground" role="status">{timeline?.conversation.state === "human_owned" ? "With support" : timeline?.conversation.state === "handoff_pending" ? "Waiting for support" : timeline?.conversation.state === "resolved" ? "Conversation resolved" : "Assistant"}</p>{notifications ? <Button variant="outline" size="sm" disabled={notificationBusy} onClick={() => void stopNotifications()}>{notificationBusy ? "Turning off…" : "Turn off email notifications"}</Button> : null}<ErrorMessage value={error} /><HistoryNavigation timeline={timeline} earlier={!!timeline?.earlierBefore} latest={before === null} onEarlier={() => historyPage(timeline?.earlierBefore ?? null)} onLatest={() => historyPage(null)} /><CustomerMessages messages={timeline?.messages ?? []} /><form onSubmit={event => void send(event)} className="space-y-3"><label className="block space-y-2 text-sm"><span>Message</span><Textarea rows={3} maxLength={8000} value={pending?.body ?? body} onChange={event => setBody(event.target.value)} disabled={busy || !!pending || timeline?.conversation.state === "resolved"} /></label><Button type="submit" disabled={!initialized || busy || (!pending && !body.trim()) || timeline?.conversation.state === "resolved"}>{busy ? "Sending…" : pending ? "Retry message" : "Send message"}</Button></form></section>;
}
