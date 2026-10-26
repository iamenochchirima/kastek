import { useRef, useState } from "react";
import { Building2, Check, Globe, MessageCircle, CalendarDays, UserRoundPlus, Headphones } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, message, organizationPath, type Agent } from "./api";
import { ErrorMessage } from "./shell";
import { WebsiteKnowledgeImport } from "./website-knowledge-import";

const responsibilities = [
  { id: "answer-questions", label: "Answer questions", detail: "Business information and FAQs", icon: MessageCircle },
  { id: "customer-support", label: "Handle support", detail: "Customer requests and human handoff", icon: Headphones },
  { id: "bookings", label: "Book appointments", detail: "Availability and appointment requests", icon: CalendarDays },
  { id: "enquiries", label: "Collect enquiries", detail: "Customer details and service requests", icon: UserRoundPlus },
] as const;
const channels = ["website", "whatsapp", "facebook", "instagram", "telegram"] as const;
const channelNames = { website: "Website widget", whatsapp: "WhatsApp", facebook: "Facebook", instagram: "Instagram", telegram: "Telegram" };
const fields = ["name", "email", "phone", "service", "message"] as const;
type Responsibility = typeof responsibilities[number]["id"];
const inputStyle = "w-full rounded-md border border-border bg-background px-3 py-2 text-sm";

