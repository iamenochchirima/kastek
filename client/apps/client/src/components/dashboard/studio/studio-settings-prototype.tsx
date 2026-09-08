"use client";

// Prototype question: which settings workspace best exposes an agent's useful
// capabilities without making users learn plugin or MCP terminology?

import { useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  Database,
  Eye,
  FlaskConical,
  KeyRound,
  Layers3,
  LockKeyhole,
  MemoryStick,
  Plus,
  Puzzle,
  Save,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { AgentModelPicker } from "@/components/dashboard/agents/agent-model-picker";
import type {
  AgentDefinition,
  AgentModel,
  AgentModelCatalog,
  AgentVersion,
} from "@/lib/agent-platform";
import { cn } from "@/lib/utils";

type SettingsSection = "overview" | "capabilities" | "memory" | "connections" | "safety" | "runtime";
type PrototypeVariant = "a" | "b" | "c";
type ModelSelection = Pick<AgentModel, "provider" | "model">;

const sections: Array<{ id: SettingsSection; label: string; description: string }> = [
  { id: "overview", label: "Overview", description: "Identity, instructions, and model" },
  { id: "capabilities", label: "Capabilities", description: "Tools, skills, and extensions" },
  { id: "memory", label: "Memory", description: "Scope and retrieval" },
  { id: "connections", label: "Connections", description: "Services and resource bindings" },
  { id: "safety", label: "Safety", description: "Approvals and permissions" },
  { id: "runtime", label: "Runtime", description: "Context, budgets, and limits" },
];

const variants: Array<{ id: PrototypeVariant; label: string }> = [
  { id: "a", label: "Sidebar settings" },
  { id: "b", label: "Capability center" },
  { id: "c", label: "Setup checklist" },
];

function formatTokens(value: number | undefined) {
  if (!value || !Number.isFinite(value)) return "Not reported";
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function statusClass(status: "ready" | "attention" | "included" | "not_configured") {
  if (status === "ready" || status === "included") return "text-emerald-700 dark:text-emerald-300";
  if (status === "attention") return "text-amber-700 dark:text-amber-300";
  return "text-muted-foreground";
}

function StatusDot({ status }: { status: "ready" | "attention" | "included" | "not_configured" }) {
  return <span className={cn("size-1.5 shrink-0 rounded-full", status === "ready" || status === "included" ? "bg-emerald-500" : status === "attention" ? "bg-amber-500" : "bg-muted-foreground/40")} />;
}

export function StudioSettingsPrototype({
  agent,
  version,
  instructions,
  setInstructions,
  onSave,
  saving,
  modelCatalog,
  modelCatalogLoading,
  modelSelection,
  setModelSelection,
  onClose,
}: {
  agent: AgentDefinition;
  version: AgentVersion | null;
  instructions: string;
  setInstructions: (value: string) => void;
  onSave: () => void;
  saving: boolean;
  modelCatalog: AgentModelCatalog | null;
  modelCatalogLoading: boolean;
  modelSelection: ModelSelection | null;
  setModelSelection: (value: ModelSelection | null) => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [section, setSection] = useState<SettingsSection>("overview");
  const requestedVariant = searchParams.get("studioVariant");
  const variant: PrototypeVariant = requestedVariant === "b" || requestedVariant === "c" ? requestedVariant : "a";

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, [contenteditable='true']")) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const current = variants.findIndex((item) => item.id === variant);
      const next = variants[(current + (event.key === "ArrowRight" ? 1 : -1) + variants.length) % variants.length].id;
      const params = new URLSearchParams(searchParams.toString());
      params.set("studioVariant", next);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pathname, router, searchParams, variant]);

  const chooseVariant = (next: PrototypeVariant) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set("studioVariant", next);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const availableModels = modelCatalog?.models ?? [];
  const pickerModels = modelSelection && !availableModels.some((item) => item.provider === modelSelection.provider && item.model === modelSelection.model)
    ? [{ provider: modelSelection.provider, model: modelSelection.model, label: modelSelection.model, description: "Saved model is not in the current catalog.", tier: "balanced" as const }, ...availableModels]
    : availableModels;
  const selectedModel = pickerModels.find((item) => item.provider === modelSelection?.provider && item.model === modelSelection.model)
    ?? pickerModels.find((item) => item.isWorkspaceDefault)
    ?? pickerModels[0];
  const effectiveSelection = selectedModel ? { provider: selectedModel.provider, model: selectedModel.model } : modelSelection;

  const content = (
    <SettingsContent
      agent={agent}
      version={version}
      section={section}
      setSection={setSection}
      instructions={instructions}
      setInstructions={setInstructions}
      onSave={onSave}
      saving={saving}
      modelCatalog={modelCatalog}
      modelCatalogLoading={modelCatalogLoading}
      selectedModel={selectedModel}
      pickerModels={pickerModels}
      effectiveSelection={effectiveSelection}
      setModelSelection={setModelSelection}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-5 py-4 sm:px-7">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><SlidersHorizontal className="size-4" /></div>
          <div className="min-w-0"><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Agent settings</p><h2 className="mt-1 truncate text-base font-semibold text-foreground">{agent.name}</h2></div>
        </div>
        <div className="flex items-center gap-2"><span className="hidden items-center gap-1.5 text-[11px] text-muted-foreground sm:inline-flex"><span className="size-1.5 rounded-full bg-amber-500" />Draft changes</span><button type="button" aria-label="Close settings" onClick={onClose} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"><X className="size-4" /></button></div>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        {variant === "a" ? <SidebarVariant content={content} section={section} setSection={setSection} /> : null}
        {variant === "b" ? <CapabilityCenterVariant content={content} section={section} setSection={setSection} /> : null}
        {variant === "c" ? <ChecklistVariant content={content} section={section} setSection={setSection} /> : null}
      </div>

      {process.env.NODE_ENV !== "production" ? <PrototypeSwitcher variant={variant} onChange={chooseVariant} /> : null}
    </div>
  );
}

function SidebarVariant({ content, section, setSection }: { content: ReactNode; section: SettingsSection; setSection: (value: SettingsSection) => void }) {
  return <div className="flex h-full min-h-0"><SettingsNavigation section={section} setSection={setSection} /><main className="min-w-0 flex-1 overflow-y-auto bg-background/40">{content}</main></div>;
}

function CapabilityCenterVariant({ content, section, setSection }: { content: ReactNode; section: SettingsSection; setSection: (value: SettingsSection) => void }) {
  return <div className="flex h-full min-h-0 flex-col"><div className="shrink-0 overflow-x-auto border-b border-border bg-card px-5 py-3 sm:px-7"><div className="flex min-w-max items-center gap-1">{sections.map((item) => <button key={item.id} type="button" onClick={() => setSection(item.id)} className={cn("rounded-lg px-3 py-2 text-xs font-medium transition-colors", section === item.id ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground")}>{item.label}</button>)}</div></div><main className="min-h-0 flex-1 overflow-y-auto bg-background/40">{content}</main></div>;
}

function ChecklistVariant({ content, section, setSection }: { content: ReactNode; section: SettingsSection; setSection: (value: SettingsSection) => void }) {
  return <div className="grid h-full min-h-0 lg:grid-cols-[minmax(260px,0.32fr)_minmax(0,0.68fr)]"><aside className="overflow-y-auto border-b border-border bg-card p-5 lg:border-b-0 lg:border-r sm:p-7"><p className="text-xs font-semibold text-foreground">Setup readiness</p><p className="mt-1 text-xs leading-5 text-muted-foreground">Review the agent before running it in Playground.</p><div className="mt-5 space-y-2">{sections.map((item, index) => { const active = item.id === section; const complete = index < 2; return <button key={item.id} type="button" onClick={() => setSection(item.id)} className={cn("flex w-full items-start gap-3 rounded-xl border p-3 text-left transition-colors", active ? "border-primary/40 bg-primary/5" : "border-border hover:bg-muted/60")}><span className={cn("mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border text-[10px]", complete ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : active ? "border-primary/40 text-primary" : "border-border text-muted-foreground")}>{complete ? <Check className="size-3" /> : index + 1}</span><span className="min-w-0"><span className="block text-xs font-medium text-foreground">{item.label}</span><span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">{item.description}</span></span></button>; })}</div></aside><main className="min-w-0 overflow-y-auto bg-background/40">{content}</main></div>;
}

function SettingsNavigation({ section, setSection }: { section: SettingsSection; setSection: (value: SettingsSection) => void }) {
  return <aside className="hidden w-60 shrink-0 overflow-y-auto border-r border-border bg-card p-4 sm:block"><div className="px-2 pb-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Settings</div><nav className="space-y-1">{sections.map((item) => <button key={item.id} type="button" onClick={() => setSection(item.id)} className={cn("flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors", section === item.id ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground")}><span><SettingsIcon section={item.id} /></span><span className="min-w-0 text-xs font-medium">{item.label}</span></button>)}</nav><div className="mt-6 rounded-xl border border-border bg-background/60 p-3"><div className="flex items-center gap-2 text-xs font-medium text-foreground"><FlaskConical className="size-3.5 text-primary" />Playground</div></div></aside>;
}

function SettingsIcon({ section }: { section: SettingsSection }) {
  if (section === "capabilities") return <Wrench className="size-3.5" />;
  if (section === "memory") return <MemoryStick className="size-3.5" />;
  if (section === "connections") return <KeyRound className="size-3.5" />;
  if (section === "safety") return <ShieldCheck className="size-3.5" />;
  if (section === "runtime") return <Activity className="size-3.5" />;
  return <Bot className="size-3.5" />;
}

function SettingsContent({
  agent,
  version,
  section,
  setSection,
  instructions,
  setInstructions,
  onSave,
  saving,
  modelCatalog,
  modelCatalogLoading,
  selectedModel,
  pickerModels,
  effectiveSelection,
  setModelSelection,
}: {
  agent: AgentDefinition;
  version: AgentVersion | null;
  section: SettingsSection;
  setSection: (value: SettingsSection) => void;
  instructions: string;
  setInstructions: (value: string) => void;
  onSave: () => void;
  saving: boolean;
  modelCatalog: AgentModelCatalog | null;
  modelCatalogLoading: boolean;
  selectedModel?: AgentModel;
  pickerModels: AgentModel[];
  effectiveSelection: ModelSelection | null;
  setModelSelection: (value: ModelSelection | null) => void;
}) {
  const title = sections.find((item) => item.id === section)?.label ?? "Settings";
  const description = sections.find((item) => item.id === section)?.description ?? "";
  return <div className="mx-auto max-w-4xl px-5 py-6 pb-24 sm:px-8 sm:py-8"><div className="mb-7 flex items-start justify-between gap-4"><div><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Agent settings</p><h3 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-foreground">{title}</h3><p className="mt-1 text-sm text-muted-foreground">{description}</p></div><span className="hidden items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[10px] text-muted-foreground sm:inline-flex"><span className="size-1.5 rounded-full bg-amber-500" />Draft</span></div>{section === "overview" ? <OverviewSection agent={agent} version={version} instructions={instructions} setInstructions={setInstructions} selectedModel={selectedModel} pickerModels={pickerModels} modelCatalog={modelCatalog} modelCatalogLoading={modelCatalogLoading} effectiveSelection={effectiveSelection} setModelSelection={setModelSelection} /> : null}{section === "capabilities" ? <CapabilitiesSection /> : null}{section === "memory" ? <MemorySection /> : null}{section === "connections" ? <ConnectionsSection /> : null}{section === "safety" ? <SafetySection /> : null}{section === "runtime" ? <RuntimeSection selectedModel={selectedModel} /> : null}<div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5"><p className="text-[11px] text-muted-foreground">Changes apply to the next Playground version.</p><div className="flex items-center gap-2"><Button type="button" variant="outline" size="sm" onClick={() => setSection("overview")}><ArrowLeft className="mr-1.5 size-3.5" />Overview</Button><Button type="button" size="sm" onClick={onSave} disabled={saving}>{saving ? <Clock3 className="mr-1.5 size-3.5 animate-pulse" /> : <Save className="mr-1.5 size-3.5" />}{saving ? "Saving…" : "Save draft"}</Button></div></div></div>;
}

function OverviewSection({ agent, version, instructions, setInstructions, selectedModel, pickerModels, modelCatalog, modelCatalogLoading, effectiveSelection, setModelSelection }: { agent: AgentDefinition; version: AgentVersion | null; instructions: string; setInstructions: (value: string) => void; selectedModel?: AgentModel; pickerModels: AgentModel[]; modelCatalog: AgentModelCatalog | null; modelCatalogLoading: boolean; effectiveSelection: ModelSelection | null; setModelSelection: (value: ModelSelection | null) => void }) {
  return <div className="space-y-5"><div className="grid gap-4 sm:grid-cols-2"><InfoTile label="Agent" value={agent.name} icon={<Bot className="size-4" />} /><InfoTile label="Version" value={version ? `v${version.version_number} · ${version.status}` : "No version"} icon={<Layers3 className="size-4" />} /></div><section className="rounded-2xl border border-border bg-card p-4 sm:p-5"><div className="flex items-center gap-2"><Bot className="size-4 text-primary" /><h4 className="text-sm font-semibold text-foreground">Instructions</h4></div><Textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="Define what this agent should do…" className="mt-4 min-h-44 resize-y text-sm" /></section><section className="rounded-2xl border border-border bg-card p-4 sm:p-5"><div className="flex items-start justify-between gap-4"><div><div className="flex items-center gap-2"><Sparkles className="size-4 text-primary" /><h4 className="text-sm font-semibold text-foreground">Model</h4></div><p className="mt-1 text-xs text-muted-foreground">The model used for the next Playground run.</p></div>{selectedModel ? <span className="text-[11px] text-muted-foreground">{formatTokens(selectedModel.contextWindow)} context</span> : null}</div>{modelCatalogLoading ? <p className="mt-4 text-xs text-muted-foreground">Loading models…</p> : modelCatalog ? <div className="mt-4"><AgentModelPicker model={selectedModel} models={pickerModels} disabled={!pickerModels.length} ariaLabel="Select agent model" pickerTitle="Choose a model" onSelect={(model, provider) => setModelSelection({ model, provider })} />{effectiveSelection ? <p className="mt-2 text-[11px] text-muted-foreground">{effectiveSelection.provider}:{effectiveSelection.model}</p> : null}</div> : <p className="mt-4 text-xs text-muted-foreground">Model catalog unavailable.</p>}</section></div>;
}

function CapabilitiesSection() {
  const [addOpen, setAddOpen] = useState(false);
  return <div className="space-y-4"><div className="flex items-center justify-between gap-3"><p className="max-w-lg text-xs leading-5 text-muted-foreground">Give this agent access to useful work. Built-in tools stay grouped. Technical plugin and MCP details appear only when you open a capability.</p><Button type="button" size="sm" onClick={() => setAddOpen((value) => !value)}><Plus className="mr-1.5 size-3.5" />Add capability</Button></div>{addOpen ? <div className="grid gap-2 rounded-2xl border border-primary/20 bg-primary/5 p-3 sm:grid-cols-2"><CapabilityAddOption icon={<Server className="size-4" />} label="Connect a service" detail="Calendar, messaging, notes" /><CapabilityAddOption icon={<Sparkles className="size-4" />} label="Add a skill" detail="Reusable agent behavior" /><CapabilityAddOption icon={<Puzzle className="size-4" />} label="Add an extension" detail="Plugin or MCP source" /><CapabilityAddOption icon={<Wrench className="size-4" />} label="Add a custom tool" detail="Your own action schema" /></div> : null}<CapabilityRow icon={<Bot className="size-4" />} title="KasiTek workspace tools" detail="Platform-managed tools available to KasiAI" status="included" statusText="Included" action="View tools" /><CapabilityRow icon={<Server className="size-4" />} title="Connected services" detail="External services this agent may use" status="not_configured" statusText="None configured" action="Add service" onAction={() => setAddOpen(true)} /><CapabilityRow icon={<Sparkles className="size-4" />} title="Skills" detail="Reusable instructions and behaviors" status="not_configured" statusText="None enabled" action="Add skill" onAction={() => setAddOpen(true)} /><CapabilityRow icon={<Puzzle className="size-4" />} title="Extensions" detail="Plugins and MCP sources, grouped together" status="not_configured" statusText="None enabled" action="Add extension" onAction={() => setAddOpen(true)} /><details className="rounded-2xl border border-border bg-card p-4"><summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium text-foreground"><span className="flex items-center gap-2"><Eye className="size-4 text-muted-foreground" />Advanced source details</span><ChevronDown className="size-4 text-muted-foreground" /></summary><p className="mt-3 max-w-2xl text-xs leading-5 text-muted-foreground">Technical type, package version, MCP endpoint, schema, digest, and provider adapter appear here for debugging. They are not part of the main setup flow.</p></details></div>;
}

function CapabilityAddOption({ icon, label, detail }: { icon: ReactNode; label: string; detail: string }) {
  return <button type="button" className="flex items-center gap-3 rounded-xl border border-border bg-card p-3 text-left hover:border-primary/40"><span className="text-primary">{icon}</span><span><span className="block text-xs font-medium text-foreground">{label}</span><span className="mt-0.5 block text-[11px] text-muted-foreground">{detail}</span></span><ChevronRight className="ml-auto size-3.5 text-muted-foreground" /></button>;
}

function CapabilityRow({ icon, title, detail, status, statusText, action, onAction }: { icon: ReactNode; title: string; detail: string; status: "ready" | "attention" | "included" | "not_configured"; statusText: string; action: string; onAction?: () => void }) {
  return <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-card p-4 sm:flex-nowrap"><span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">{icon}</span><div className="min-w-0 flex-1"><p className="text-sm font-medium text-foreground">{title}</p><p className="mt-1 text-xs text-muted-foreground">{detail}</p></div><span className={cn("inline-flex items-center gap-1.5 text-[11px]", statusClass(status))}><StatusDot status={status} />{statusText}</span><Button type="button" variant="outline" size="sm" className="h-8 shrink-0" onClick={onAction}>{action}</Button></div>;
}

function MemorySection() {
  return <div className="space-y-4"><CapabilityRow icon={<MemoryStick className="size-4" />} title="Agent memory" detail="Control what this agent can retrieve and write" status="not_configured" statusText="Review policy" action="Configure" /><div className="grid gap-4 sm:grid-cols-2"><InfoTile label="Scope" value="Workspace" icon={<Database className="size-4" />} /><InfoTile label="Retrieval" value="Not configured" icon={<Eye className="size-4" />} /></div><SettingNote title="Memory stays scoped" detail="The agent only receives evidence allowed by its workspace, environment, and candidate policy." /></div>;
}

function ConnectionsSection() {
  return <div className="space-y-4"><div className="grid gap-4 sm:grid-cols-2"><ConnectionCard title="Playground" detail="Isolated test bindings" status="Ready" statusKind="ready" /><ConnectionCard title="Live" detail="Production bindings" status="Not connected" statusKind="not_configured" /></div><CapabilityRow icon={<KeyRound className="size-4" />} title="Workspace resources" detail="Credential references and service bindings used by this agent" status="attention" statusText="Review bindings" action="Manage" /><SettingNote title="Credentials are environment-specific" detail="Playground credentials are never copied into Live. Deployment checks that Live bindings exist." /></div>;
}

function SafetySection() {
  return <div className="space-y-4"><CapabilityRow icon={<ShieldCheck className="size-4" />} title="Approval policy" detail="Require a decision before higher-risk actions" status="ready" statusText="Configured" action="Review" /><div className="grid gap-3 sm:grid-cols-3"><InfoTile label="External effects" value="Ask first" icon={<LockKeyhole className="size-4" />} /><InfoTile label="Unknown effects" value="Reconcile" icon={<CircleHelp className="size-4" />} /><InfoTile label="Data access" value="Workspace" icon={<Eye className="size-4" />} /></div><SettingNote title="Every action remains observable" detail="Approvals, denials, retries, and unknown provider effects appear in the run observatory." /></div>;
}

function RuntimeSection({ selectedModel }: { selectedModel?: AgentModel }) {
  return <div className="space-y-4"><div className="grid gap-4 sm:grid-cols-2"><InfoTile label="Context window" value={formatTokens(selectedModel?.contextWindow)} icon={<MemoryStick className="size-4" />} /><InfoTile label="Max output" value={formatTokens(selectedModel?.maxOutputTokens)} icon={<Activity className="size-4" />} /><InfoTile label="Run budget" value="Configured per version" icon={<Clock3 className="size-4" />} /><InfoTile label="Overflow recovery" value="Runtime-managed" icon={<Wrench className="size-4" />} /></div><SettingNote title="Runtime policy stays with the context runtime" detail="This screen exposes the policy and measurements. It does not calculate token usage in the browser." /></div>;
}

function InfoTile({ label, value, icon }: { label: string; value: string; icon: ReactNode }) {
  return <div className="rounded-2xl border border-border bg-card p-4"><div className="flex items-center gap-2 text-muted-foreground">{icon}<span className="text-[11px]">{label}</span></div><p className="mt-3 text-sm font-medium text-foreground">{value}</p></div>;
}

function ConnectionCard({ title, detail, status, statusKind }: { title: string; detail: string; status: string; statusKind: "ready" | "not_configured" }) {
  return <div className="rounded-2xl border border-border bg-card p-4"><div className="flex items-start justify-between gap-3"><div><p className="text-sm font-medium text-foreground">{title}</p><p className="mt-1 text-xs text-muted-foreground">{detail}</p></div><StatusDot status={statusKind} /></div><p className={cn("mt-5 text-xs", statusClass(statusKind))}>{status}</p></div>;
}

function SettingNote({ title, detail }: { title: string; detail: string }) {
  return <div className="flex gap-3 rounded-2xl border border-primary/20 bg-primary/5 p-4"><CircleHelp className="mt-0.5 size-4 shrink-0 text-primary" /><div><p className="text-xs font-medium text-foreground">{title}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p></div></div>;
}

function PrototypeSwitcher({ variant, onChange }: { variant: PrototypeVariant; onChange: (value: PrototypeVariant) => void }) {
  const index = variants.findIndex((item) => item.id === variant);
  const previous = variants[(index - 1 + variants.length) % variants.length];
  const next = variants[(index + 1) % variants.length];
  return <div className="fixed bottom-4 left-1/2 z-[70] flex -translate-x-1/2 items-center gap-2 rounded-full border border-primary/30 bg-slate-950 px-2 py-1.5 text-white shadow-2xl"><button type="button" aria-label={`Previous prototype: ${previous.label}`} onClick={() => onChange(previous.id)} className="rounded-full p-1.5 hover:bg-white/10"><ArrowLeft className="size-3.5" /></button><span className="px-2 text-[10px] font-medium">Prototype {variant.toUpperCase()} · {variants[index].label}</span><button type="button" aria-label={`Next prototype: ${next.label}`} onClick={() => onChange(next.id)} className="rounded-full p-1.5 hover:bg-white/10"><ArrowRight className="size-3.5" /></button></div>;
}
