import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { api, ApiError, message, readStored, writeStored } from "./api";
import { CustomerMessages, type CustomerTimeline, type InboxConversation } from "./inbox";
import { ErrorMessage } from "./shell";

export function CustomerChat({ path, token, deploymentId }: { path: string; token: string; deploymentId: string }) {
  const [timeline, setTimeline] = useState<CustomerTimeline | null>(null), [body, setBody] = useState(""), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const key = `agents.customer.pending.${deploymentId}.${token}`, [pending, setPending] = useState<{ requestKey: string; body: string } | null>(() => readStored(key));
  const conversation = useRef<string | null>(null);
  async function refresh(id: string) {
    const result = await api<CustomerTimeline>(`${path}/customer-conversations/${id}/messages`, undefined, "GET", token);
    if (conversation.current === id) setTimeline(result);
  }
  useEffect(() => { let live = true, refreshing = false;
    api<{ conversation: InboxConversation }>(`${path}/customer-conversations`, {}, "POST", token).then(async result => { if (!live) return; conversation.current = result.conversation.id; await refresh(result.conversation.id); }).catch(e => { if (live) setError(message(e)); });
    const timer = window.setInterval(() => { if (!conversation.current || refreshing) return; refreshing = true; void refresh(conversation.current).catch(e => { if (live) setError(message(e)); }).finally(() => { refreshing = false; }); }, 1500);
    return () => { live = false; conversation.current = null; window.clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, token]);
  async function send(event?: FormEvent) { event?.preventDefault(); if (!conversation.current || busy) return; const id = conversation.current, input = pending ?? { requestKey: crypto.randomUUID(), body: body.trim() }; if (!input.body) return;
    setPending(input); writeStored(key, input); setBusy(true); setError("");
    try { await api(`${path}/customer-conversations/${id}/messages`, input, "POST", token); setPending(null); writeStored(key, null); setBody(""); await refresh(id); }
    catch (e) { setError(message(e)); if (e instanceof ApiError && e.status < 500) { setPending(null); writeStored(key, null); setBody(input.body); } }
    finally { setBusy(false); }
  }
  return <section className="space-y-4"><p className="text-xs text-muted-foreground" role="status">{timeline?.conversation.state === "human_owned" ? "Connected to support" : timeline?.conversation.state === "handoff_pending" ? "Waiting for support" : timeline?.conversation.state === "resolved" ? "Conversation resolved" : "Assistant"}</p><ErrorMessage value={error} /><CustomerMessages messages={timeline?.messages ?? []} /><form onSubmit={event => void send(event)} className="space-y-3"><label className="block space-y-2 text-sm"><span>Message</span><Textarea rows={3} maxLength={8000} value={pending?.body ?? body} onChange={event => setBody(event.target.value)} disabled={busy || !!pending || timeline?.conversation.state === "resolved"} /></label><Button type="submit" disabled={!timeline || busy || (!pending && !body.trim()) || timeline.conversation.state === "resolved"}>{busy ? "Sending…" : pending ? "Retry message" : "Send message"}</Button></form></section>;
}