export function GuidedAgentCreation({ open, onOpenChange, organizationId, onCreated, onDraftCreated }: {
  open: boolean; onOpenChange: (open: boolean) => void; organizationId: string; onCreated: (id: string) => void; onDraftCreated: () => void;
}) {
  const [business, setBusiness] = useState({ name: "", website: "", description: "" });
  const [selected, setSelected] = useState<Responsibility[]>(["answer-questions", "customer-support"]);
  const [selectedChannels, setSelectedChannels] = useState<Array<typeof channels[number]>>(["website"]);
  const [intakeFields, setIntakeFields] = useState<Array<typeof fields[number]>>(["name", "email", "message"]);
  const [booking, setBooking] = useState({ durationMinutes: 30, notes: "" });
  const [behaviour, setBehaviour] = useState({ agentName: "", language: "English", tone: "friendly" as "friendly" | "professional" | "concise", handoffInstructions: "" });
  const [step, setStep] = useState(0), [busy, setBusy] = useState(false), [importBusy, setImportBusy] = useState(false), [error, setError] = useState("");
  const [agent, setAgent] = useState<Agent | null>(null), [knowledgeAdded, setKnowledgeAdded] = useState(false);
  const createRequest = useRef<Promise<Agent> | null>(null);
  const needsKnowledge = selected.some(value => value === "answer-questions" || value === "customer-support");
  const steps = ["Business", "Responsibilities", ...(needsKnowledge ? ["Knowledge"] : []), "Channels", "Preferences", "Review"];
  const current = steps[step] ?? "Review";
  const base = organizationPath(organizationId);
  const agentName = behaviour.agentName.trim() || `${business.name.trim()} assistant`.slice(0, 120);
  const setup = () => ({ business, responsibilities: selected, channels: selectedChannels, ...(selected.includes("bookings") ? { booking } : {}), ...(selected.includes("enquiries") ? { intake: { fields: intakeFields } } : {}), behaviour: { ...behaviour, agentName } });
  function toggle<T extends string>(values: T[], value: T, set: (values: T[]) => void) { set(values.includes(value) ? values.filter(item => item !== value) : [...values, value]); }
  async function ensureDraft() {
    if (agent) return agent;
    if (!createRequest.current) createRequest.current = api<{ agent: Agent }>(`${base}/agents`, { name: agentName, offering: "customer-service", setup: setup() }).then(result => { setAgent(result.agent); onDraftCreated(); return result.agent; }).catch(e => { createRequest.current = null; throw e; });
    return createRequest.current;
  }
  function validate() {
    if (current === "Business" && !business.name.trim()) return "Enter your business name.";
    if (current === "Responsibilities" && !selected.length) return "Choose at least one responsibility.";
    if (current === "Preferences" && selected.includes("bookings") && (!Number.isInteger(booking.durationMinutes) || booking.durationMinutes < 5 || booking.durationMinutes > 240)) return "Enter an appointment duration from 5 to 240 minutes.";
    if (current === "Preferences" && (!behaviour.language.trim() || (selected.includes("enquiries") && !intakeFields.length))) return "Choose a language and at least one enquiry field.";
    return "";
  }
  async function next() {
    const invalid = validate(); if (invalid) { setError(invalid); return; }
    setBusy(true); setError("");
    try {
      if (current === "Responsibilities" && needsKnowledge) await ensureDraft();
      setStep(value => value + 1);
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  async function finish() {
    setBusy(true); setError("");
    try {
      const draft = await ensureDraft();
      const fresh = await api<{ agent: Agent }>(`${base}/agents/${draft.id}`);
      await api(`${base}/agents/${draft.id}/configuration`, { name: agentName, setup: setup(), expectedRevision: fresh.agent.draftRevision, configuration: fresh.agent.draft, confirmImpact: true });
      onCreated(draft.id);
      setAgent(null); createRequest.current = null; setStep(0); setBusiness({ name: "", website: "", description: "" }); setBehaviour({ agentName: "", language: "English", tone: "friendly", handoffInstructions: "" }); setKnowledgeAdded(false); setSelected(["answer-questions", "customer-support"]); setSelectedChannels(["website"]); setIntakeFields(["name", "email", "message"]); setBooking({ durationMinutes: 30, notes: "" });
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={value => { if (!busy && !importBusy) onOpenChange(value); }}><DialogContent className="sm:max-w-3xl" showCloseButton={!busy && !importBusy} onInteractOutside={event => { if (busy || importBusy) event.preventDefault(); }} onEscapeKeyDown={event => { if (busy || importBusy) event.preventDefault(); }}>
    <DialogHeader><DialogTitle>Create agent</DialogTitle><DialogDescription className="sr-only">Set up your customer service agent.</DialogDescription></DialogHeader>
    <div className="space-y-2"><div className="flex justify-between text-xs text-muted-foreground"><span>{current}</span><span>Step {step + 1} of {steps.length}</span></div><div className="flex gap-1" aria-label={`Step ${step + 1} of ${steps.length}: ${current}`}>{steps.map((label, index) => <span key={label} className={`h-1 flex-1 rounded-full ${index <= step ? "bg-primary" : "bg-muted"}`} />)}</div></div>
    <section className="min-w-0 space-y-5 py-2" aria-label={current}>
      {current === "Business" ? <><div className="flex items-center gap-2"><Building2 size={20} className="text-primary" /><h2 className="text-xl font-semibold">Your business</h2></div><label className="block space-y-2 text-sm">Business name<Input autoFocus maxLength={120} value={business.name} onChange={e => setBusiness({ ...business, name: e.target.value })} /></label><label className="block space-y-2 text-sm">Website <span className="text-muted-foreground">(optional)</span><Input placeholder="example.com" maxLength={2048} value={business.website} onChange={e => setBusiness({ ...business, website: e.target.value })} /></label><label className="block space-y-2 text-sm">Business description <span className="text-muted-foreground">(optional)</span><textarea className={inputStyle} rows={3} maxLength={1500} value={business.description} onChange={e => setBusiness({ ...business, description: e.target.value })} /></label></> : null}
      {current === "Responsibilities" ? <><h2 className="text-xl font-semibold">What should it do?</h2><div className="grid gap-3 sm:grid-cols-2">{responsibilities.map(({ id, label, detail, icon: Icon }) => <label key={id} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 ${selected.includes(id) ? "border-primary bg-primary/5" : "border-border"}`}><Icon size={20} className="mt-0.5 shrink-0 text-primary" /><span className="min-w-0 flex-1"><span className="block text-sm font-medium">{label}</span><span className="mt-1 block text-xs text-muted-foreground">{detail}</span></span><input className="mt-1 size-4 shrink-0 accent-primary" type="checkbox" checked={selected.includes(id)} onChange={() => toggle(selected, id, setSelected)} /></label>)}</div></> : null}
      {current === "Knowledge" && agent ? <><h2 className="text-xl font-semibold">Business knowledge</h2><WebsiteKnowledgeImport organizationId={organizationId} agentId={agent.id} initialUrl={business.website} onBusyChange={setImportBusy} onComplete={() => setKnowledgeAdded(true)} /><p className="text-xs text-muted-foreground">Documents and other information can be added later.</p></> : null}
      {current === "Channels" ? <><div className="flex items-center gap-2"><Globe size={20} className="text-primary" /><h2 className="text-xl font-semibold">Where will customers use it?</h2></div><div className="grid gap-2 sm:grid-cols-2">{channels.map(channel => <label key={channel} className={`flex cursor-pointer items-center gap-3 rounded-lg border p-4 text-sm ${selectedChannels.includes(channel) ? "border-primary bg-primary/5" : "border-border"}`}><input type="checkbox" className="size-4 accent-primary" checked={selectedChannels.includes(channel)} onChange={() => toggle(selectedChannels, channel, setSelectedChannels)} />{channelNames[channel]}</label>)}</div><p className="text-xs text-muted-foreground">Connect accounts and install your widget after testing.</p></> : null}
      {current === "Preferences" ? <><h2 className="text-xl font-semibold">Make it yours</h2><div className="grid gap-4 sm:grid-cols-2"><label className="block space-y-2 text-sm">Agent name<Input placeholder={agentName} maxLength={120} value={behaviour.agentName} onChange={e => setBehaviour({ ...behaviour, agentName: e.target.value })} /></label><label className="block space-y-2 text-sm">Language<Input maxLength={80} value={behaviour.language} onChange={e => setBehaviour({ ...behaviour, language: e.target.value })} /></label><label className="block space-y-2 text-sm">Tone<select className={inputStyle} value={behaviour.tone} onChange={e => setBehaviour({ ...behaviour, tone: e.target.value as typeof behaviour.tone })}><option value="friendly">Friendly</option><option value="professional">Professional</option><option value="concise">Concise</option></select></label></div><label className="block space-y-2 text-sm">When should a person help? <span className="text-muted-foreground">(optional)</span><textarea rows={2} className={inputStyle} maxLength={1000} placeholder="For complaints, cancellations or anything the agent cannot resolve" value={behaviour.handoffInstructions} onChange={e => setBehaviour({ ...behaviour, handoffInstructions: e.target.value })} /></label>{selected.includes("bookings") ? <fieldset className="space-y-3 border-t pt-4"><legend className="text-sm font-medium">Appointments</legend><label className="block space-y-2 text-sm">Duration (minutes)<Input type="number" min={5} max={240} value={booking.durationMinutes} onChange={e => setBooking({ ...booking, durationMinutes: Number(e.target.value) })} /></label><label className="block space-y-2 text-sm">Availability and booking rules<textarea rows={2} className={inputStyle} maxLength={1000} value={booking.notes} onChange={e => setBooking({ ...booking, notes: e.target.value })} /></label><p className="text-xs text-muted-foreground">A calendar connection is required before the agent can confirm bookings.</p></fieldset> : null}{selected.includes("enquiries") ? <fieldset className="space-y-3 border-t pt-4"><legend className="text-sm font-medium">Enquiry details</legend><div className="flex flex-wrap gap-x-5 gap-y-3">{fields.map(field => <label key={field} className="flex items-center gap-2 text-sm capitalize"><input type="checkbox" className="size-4 accent-primary" checked={intakeFields.includes(field)} onChange={() => toggle(intakeFields, field, setIntakeFields)} />{field.charAt(0).toUpperCase() + field.slice(1)}</label>)}</div></fieldset> : null}</> : null}
      {current === "Review" ? <><div className="flex items-center gap-2"><Check size={20} className="text-primary" /><h2 className="text-xl font-semibold">Ready to test</h2></div><dl className="divide-y divide-border text-sm">{[["Agent", agentName], ["Business", business.name], ["Responsibilities", responsibilities.filter(item => selected.includes(item.id)).map(item => item.label).join(", ")], ["Knowledge", knowledgeAdded ? "Website knowledge added" : "Add later"], ["Channels", selectedChannels.map(channel => channelNames[channel]).join(", ") || "Choose later"], ["Behaviour", `${behaviour.language} · ${behaviour.tone}`]].map(([label, value]) => <div key={label} className="grid gap-1 py-3 sm:grid-cols-[130px_1fr]"><dt className="text-muted-foreground">{label}</dt><dd className="break-words">{value}</dd></div>)}</dl>{selected.includes("bookings") ? <p className="text-xs text-muted-foreground">Bookings need a connected calendar. Channels still need connecting.</p> : <p className="text-xs text-muted-foreground">Channels still need connecting.</p>}</> : null}
    </section>
    <ErrorMessage value={error} /><div className="flex justify-between gap-3 border-t pt-4"><Button variant="ghost" disabled={!step || busy || importBusy} onClick={() => { setError(""); setStep(value => value - 1); }}>Back</Button>{current === "Review" ? <Button disabled={busy || importBusy} onClick={() => void finish()}>{busy ? "Saving…" : "Create and test"}</Button> : <Button disabled={busy || importBusy} onClick={() => void next()}>{busy ? "Saving…" : current === "Knowledge" && !knowledgeAdded ? "Skip for now" : "Continue"}</Button>}</div>
  </DialogContent></Dialog>;
}
