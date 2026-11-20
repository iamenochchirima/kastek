import { useEffect, useRef, useState } from "react";
import { PiCalendarBlank as CalendarDays, PiChatCircle as MessageCircle, PiHeadphones as Headphones, PiPlus as Plus, PiUserPlus as UserRoundPlus } from "react-icons/pi";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useConfirmationDialog } from "@/components/ui/confirmation-provider";
import { api, ApiError, message, organizationPath, type Agent } from "./api";
import { ErrorMessage, useWorkspace } from "./shell";
import { agentTemplates, defaultJob, needsKnowledge, setupFor, type AgentJob } from "./agent-templates";
import { KnowledgeUpload } from "./knowledge-upload";
import { WebsiteKnowledgeImport } from "./website-knowledge-import";

const icons = { "answer-questions": MessageCircle, "customer-support": Headphones, bookings: CalendarDays, enquiries: UserRoundPlus } as const;
const labels = Object.fromEntries(agentTemplates.map(template => [template.id, template.label])) as Record<AgentJob, string>;

export function CreateAgentDialog({ open, onOpenChange, organizationId, onCreated }: {
  open: boolean; onOpenChange: (open: boolean) => void; organizationId: string; onCreated: (id: string) => void;
}) {
  const { session } = useWorkspace();
  const { confirm } = useConfirmationDialog();
  const storageKey = `agent-create:${session.account.id}:${organizationId}`;
  const base = organizationPath(organizationId);
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [mode, setMode] = useState<"template" | "custom">("template");
  const [template, setTemplate] = useState<AgentJob>(defaultJob);
  const [custom, setCustom] = useState<AgentJob[]>([defaultJob]);
  const [customKnowledge, setCustomKnowledge] = useState(false);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [knowledgeAdded, setKnowledgeAdded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [error, setError] = useState("");
  const createRequest = useRef<Promise<Agent> | null>(null);
  const opened = useRef(false);
  const selected = mode === "template" ? [template] : custom;
  const knowledgeStep = mode === "template" ? needsKnowledge([template]) : needsKnowledge(custom) || customKnowledge;
  const steps = ["Name", "What should it do?", ...(knowledgeStep ? ["Knowledge"] : []), "Review"];
  const current = steps[step] ?? "Review";
  const validName = name.trim().length > 0 && name.trim().length <= 120;
  const validJobs = selected.length > 0;

  useEffect(() => {
    if (!open) { opened.current = false; return; }
    if (opened.current) return;
    opened.current = true;
    const pointer = sessionStorage.getItem(storageKey);
    if (!pointer) { if (agent) reset(); return; }
    if (agent?.id === pointer) return;
    let live = true;
    setBusy(true);
    api<{ agent: Agent }>(`${base}/agents/${encodeURIComponent(pointer)}`).then(({ agent: saved }) => {
      if (!live) return;
      setAgent(saved);
      setName(saved.name);
      const jobs = saved.setup?.responsibilities ?? [defaultJob];
      setMode(jobs.length === 1 ? "template" : "custom");
      setTemplate(jobs[0] ?? defaultJob);
      setCustom([...jobs]);
      setKnowledgeAdded(Boolean(saved.draft.sourceRevisionIds?.length));
      setCustomKnowledge(!needsKnowledge(jobs) && saved.setupStep === "Knowledge");
      setStep(saved.setupStep === "Knowledge" ? 2 : saved.setupStep === "Responsibilities" ? 1 : needsKnowledge(jobs) ? 3 : 2);
    }).catch(() => { sessionStorage.removeItem(storageKey); reset(); }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, storageKey]);

  useEffect(() => { if (step > steps.length - 1) setStep(steps.length - 1); }, [step, steps.length]);

  function reset() {
    setStep(0); setName(""); setMode("template"); setTemplate(defaultJob); setCustom([defaultJob]); setCustomKnowledge(false);
    setAgent(null); setKnowledgeAdded(false); setBusy(false); setImportBusy(false); setError("");
    createRequest.current = null;
  }

  function toggleJob(job: AgentJob) {
    setCustom(values => values.includes(job) ? values.filter(value => value !== job) : [...values, job]);
  }

  async function ensureDraft(): Promise<Agent> {
    if (agent) return agent;
    if (createRequest.current) return createRequest.current;
    const pending = { name: name.trim(), setup: setupFor(name, selected), operationId: crypto.randomUUID() };
    createRequest.current = api<{ agent: Agent }>(`${base}/agents`, pending).then(result => {
      setAgent(result.agent);
      sessionStorage.setItem(storageKey, result.agent.id);
      return result.agent;
    }).catch(reason => { createRequest.current = null; throw reason; });
    return createRequest.current;
  }

  async function persist(nextStep: string): Promise<Agent> {
    const created = await ensureDraft();
    // The knowledge step saves configuration on its own, which advances the draft revision.
    const draft = await api<{ agent: Agent }>(`${base}/agents/${encodeURIComponent(created.id)}`).then(result => result.agent);
    const body = { name: name.trim(), setup: setupFor(name, selected), expectedRevision: draft.draftRevision, configuration: draft.draft, setupStep: nextStep };
    try {
      const result = await api<{ agent: Agent }>(`${base}/agents/${encodeURIComponent(draft.id)}/configuration`, body);
      setAgent(result.agent);
      return result.agent;
    } catch (reason) {
      if (!(reason instanceof ApiError) || reason.code !== "CONFIGURATION_CONFIRMATION_REQUIRED") throw reason;
      if (!await confirm({ title: "Apply agent changes?", description: "Update this agent's permitted actions.", confirmLabel: "Apply changes" })) throw new Error("Changes were not applied.");
      const result = await api<{ agent: Agent }>(`${base}/agents/${encodeURIComponent(draft.id)}/configuration`, { ...body, confirmImpact: true });
      setAgent(result.agent);
      return result.agent;
    }
  }

  async function next() {
    if (busy || importBusy) return;
    setError("");
    if (step === 0 && !validName) { setError("Enter a name for the agent."); return; }
    if (step === 1 && !validJobs) { setError("Choose at least one thing the agent should do."); return; }
    setBusy(true);
    try {
      if (step === 1) await persist(steps[2] ?? "Review");
      setStep(value => value + 1);
    } catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  }

  async function finish() {
    if (busy || importBusy) return;
    setBusy(true); setError("");
    try {
      const result = await persist("complete");
      sessionStorage.removeItem(storageKey);
      onCreated(result.id);
      reset();
    } catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  }

  function close() {
    if (busy || importBusy) return;
    onOpenChange(false);
  }

  return <Dialog open={open} onOpenChange={value => { if (!value) close(); }}>
    <DialogContent className="sm:max-w-[min(44rem,calc(100vw-2rem))]" showCloseButton={!busy && !importBusy} onInteractOutside={event => { if (busy || importBusy) event.preventDefault(); }} onEscapeKeyDown={event => { if (busy || importBusy) event.preventDefault(); }}>
      <DialogHeader><DialogTitle>Create agent</DialogTitle><DialogDescription className="sr-only">Name the agent and choose what it should do.</DialogDescription></DialogHeader>
      <div className="space-y-2"><div className="flex justify-between text-xs text-muted-foreground"><span>{current}</span><span>Step {step + 1} of {steps.length}</span></div><div className="flex gap-1" aria-label={`Step ${step + 1} of ${steps.length}: ${current}`}>{steps.map((label, index) => <span key={label} className={`h-1 flex-1 rounded-full ${index <= step ? "bg-primary" : "bg-muted"}`} />)}</div></div>
      <section className="min-w-0 space-y-5 py-2" aria-label={current}>
        {current === "Name" ? <label className="block space-y-2 text-sm font-medium">Name<Input autoFocus required maxLength={120} value={name} onChange={event => setName(event.target.value)} /></label> : null}
        {current === "What should it do?" ? <div className="space-y-3">
          <div className="grid gap-2 sm:grid-cols-2">
            {agentTemplates.map(templateOption => {
              const Icon = icons[templateOption.id], active = mode === "template" && template === templateOption.id;
              return <button type="button" key={templateOption.id} aria-pressed={active} onClick={() => { setMode("template"); setTemplate(templateOption.id); }}
                className={`flex items-start gap-3 rounded-xl border p-4 text-left ${active ? "border-primary bg-primary/5" : "border-border"}`}>
                <Icon size={20} className="mt-0.5 shrink-0 text-primary" /><span className="min-w-0"><span className="block text-sm font-medium">{templateOption.label}</span><span className="mt-1 block text-xs text-muted-foreground">{templateOption.description}</span></span>
              </button>;
            })}
            <button type="button" aria-pressed={mode === "custom"} onClick={() => setMode("custom")}
              className={`flex items-start gap-3 rounded-xl border p-4 text-left ${mode === "custom" ? "border-primary bg-primary/5" : "border-border"}`}>
              <Plus size={20} className="mt-0.5 shrink-0 text-primary" /><span className="min-w-0"><span className="block text-sm font-medium">Custom</span><span className="mt-1 block text-xs text-muted-foreground">Choose the jobs this agent should handle.</span></span>
            </button>
          </div>
          {mode === "custom" ? <>
            <div role="group" aria-label="Jobs" className="grid gap-2 sm:grid-cols-2">
              {agentTemplates.map(templateOption => <label key={templateOption.id} className="flex items-center gap-3 rounded-lg border border-border p-3 text-sm">
                <input type="checkbox" className="size-4 accent-primary" checked={custom.includes(templateOption.id)} onChange={() => toggleJob(templateOption.id)} />{labels[templateOption.id]}
              </label>)}
            </div>
            <label className="flex items-center gap-3 rounded-lg border border-border p-3 text-sm">
              <input type="checkbox" className="size-4 accent-primary" checked={customKnowledge} onChange={event => setCustomKnowledge(event.target.checked)} />Add knowledge
            </label>
          </> : null}
        </div> : null}
        {current === "Knowledge" && agent ? <div className="space-y-4">
          <p className="text-sm text-muted-foreground">Optional. Add a website or documents now, or add them later in Knowledge.</p>
          <WebsiteKnowledgeImport organizationId={organizationId} agentId={agent.id} initialUrl={agent.setup?.business.website ?? ""} onBusyChange={setImportBusy} onComplete={() => setKnowledgeAdded(true)} />
          <div className="border-t pt-4"><KnowledgeUpload organizationId={organizationId} agentId={agent.id} onBusyChange={setImportBusy} onComplete={() => setKnowledgeAdded(true)} /></div>
        </div> : null}
        {current === "Review" ? <div className="space-y-4">
          <dl className="divide-y divide-border text-sm">
            {[
              ["Agent", name.trim()],
              ["Jobs", selected.map(job => labels[job]).join(", ")],
              ["Knowledge", knowledgeStep ? (knowledgeAdded ? "Added" : "Skipped") : "Not required"],
              ["Model", "Organization default"],
              ["Instructions and identity", "Defaults, editable after creation"],
              ["Other capabilities", "Configure after creation"],
            ].map(([label, value]) => <div key={label} className="grid gap-1 py-3 sm:grid-cols-[170px_1fr]"><dt className="text-muted-foreground">{label}</dt><dd className="break-words">{value}</dd></div>)}
          </dl>
        </div> : null}
      </section>
      <ErrorMessage value={error} />
      <DialogFooter className="flex-wrap justify-between gap-2">
        <Button type="button" variant="ghost" disabled={step === 0 || busy || importBusy} onClick={() => { setError(""); setStep(value => value - 1); }}>Back</Button>
        {current === "Review"
          ? <Button type="button" disabled={busy || importBusy || !validName || !validJobs} onClick={() => void finish()}>{busy ? "Creating…" : "Create agent"}</Button>
          : <Button type="button" disabled={busy || importBusy || (step === 0 && !validName) || (step === 1 && !validJobs)} onClick={() => void next()}>{busy ? "Saving…" : current === "Knowledge" && !knowledgeAdded ? "Skip for now" : "Continue"}</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
