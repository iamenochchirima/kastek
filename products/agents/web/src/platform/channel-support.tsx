import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, ApiError, message, organizationPath, readStored, writeStored } from "./api";
import { ErrorMessage } from "./shell";
import type { CustomerMessage } from "./inbox";

type Category = "UTILITY" | "MARKETING" | "AUTHENTICATION";
type Template = { id: string; name: string; language: string; category: Category; status: string; supported: boolean; components: { type?: unknown; format?: unknown; text?: unknown }[] };
type Consent = { revision: number; granted: boolean; categories: Category[] };
export interface ChannelSupportProps {
  orgId: string;
  conversation: { id: string; channel: string; state: string; revision: string; assigneeAccountId: string | null; channelAvailable?: boolean };
  accountId: string;
  messages: CustomerMessage[];
  onChanged(): Promise<void> | void;
}
function layout(template: Template | undefined) {
  const counts = { header: 0, body: 0 }, seen = new Set<string>();
  if (!template?.supported || template.status !== "APPROVED") return null;
  for (const part of template.components) {
    const type = String(part.type).toUpperCase();
    if (!["HEADER", "BODY", "FOOTER"].includes(type) || seen.has(type) || typeof part.text !== "string" || type === "HEADER" && part.format !== "TEXT") return null;
    seen.add(type); const slots = [...part.text.matchAll(/\{\{(\d+)\}\}/g)].map(match => Number(match[1])), count = slots.length ? Math.max(...slots) : 0;
    if (count > 32 || new Set(slots).size !== count || slots.some(slot => slot < 1) || /\{\{|\}\}/.test(part.text.replace(/\{\{\d+\}\}/g, "")) || type === "FOOTER" && count) return null;
    if (type === "HEADER") counts.header = count; if (type === "BODY") counts.body = count;
  }
  return seen.has("BODY") ? counts : null;
}
export function ChannelSupport(props: ChannelSupportProps) {
  // Scope state synchronously when a caller changes the selected conversation.
  return <ScopedChannelSupport key={`${props.orgId}:${props.conversation.id}:${props.accountId}`} {...props} />;
}
function ScopedChannelSupport({ orgId, conversation, accountId, messages, onChanged }: ChannelSupportProps) {
  const base = `${organizationPath(orgId)}/inbox/${encodeURIComponent(conversation.id)}`, whatsapp = conversation.channel === "whatsapp";
  const assigned = conversation.state === "human_owned" && conversation.assigneeAccountId === accountId;
  const pendingKey = `agents.channel-template.${accountId}.${orgId}.${conversation.id}`;
  const pendingTemplate = useRef<{ digest: string; commandId: string; expectedRevision: string } | null>(readStored(pendingKey));
  let restored: [string, string[], string[]] | null = null;
  try { const value = JSON.parse(pendingTemplate.current?.digest ?? "null"); if (Array.isArray(value) && value.length === 3 && typeof value[0] === "string" && value.slice(1).every(list => Array.isArray(list) && list.length <= 32 && list.every(item => typeof item === "string" && item.length <= 4096))) restored = value as [string,string[],string[]]; } catch { /* Invalid local drafts cannot authorize a send. */ }
  const [templates, setTemplates] = useState<Template[]>([]), [cursor, setCursor] = useState<string | null>(null), [consent, setConsent] = useState<Consent | null>(null);
  const [selected, setSelected] = useState(restored?.[0] ?? ""), [header, setHeader] = useState<string[]>(restored?.[1] ?? []), [body, setBody] = useState<string[]>(restored?.[2] ?? []);
  const [granted, setGranted] = useState(""), [categories, setCategories] = useState<Category[]>([]), [evidence, setEvidence] = useState("");
  const [source, setSource] = useState("customer_message"), [reference, setReference] = useState("");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [loading, setLoading] = useState(false);
  const [confirmDelivery, setConfirmDelivery] = useState<string | null>(null), [continued, setContinued] = useState<string[]>([]);
  const live = useRef(true), action = useRef(false), generation = useRef(0);
  const current = useRef(conversation); current.current = conversation;
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    if (!whatsapp) return; let stopped = false; setLoading(true); setError("");
    Promise.allSettled([api<{ templates: Template[]; nextCursor: string | null }>(`${base}/whatsapp/templates`), api<Consent>(`${base}/whatsapp/consent`)]).then(([page, record]) => {
      if (stopped) return;
      if (page.status === "fulfilled") { setTemplates(page.value.templates); setCursor(page.value.nextCursor); }
      else { setTemplates([]); setCursor(null); setError(message(page.reason)); }
      if (record.status === "fulfilled") setConsent(record.value);
      else { setConsent(null); setError(message(record.reason)); }
    }).finally(() => { if (!stopped) setLoading(false); });
    return () => { stopped = true; };
  }, [base, whatsapp, conversation.revision]);
  useEffect(() => { generation.current++; setConfirmDelivery(null); }, [conversation.revision, conversation.assigneeAccountId, conversation.state]);
  const template = templates.find(item => item.id === selected), fields = layout(template);
  const values = { header, body };
  const preview = fields && template ? template.components.map(part => {
    const type = String(part.type).toLowerCase(), list = type === "header" ? header : type === "body" ? body : [];
    return String(part.text).replace(/\{\{(\d+)\}\}/g, (placeholder, index) => list[Number(index) - 1] || placeholder);
  }).join("\n\n") : "";
  const complete = fields && header.length === fields.header && body.length === fields.body && [...header, ...body].every(value => value.trim().length > 0 && value.length <= 4096);
  const allowed = Boolean(template && consent?.granted && consent.categories.includes(template.category));
  async function run(work: () => Promise<void>) {
    if (action.current) return; action.current = true; setBusy(true); setError("");
    try { await work(); } catch (e) { if (live.current) setError(message(e)); }
    finally { action.current = false; if (live.current) setBusy(false); }
  }
  async function more() { await run(async () => { if (!cursor) return; const page = await api<{ templates: Template[]; nextCursor: string | null }>(`${base}/whatsapp/templates?cursor=${encodeURIComponent(cursor)}`); if (live.current) { setTemplates(old => [...new Map([...old, ...page.templates].map(item => [item.id, item])).values()]); setCursor(page.nextCursor); } }); }
  async function send(event: FormEvent) { event.preventDefault(); if (!assigned || !complete || !allowed || !template) return;
    const digest = JSON.stringify([selected, header, body]);
    if (pendingTemplate.current && pendingTemplate.current.digest !== digest) { setError("A template reply is awaiting acknowledgement. Check the conversation before sending another template."); return; }
    if (conversation.channelAvailable === false && !pendingTemplate.current) return;
    const expectedRevision = pendingTemplate.current?.expectedRevision ?? conversation.revision;
    const commandId = pendingTemplate.current?.digest === digest ? pendingTemplate.current.commandId : crypto.randomUUID(); pendingTemplate.current = { digest, commandId, expectedRevision }; writeStored(pendingKey, pendingTemplate.current);
    await run(async () => { try { await api(`${base}/whatsapp/template-reply`, { commandId, expectedRevision, templateId: selected, parameters: values }); } catch (error) { if (error instanceof ApiError && error.status < 500) { pendingTemplate.current = null; writeStored(pendingKey, null); } throw error; } pendingTemplate.current = null; writeStored(pendingKey, null); if (live.current) { setSelected(""); setHeader([]); setBody([]); await onChanged(); } });
  }
  async function retryTemplate() {
    const pending = pendingTemplate.current;
    if (!pending || !restored || action.current) return;
    const [templateId, savedHeader, savedBody] = restored;
    await run(async () => {
      try { await api(`${base}/whatsapp/template-reply`, { commandId: pending.commandId, expectedRevision: pending.expectedRevision, templateId, parameters: { header: savedHeader, body: savedBody } }); }
      catch (error) { if (error instanceof ApiError && error.status < 500) { pendingTemplate.current = null; writeStored(pendingKey, null); } throw error; }
      pendingTemplate.current = null; writeStored(pendingKey, null);
      if (live.current) { setSelected(""); setHeader([]); setBody([]); await onChanged(); }
    });
  }
  async function record(event: FormEvent) { event.preventDefault(); if (!assigned || !consent || !granted || !categories.length || source === "customer_message" && !evidence || source === "external_record" && !reference.trim()) return;
    await run(async () => { const saved = await api<Consent>(`${base}/whatsapp/consent`, { expectedRevision: conversation.revision, expectedConsentRevision: consent!.revision, granted: granted === "yes", categories, evidence: source === "customer_message" ? { kind: source, messageId: evidence } : { kind: source, reference: reference.trim() } });
      if (live.current) { setConsent(saved); setGranted(""); setCategories([]); setEvidence(""); setReference(""); await onChanged(); } });
  }
  async function recover(id: string) { const snapshot = generation.current, revision = current.current.revision;
    if (current.current.state !== "human_owned" || current.current.assigneeAccountId !== accountId) return;
    await run(async () => { if (snapshot !== generation.current) return; await api(`${base}/deliveries/${encodeURIComponent(id)}/continue`, { expectedRevision: revision, decision: "continue_without_resending" }); if (live.current) { setContinued(old => [...old, id]); setConfirmDelivery(null); await onChanged(); } });
  }
  const pendingMediaKey=`agents.channel-media.${accountId}.${orgId}.${conversation.id}`;
  const pendingMedia=useRef<{sourceMessageId:string;index:number;commandId:string;expectedRevision:string}|null>(readStored(pendingMediaKey));
  async function sendMedia(sourceMessageId:string,index:number){
    if(!assigned||action.current)return;
    if(conversation.channelAvailable===false&&!pendingMedia.current)return;
    const command=pendingMedia.current??{sourceMessageId,index,commandId:crypto.randomUUID(),expectedRevision:conversation.revision};
    if(command.sourceMessageId!==sourceMessageId||command.index!==index){setError("Check the pending attachment reply before sending another.");return;}
    pendingMedia.current=command;writeStored(pendingMediaKey,command);
    await run(async()=>{try{await api(`${base}/media-reply`,command);}catch(error){if(error instanceof ApiError&&error.status<500){pendingMedia.current=null;writeStored(pendingMediaKey,null);}throw error;}
      pendingMedia.current=null;writeStored(pendingMediaKey,null);if(live.current)await onChanged();});
  }
  const attachments = messages.flatMap(item => (item.channelFacts?.attachments ?? []).map(attachment => ({ messageId: item.id, ...attachment })));
  const unknown = messages.flatMap(item => (item.deliveries ?? []).filter(delivery => delivery.state === "unknown"));
  if (!whatsapp && !attachments.length && !unknown.length) return null;
  return <section aria-label="Channel support" className="min-w-0 space-y-4 border-t border-border pt-4"><ErrorMessage value={error} />
    {attachments.length ? <details><summary className="cursor-pointer text-sm font-medium">Attachments</summary><ul className="mt-2 space-y-2 text-sm">{pendingMedia.current ? <li className="text-muted-foreground">An attachment reply awaits acknowledgement. Retry the same attachment to check its outcome.</li> : null}{attachments.map(attachment => <li key={`${attachment.messageId}:${attachment.index}`}><a className="break-words underline underline-offset-4" target="_blank" rel="noreferrer" href={`${base}/messages/${encodeURIComponent(attachment.messageId)}/attachments/${attachment.index}`}>{attachment.fileName || `${attachment.kind} attachment`}</a>{assigned&&!(conversation.channel==="instagram"&&attachment.kind==="document")?<Button size="sm" variant="ghost" disabled={busy || (conversation.channelAvailable===false && !(pendingMedia.current?.sourceMessageId===attachment.messageId && pendingMedia.current.index===attachment.index))} onClick={()=>void sendMedia(attachment.messageId,attachment.index)}>Reply with attachment</Button>:null}</li>)}</ul></details> : null}
    {unknown.map(delivery => <div key={delivery.id} className="space-y-2 rounded-md border border-border p-3 text-sm"><p>Delivery outcome unknown. Check the provider before continuing.</p>{continued.includes(delivery.id) ? <p role="status">Later messages can continue. This message remains unknown.</p> : assigned ? confirmDelivery === delivery.id ? <div role="group" aria-label="Confirm delivery recovery" className="space-y-2"><p>This will allow later messages through. It will not resend this message or mark it delivered.</p><div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy} onClick={() => void recover(delivery.id)}>Continue without resending</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmDelivery(null)}>Cancel</Button></div></div> : <Button size="sm" variant="outline" disabled={busy} onClick={() => setConfirmDelivery(delivery.id)}>Review unknown delivery</Button> : <p className="text-muted-foreground">The assigned support person can decide whether to continue.</p>}</div>)}
    {whatsapp ? <><details><summary className="cursor-pointer text-sm font-medium">WhatsApp template reply</summary>{loading ? <p role="status" className="mt-3 text-sm">Loading templates…</p> : null}<form onSubmit={send} className="mt-3 space-y-3">{pendingTemplate.current ? <><p className="text-sm text-muted-foreground">A template reply awaits acknowledgement. Retry the saved reply to check its outcome.</p>{conversation.channelAvailable === false && restored ? <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void retryTemplate()}>Retry pending template</Button> : null}</> : null}<label className="block space-y-2 text-sm">Approved template<select className="w-full min-w-0 rounded-md border border-border bg-background p-2" value={selected} disabled={busy || loading} onChange={event => { const next=templates.find(item=>item.id===event.target.value), slots=layout(next); setSelected(event.target.value); setHeader(Array(slots?.header ?? 0).fill("")); setBody(Array(slots?.body ?? 0).fill("")); }}><option value="">Choose a template</option>{templates.map(item => <option key={item.id} value={item.id} disabled={!layout(item)}>{item.name} · {item.language}{!layout(item) ? " · Unsupported format" : ""}</option>)}</select></label>{cursor ? <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void more()}>More templates</Button> : null}
      {fields ? <>{(["header", "body"] as const).flatMap(section => Array.from({length:fields[section]},(_,index) => <label key={`${section}:${index}`} className="block space-y-2 text-sm">{section === "header" ? "Header" : "Body"} value {index+1}<Input required maxLength={4096} value={values[section][index] || ""} disabled={!assigned || busy} onChange={event => { const next=[...values[section]];next[index]=event.target.value;(section === "header" ? setHeader : setBody)(next); }} /></label>))}<div aria-label="Template preview" className="whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-sm [overflow-wrap:anywhere]">{preview}</div>{!allowed ? <p className="text-sm text-muted-foreground">Recorded customer opt-in for this template category is required.</p> : null}<Button type="submit" disabled={busy || loading || !assigned || !complete || !allowed || (conversation.channelAvailable === false && !pendingTemplate.current)}>Send template</Button></> : null}{!assigned ? <p className="text-sm text-muted-foreground">Take over and assign this conversation to yourself to send.</p> : null}</form></details>
      <details><summary className="cursor-pointer text-sm font-medium">Customer opt-in</summary><p className="mt-3 text-sm">{consent?.granted ? `Recorded for ${consent.categories.join(", ").toLowerCase()}.` : "No active opt-in recorded."}</p><form onSubmit={record} className="mt-3 space-y-3"><p className="text-sm text-muted-foreground">Record an actual customer decision with its evidence. Connecting a channel does not create opt-in.</p><label className="block space-y-2 text-sm">Customer decision<select required className="w-full rounded-md border border-border bg-background p-2" value={granted} disabled={!assigned || busy || !consent} onChange={event=>setGranted(event.target.value)}><option value="">Choose a decision</option><option value="yes">Customer opted in</option><option value="no">Customer opted out</option></select></label><fieldset disabled={!assigned || busy}><legend className="mb-2 text-sm">Message categories</legend><div className="flex flex-wrap gap-3">{(["UTILITY","MARKETING","AUTHENTICATION"] as const).map(category=><label key={category} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={categories.includes(category)} onChange={event=>setCategories(old=>event.target.checked?[...old,category]:old.filter(item=>item!==category))} />{category.charAt(0)+category.slice(1).toLowerCase()}</label>)}</div></fieldset><label className="block space-y-2 text-sm">Evidence source<select className="w-full rounded-md border border-border bg-background p-2" disabled={!assigned || busy} value={source} onChange={event=>setSource(event.target.value)}><option value="customer_message">Customer message</option><option value="external_record">External record</option></select></label>{source === "customer_message" ? <label className="block space-y-2 text-sm">Customer message<select aria-label="Customer message" required className="w-full min-w-0 rounded-md border border-border bg-background p-2" disabled={!assigned || busy} value={evidence} onChange={event=>setEvidence(event.target.value)}><option value="">Choose evidence</option>{messages.filter(item=>item.authorKind === "visitor").map(item=><option key={item.id} value={item.id}>{item.body.slice(0,120)}</option>)}</select></label> : <label className="block space-y-2 text-sm">Record reference<Input required maxLength={2048} value={reference} disabled={!assigned || busy} onChange={event=>setReference(event.target.value)} /></label>}<Button type="submit" disabled={busy || !assigned || !consent || !granted || !categories.length || (source === "customer_message" ? !evidence : !reference.trim())}>Record decision</Button></form></details></> : null}
  </section>;
}
