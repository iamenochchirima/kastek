import { useEffect, useRef, useState } from "react";
import { PiBuildings as Building2, PiCheck as Check, PiGlobe as Globe, PiChatCircle as MessageCircle, PiCalendarBlank as CalendarDays, PiUserPlus as UserRoundPlus, PiHeadphones as Headphones } from "react-icons/pi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useConfirmationDialog } from "@/components/ui/confirmation-provider";
import { api, ApiError, message, organizationPath, type Agent, type CustomerSetup } from "./api";
import { ErrorMessage } from "./shell";
import { AgentSetupStatus } from "./agent-setup-status";
import { GuidedBookingSetup } from "./guided-booking-setup";
import { useWorkspace } from "./shell";
import { WebsiteKnowledgeImport } from "./website-knowledge-import";
import { defaultSupportHours, SupportHoursFields, validSupportHours } from "./support-hours";

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
type ValidationError = { field: "business" | "responsibilities" | "duration" | "language" | "intake" | "supportHours"; message: string };
const inputStyle = "w-full rounded-md border border-border bg-background px-3 py-2 text-sm";

export function GuidedAgentCreation({ open, onOpenChange, organizationId, onCreated, onDraftCreated, resumeAgentId }: {
  resumeAgentId?: string; open: boolean; onOpenChange: (open: boolean) => void; organizationId: string; onCreated: (id: string) => void; onDraftCreated: () => void;
}) {
  const { session } = useWorkspace();
  const { confirm } = useConfirmationDialog();
  const storageKey = `agent-setup:${session.account.id}:${organizationId}`;
  const [restoring, setRestoring] = useState(false), [conflict,setConflict] = useState(false);
  const [business, setBusiness] = useState({ name: "", website: "", description: "" });
  const [selected, setSelected] = useState<Responsibility[]>([]);
  const [selectedChannels, setSelectedChannels] = useState<Array<typeof channels[number]>>(["website"]);
  const [intakeFields, setIntakeFields] = useState<Array<typeof fields[number]>>(["name", "email", "message"]);
  const [booking, setBooking] = useState({ durationMinutes: 30, notes: "" });
  const [supportHours, setSupportHours] = useState(defaultSupportHours);
  const [behaviour, setBehaviour] = useState({ agentName: "", language: "English", tone: "friendly" as "friendly" | "professional" | "concise", handoffInstructions: "" });
  const [step, setStep] = useState(0), [busy, setBusy] = useState(false), [importBusy, setImportBusy] = useState(false), [error, setError] = useState("");
  const [agent, setAgent] = useState<Agent | null>(null), [knowledgeAdded, setKnowledgeAdded] = useState(false);
  const [validationError, setValidationError] = useState<ValidationError | null>(null);
  const clearValidation = (field: ValidationError["field"]) => setValidationError(current => current?.field === field ? null : current);
  const createRequest = useRef<Promise<Agent> | null>(null);
  const dialogContent = useRef<HTMLDivElement>(null);
  useEffect(() => { dialogContent.current?.scrollTo({ top: 0 }); }, [step]);
  useEffect(() => { if (validationError) document.getElementById(`setup-error-${validationError.field}`)?.scrollIntoView({ block: "nearest" }); }, [validationError]);
  const needsKnowledge = selected.some(value => value === "answer-questions" || value === "customer-support");
  const steps = ["Business", "Responsibilities", ...(needsKnowledge ? ["Knowledge"] : []), "Channels", "Preferences", ...(selected.includes("bookings") ? ["Bookings"] : []), "Review"];
  const current = steps[step] ?? "Review";
  const base = organizationPath(organizationId);
  const agentName = behaviour.agentName.trim() || `${business.name.trim()} assistant`.slice(0, 120);
  const setup = (): CustomerSetup => ({ business, responsibilities: selected, channels: selectedChannels, ...(selected.includes("bookings") ? { booking } : {}), ...(selected.includes("enquiries") ? { intake: { fields: intakeFields } } : {}), ...(selected.includes("customer-support") && validSupportHours(supportHours) ? { supportHours } : {}), behaviour: { ...behaviour, agentName } });
  function toggle<T extends string>(values: T[], value: T, set: (values: T[]) => void) { set(values.includes(value) ? values.filter(item => item !== value) : [...values, value]); }
  useEffect(() => {
    if (!open) return;
    let live = true;
    const pointer = sessionStorage.getItem(storageKey);
    const id = resumeAgentId ?? (pointer && !pointer.startsWith("pending:") ? pointer : undefined);
    if (!id || agent?.id === id) return;
    setRestoring(true); setError("");
    api<{agent: Agent}>(`${base}/agents/${encodeURIComponent(id)}`).then(({agent: saved}) => {
      if (!live) return;
      if (!saved.setup) throw new Error("This agent has no guided setup.");
      const value = saved.setup;
      setAgent(saved); setBusiness(value.business); setSelected(value.responsibilities); setSelectedChannels(value.channels);
      setBooking(value.booking ?? {durationMinutes:30,notes:""}); setIntakeFields(value.intake?.fields ?? ["name","email","message"]); setBehaviour(value.behaviour); setSupportHours(value.supportHours ?? defaultSupportHours());
      const available = ["Business","Responsibilities",...(value.responsibilities.some(item => item === "answer-questions" || item === "customer-support") ? ["Knowledge"] : []),"Channels","Preferences",...(value.responsibilities.includes("bookings") ? ["Bookings"] : []),"Review"];
      setStep(Math.max(0,available.indexOf(saved.setupStep === "complete" ? "Review" : saved.setupStep ?? "Responsibilities")));
    }).catch(e => {if(live)setError(message(e));}).finally(() => {if(live)setRestoring(false);});
    return () => {live=false;};
    // Restore on opening or explicit resume, not after every local form edit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, resumeAgentId, storageKey]);
  async function ensureDraft() {
    if (agent) return agent;
    if (!createRequest.current) {
      const stored = sessionStorage.getItem(storageKey);
      const pending = stored?.startsWith("pending:") ? JSON.parse(stored.slice(8)) : {operationId:crypto.randomUUID(),name:agentName,offering:"customer-service",setup:setup()};
      sessionStorage.setItem(storageKey,`pending:${JSON.stringify(pending)}`);
      createRequest.current = api<{ agent: Agent }>(`${base}/agents`, pending).then(result => { setAgent(result.agent); sessionStorage.setItem(storageKey,result.agent.id); onDraftCreated(); return result.agent; }).catch(e => { createRequest.current = null; throw e; });
    }
    return createRequest.current;
  }
  async function persist(nextStep: string) {
    const draft = await ensureDraft();
    const body = {name:agentName,setup:setup(),expectedRevision:draft.draftRevision,configuration:draft.draft,setupStep:nextStep};
    let result: {agent:Agent};
    try { result = await api(`${base}/agents/${draft.id}/configuration`, body); }
    catch (e) {
      if (e instanceof ApiError && e.code === "DRAFT_CONFLICT") setConflict(true);
      if (!(e instanceof ApiError) || e.code !== "CONFIGURATION_CONFIRMATION_REQUIRED") throw e;
      if (!await confirm({title:"Apply agent changes?",description:"Update this agent's permitted actions and connected customer channels.",confirmLabel:"Apply changes"})) throw new Error("Changes were not applied.");
      result = await api(`${base}/agents/${draft.id}/configuration`, {...body,confirmImpact:true});
    }
    setAgent(result.agent); onDraftCreated(); return result.agent;
  }
  async function refreshDraft() {
    if (!agent) return;
    const result = await api<{agent:Agent}>(`${base}/agents/${agent.id}`); setAgent(result.agent); setKnowledgeAdded(true);
  }
  function validate(): ValidationError | null {
    if (current === "Business" && !business.name.trim()) return { field: "business", message: "Enter your business name." };
    if (current === "Responsibilities" && !selected.length) return { field: "responsibilities", message: "Choose at least one responsibility." };
    if (current === "Preferences" && selected.includes("bookings") && (!Number.isInteger(booking.durationMinutes) || booking.durationMinutes < 5 || booking.durationMinutes > 240)) return { field: "duration", message: "Enter an appointment duration from 5 to 240 minutes." };
    if (current === "Preferences" && !behaviour.language.trim()) return { field: "language", message: "Enter a language." };
    if (current === "Preferences" && selected.includes("customer-support") && !validSupportHours(supportHours)) return { field: "supportHours", message: "Select support days and enter valid hours and timezone." };
    if (current === "Preferences" && selected.includes("enquiries") && !intakeFields.length) return { field: "intake", message: "Choose at least one enquiry field." };
    return null;
  }
  function fieldError(field: ValidationError["field"]) {
    return validationError?.field === field ? <p id={`setup-error-${field}`} role="alert" className="text-sm text-destructive">{validationError.message}</p> : null;
  }
  async function next() {
    const invalid = validate(); if (invalid) { setError(""); setValidationError(invalid); return; }
    setValidationError(null); setBusy(true); setError("");
    try {
      // A new draft requires at least one responsibility, which is chosen on the next step.
      if (current !== "Business" || (agent && selected.length > 0)) await persist(steps[step + 1] ?? "Review");
      setStep(value => value + 1);
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  async function finish() {
    setBusy(true); setError("");
    try {
      const draft = await persist("complete");
      sessionStorage.removeItem(storageKey);
      onCreated(draft.id);
      setAgent(null); createRequest.current = null; setStep(0); setBusiness({ name: "", website: "", description: "" }); setBehaviour({ agentName: "", language: "English", tone: "friendly", handoffInstructions: "" }); setSupportHours(defaultSupportHours()); setKnowledgeAdded(false); setSelected([]); setSelectedChannels(["website"]); setIntakeFields(["name", "email", "message"]); setBooking({ durationMinutes: 30, notes: "" });
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={value => { if (!busy && !importBusy) onOpenChange(value); }}><DialogContent ref={dialogContent} className="sm:max-w-[min(48rem,calc(100vw-2rem))]" showCloseButton={!busy && !importBusy} onInteractOutside={event => { if (busy || importBusy) event.preventDefault(); }} onEscapeKeyDown={event => { if (busy || importBusy) event.preventDefault(); }}>
    <DialogHeader><DialogTitle>Create agent</DialogTitle><DialogDescription className="sr-only">Set up your customer service agent.</DialogDescription></DialogHeader>
    <div className="space-y-2"><div className="flex justify-between text-xs text-muted-foreground"><span>{current}</span><span>Step {step + 1} of {steps.length}</span></div><div className="flex gap-1" aria-label={`Step ${step + 1} of ${steps.length}: ${current}`}>{steps.map((label, index) => <span key={label} className={`h-1 flex-1 rounded-full ${index <= step ? "bg-primary" : "bg-muted"}`} />)}</div></div>
    <section className="min-w-0 space-y-5 py-2" aria-label={current}>
      {restoring ? <p role="status" className="text-sm">Loading setup…</p> : null}
      {!restoring && current === "Business" ? <><div className="flex items-center gap-2"><Building2 size={20} className="text-primary" /><h2 className="text-xl font-semibold">Your business</h2></div><div className="space-y-2"><label className="block space-y-2 text-sm">Business name<Input autoFocus maxLength={120} value={business.name} aria-invalid={validationError?.field === "business" || undefined} aria-describedby={validationError?.field === "business" ? "setup-error-business" : undefined} onChange={e => { setBusiness({ ...business, name: e.target.value }); clearValidation("business"); }} /></label>{fieldError("business")}</div><label className="block space-y-2 text-sm">Website <span className="text-muted-foreground">(optional)</span><Input placeholder="example.com" maxLength={2048} value={business.website} onChange={e => setBusiness({ ...business, website: e.target.value })} /></label><label className="block space-y-2 text-sm">Business description <span className="text-muted-foreground">(optional)</span><textarea className={inputStyle} rows={3} maxLength={1500} value={business.description} onChange={e => setBusiness({ ...business, description: e.target.value })} /></label></> : null}
      {current === "Responsibilities" ? <><h2 className="text-xl font-semibold">What should it do?</h2><div role="group" aria-label="Responsibilities" aria-describedby={validationError?.field === "responsibilities" ? "setup-error-responsibilities" : undefined} className="grid gap-3 sm:grid-cols-2">{responsibilities.map(({ id, label, detail, icon: Icon }) => <label key={id} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-4 ${selected.includes(id) ? "border-primary bg-primary/5" : "border-border"}`}><Icon size={20} className="mt-0.5 shrink-0 text-primary" /><span className="min-w-0 flex-1"><span className="block text-sm font-medium">{label}</span><span className="mt-1 block text-xs text-muted-foreground">{detail}</span></span><input className="mt-1 size-4 shrink-0 accent-primary" type="checkbox" checked={selected.includes(id)} onChange={() => { toggle(selected, id, setSelected); clearValidation("responsibilities"); }} /></label>)}</div>{fieldError("responsibilities")}</> : null}
      {current === "Knowledge" && agent ? <><h2 className="text-xl font-semibold">Business knowledge</h2><WebsiteKnowledgeImport organizationId={organizationId} agentId={agent.id} initialUrl={business.website} onBusyChange={setImportBusy} onComplete={() => void refreshDraft()} /><p className="text-xs text-muted-foreground">Documents and other information can be added later.</p></> : null}
      {current === "Channels" ? <><div className="flex items-center gap-2"><Globe size={20} className="text-primary" /><h2 className="text-xl font-semibold">Where will customers use it?</h2></div><div className="grid gap-2 sm:grid-cols-2">{channels.map(channel => <label key={channel} className={`flex cursor-pointer items-center gap-3 rounded-lg border p-4 text-sm ${selectedChannels.includes(channel) ? "border-primary bg-primary/5" : "border-border"}`}><input type="checkbox" className="size-4 accent-primary" checked={selectedChannels.includes(channel)} onChange={() => toggle(selectedChannels, channel, setSelectedChannels)} />{channelNames[channel]}</label>)}</div><p className="text-xs text-muted-foreground">Connect accounts and install your widget after testing.</p></> : null}
      {current === "Preferences" ? <><h2 className="text-xl font-semibold">Make it yours</h2><div className="grid gap-4 sm:grid-cols-2"><label className="block space-y-2 text-sm">Agent name<Input placeholder={agentName} maxLength={120} value={behaviour.agentName} onChange={e => setBehaviour({ ...behaviour, agentName: e.target.value })} /></label><div className="space-y-2"><label className="block space-y-2 text-sm">Language<Input maxLength={80} value={behaviour.language} aria-invalid={validationError?.field === "language" || undefined} aria-describedby={validationError?.field === "language" ? "setup-error-language" : undefined} onChange={e => { setBehaviour({ ...behaviour, language: e.target.value }); clearValidation("language"); }} /></label>{fieldError("language")}</div><label className="block space-y-2 text-sm">Tone<select className={inputStyle} value={behaviour.tone} onChange={e => setBehaviour({ ...behaviour, tone: e.target.value as typeof behaviour.tone })}><option value="friendly">Friendly</option><option value="professional">Professional</option><option value="concise">Concise</option></select></label></div>{selected.includes("customer-support") ? <SupportHoursFields value={supportHours} onChange={value => { setSupportHours(value); clearValidation("supportHours"); }} error={validationError?.field === "supportHours" ? validationError.message : undefined} /> : null}{selected.includes("bookings") ? <fieldset className="space-y-3 border-t pt-4"><legend className="text-sm font-medium">Appointments</legend><div className="space-y-2"><label className="block space-y-2 text-sm">Duration (minutes)<Input type="number" min={5} max={240} value={booking.durationMinutes} aria-invalid={validationError?.field === "duration" || undefined} aria-describedby={validationError?.field === "duration" ? "setup-error-duration" : undefined} onChange={e => { setBooking({ ...booking, durationMinutes: Number(e.target.value) }); clearValidation("duration"); }} /></label>{fieldError("duration")}</div><label className="block space-y-2 text-sm">Availability and booking rules<textarea rows={2} className={inputStyle} maxLength={1000} value={booking.notes} onChange={e => setBooking({ ...booking, notes: e.target.value })} /></label><p className="text-xs text-muted-foreground">A calendar connection is required before the agent can confirm bookings.</p></fieldset> : null}{selected.includes("enquiries") ? <fieldset aria-describedby={validationError?.field === "intake" ? "setup-error-intake" : undefined} className="space-y-3 border-t pt-4"><legend className="text-sm font-medium">Enquiry details</legend><div className="flex flex-wrap gap-x-5 gap-y-3">{fields.map(field => <label key={field} className="flex items-center gap-2 text-sm capitalize"><input type="checkbox" className="size-4 accent-primary" checked={intakeFields.includes(field)} onChange={() => { toggle(intakeFields, field, setIntakeFields); clearValidation("intake"); }} />{field.charAt(0).toUpperCase() + field.slice(1)}</label>)}</div>{fieldError("intake")}</fieldset> : null}</> : null}
      {current === "Bookings" && agent ? <GuidedBookingSetup agentId={agent.id} configuration={agent.draft} initialDurationMinutes={booking.durationMinutes} onChange={configuration => setAgent({...agent,draft:configuration})} onPolicySelectedDuration={durationMinutes=>setBooking(value=>({...value,durationMinutes}))} returnTo={`/app/agents/${agent.id}?setup=guided`} onBeforeConnect={async () => {await persist("Bookings");}} onBusyChange={setImportBusy} /> : null}
      {current === "Review" ? <><div className="flex items-center gap-2"><Check size={20} className="text-primary" /><h2 className="text-xl font-semibold">Review agent</h2></div>{agent ? <AgentSetupStatus organizationId={organizationId} agent={agent} compact /> : null}<dl className="divide-y divide-border text-sm">{[["Agent", agentName], ["Business", business.name], ["Responsibilities", responsibilities.filter(item => selected.includes(item.id)).map(item => item.label).join(", ")], ["Channels", selectedChannels.map(channel => channelNames[channel]).join(", ") || "Choose later"], ["Behaviour", `${behaviour.language} · ${behaviour.tone}`]].map(([label, value]) => <div key={label} className="grid gap-1 py-3 sm:grid-cols-[130px_1fr]"><dt className="text-muted-foreground">{label}</dt><dd className="break-words">{value}</dd></div>)}</dl>{selected.includes("bookings") ? <p className="text-xs text-muted-foreground">Bookings need a connected calendar. Channels still need connecting.</p> : <p className="text-xs text-muted-foreground">Channels still need connecting.</p>}</> : null}
    </section>
    <ErrorMessage value={error} />{conflict && agent ? <Button type="button" variant="outline" onClick={async()=>{if(await confirm({title:"Reload saved setup?",description:"Replace your unsaved changes with the latest saved settings.",confirmLabel:"Reload setup"}))window.location.assign(`/app/agents/${agent.id}?setup=guided`);}}>Reload saved setup</Button> : null}<div className="flex justify-between gap-3 border-t pt-4"><Button variant="ghost" disabled={!step || busy || importBusy || restoring} onClick={() => { setError(""); setValidationError(null); setStep(value => value - 1); }}>Back</Button>{current === "Review" ? <Button disabled={busy || importBusy || restoring} onClick={() => void finish()}>{busy ? "Saving…" : "Create and test"}</Button> : <Button disabled={busy || importBusy || restoring} onClick={() => void next()}>{busy ? "Saving…" : current === "Knowledge" && !knowledgeAdded ? "Skip for now" : "Continue"}</Button>}</div>
  </DialogContent></Dialog>;
}
