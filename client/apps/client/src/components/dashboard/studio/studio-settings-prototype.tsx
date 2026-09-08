"use client";

// Prototype question: which settings workspace best exposes an agent's useful
// capabilities without making users learn plugin or MCP terminology?

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Bot,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  Database,
  Eye,
  FlaskConical,
  KeyRound,
  Layers3,
  LockKeyhole,
  MemoryStick,
  Puzzle,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { AgentModelPicker } from "@/components/dashboard/agents/agent-model-picker";
import {
  createAgentMcpProvider,
  discoverAgentMcpProvider,
  disconnectAgentIntegration,
  getAgentInstallationReadiness,
  healthCheckAgentMcpProvider,
  listAgentCapabilities,
  listAgentExtensionPackages,
  listAgentInstallationCapabilities,
  listAgentInstallationIntegrations,
  listAgentMcpProviders,
  listAgentMcpProviderVersions,
  listAgentSkillVersions,
  listAgentSkills,
  listAgentVersionMcpProviders,
  listAgentVersionSkills,
  pinAgentMcpProviderVersion,
  pinAgentSkillVersion,
  publishAgentMcpProviderVersion,
  saveAgentIntegrationApiKey,
  startAgentGoogleCalendarOAuth,
  type AgentCapability,
  type AgentDefinition,
  type AgentExtensionPackage,
  type AgentIntegration,
  type AgentModel,
  type AgentModelCatalog,
  type AgentMcpProvider,
  type AgentMcpProviderVersion,
  type AgentReadiness,
  type AgentSkill,
  type AgentSkillVersion,
  type AgentVersion,
} from "@/lib/agent-platform";
import { cn } from "@/lib/utils";

type SettingsSection = "overview" | "capabilities" | "memory" | "connections" | "safety" | "runtime";
type PrototypeVariant = "a" | "b" | "c";
type ModelSelection = Pick<AgentModel, "provider" | "model">;

export type StudioCapabilityDraft = {
  allowedTools: string[];
  requiredCapabilities: string[];
  allowedSkillIds: string[];
  skillVersionIds: string[];
  mcpProviderVersionIds: string[];
  extensionPackages: unknown[];
  extensionGrants: unknown[];
};

function capabilityDraftFromVersion(version: AgentVersion | null): StudioCapabilityDraft {
  const rawSpec = version?.configuration?.agentSpec;
  const spec = rawSpec && typeof rawSpec === "object" && !Array.isArray(rawSpec) ? rawSpec as Record<string, unknown> : {};
  const objectAt = (key: string) => spec[key] && typeof spec[key] === "object" && !Array.isArray(spec[key]) ? spec[key] as Record<string, unknown> : {};
  const list = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  const capabilities = objectAt("capabilities");
  const skills = objectAt("skills");
  const extensions = objectAt("extensions");
  return {
    allowedTools: list(capabilities.allowedTools),
    requiredCapabilities: list(capabilities.requiredCapabilities),
    allowedSkillIds: list(skills.allowedSkillIds),
    skillVersionIds: [],
    mcpProviderVersionIds: [],
    extensionPackages: Array.isArray(extensions.packages) ? extensions.packages : [],
    extensionGrants: Array.isArray(extensions.grants) ? extensions.grants : [],
  };
}

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
  installationId,
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
  installationId: string | null;
  instructions: string;
  setInstructions: (value: string) => void;
  onSave: (draft?: StudioCapabilityDraft) => Promise<AgentVersion | null> | void;
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
  const [capabilityDraft, setCapabilityDraft] = useState<StudioCapabilityDraft>(() => capabilityDraftFromVersion(version));
  const [capabilitySaving, setCapabilitySaving] = useState(false);
  const [capabilitySaveError, setCapabilitySaveError] = useState<string | null>(null);
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

  const saveSettings = async () => {
    setCapabilitySaveError(null);
    const next = await onSave(capabilityDraft);
    if (!next) return;
    setCapabilitySaving(true);
    try {
      await Promise.all([
        ...capabilityDraft.skillVersionIds.map((skillVersionId) => pinAgentSkillVersion(next.id, skillVersionId)),
        ...capabilityDraft.mcpProviderVersionIds.map((providerVersionId) => pinAgentMcpProviderVersion(next.id, providerVersionId)),
      ]);
    } catch (cause) {
      setCapabilitySaveError(cause instanceof Error ? cause.message : "Draft saved, but a capability could not be pinned");
    } finally {
      setCapabilitySaving(false);
    }
  };

  const content = (
    <SettingsContent
      agent={agent}
      version={version}
      installationId={installationId}
      section={section}
      setSection={setSection}
      instructions={instructions}
      setInstructions={setInstructions}
      onSave={saveSettings}
      saving={saving || capabilitySaving}
      capabilitySaveError={capabilitySaveError}
      capabilityDraft={capabilityDraft}
      setCapabilityDraft={setCapabilityDraft}
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
  installationId,
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
  capabilityDraft,
  setCapabilityDraft,
  capabilitySaveError,
}: {
  agent: AgentDefinition;
  version: AgentVersion | null;
  installationId: string | null;
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
  capabilityDraft: StudioCapabilityDraft;
  setCapabilityDraft: (value: StudioCapabilityDraft | ((current: StudioCapabilityDraft) => StudioCapabilityDraft)) => void;
  capabilitySaveError: string | null;
}) {
  const title = sections.find((item) => item.id === section)?.label ?? "Settings";
  const description = sections.find((item) => item.id === section)?.description ?? "";
  return <div className="mx-auto max-w-4xl px-5 py-6 pb-24 sm:px-8 sm:py-8"><div className="mb-7 flex items-start justify-between gap-4"><div><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Agent settings</p><h3 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-foreground">{title}</h3><p className="mt-1 text-sm text-muted-foreground">{description}</p></div><span className="hidden items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[10px] text-muted-foreground sm:inline-flex"><span className="size-1.5 rounded-full bg-amber-500" />Draft</span></div>{capabilitySaveError ? <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">{capabilitySaveError}</div> : null}{section === "overview" ? <OverviewSection agent={agent} version={version} instructions={instructions} setInstructions={setInstructions} selectedModel={selectedModel} pickerModels={pickerModels} modelCatalog={modelCatalog} modelCatalogLoading={modelCatalogLoading} effectiveSelection={effectiveSelection} setModelSelection={setModelSelection} /> : null}{section === "capabilities" ? <CapabilitiesSection installationId={installationId} versionId={version?.id ?? null} draft={capabilityDraft} onDraftChange={setCapabilityDraft} /> : null}{section === "memory" ? <MemorySection /> : null}{section === "connections" ? <ConnectionsSection /> : null}{section === "safety" ? <SafetySection /> : null}{section === "runtime" ? <RuntimeSection selectedModel={selectedModel} /> : null}<div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5"><p className="text-[11px] text-muted-foreground">Changes apply to the next Playground version.</p><div className="flex items-center gap-2"><Button type="button" variant="outline" size="sm" onClick={() => setSection("overview")}><ArrowLeft className="mr-1.5 size-3.5" />Overview</Button><Button type="button" size="sm" onClick={onSave} disabled={saving}>{saving ? <Clock3 className="mr-1.5 size-3.5 animate-pulse" /> : <Save className="mr-1.5 size-3.5" />}{saving ? "Saving…" : "Save draft"}</Button></div></div></div>;
}

function OverviewSection({ agent, version, instructions, setInstructions, selectedModel, pickerModels, modelCatalog, modelCatalogLoading, effectiveSelection, setModelSelection }: { agent: AgentDefinition; version: AgentVersion | null; instructions: string; setInstructions: (value: string) => void; selectedModel?: AgentModel; pickerModels: AgentModel[]; modelCatalog: AgentModelCatalog | null; modelCatalogLoading: boolean; effectiveSelection: ModelSelection | null; setModelSelection: (value: ModelSelection | null) => void }) {
  return <div className="space-y-5"><div className="grid gap-4 sm:grid-cols-2"><InfoTile label="Agent" value={agent.name} icon={<Bot className="size-4" />} /><InfoTile label="Version" value={version ? `v${version.version_number} · ${version.status}` : "No version"} icon={<Layers3 className="size-4" />} /></div><section className="rounded-2xl border border-border bg-card p-4 sm:p-5"><div className="flex items-center gap-2"><Bot className="size-4 text-primary" /><h4 className="text-sm font-semibold text-foreground">Instructions</h4></div><Textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="Define what this agent should do…" className="mt-4 min-h-44 resize-y text-sm" /></section><section className="rounded-2xl border border-border bg-card p-4 sm:p-5"><div className="flex items-start justify-between gap-4"><div><div className="flex items-center gap-2"><Sparkles className="size-4 text-primary" /><h4 className="text-sm font-semibold text-foreground">Model</h4></div><p className="mt-1 text-xs text-muted-foreground">The model used for the next Playground run.</p></div>{selectedModel ? <span className="text-[11px] text-muted-foreground">{formatTokens(selectedModel.contextWindow)} context</span> : null}</div>{modelCatalogLoading ? <p className="mt-4 text-xs text-muted-foreground">Loading models…</p> : modelCatalog ? <div className="mt-4"><AgentModelPicker model={selectedModel} models={pickerModels} disabled={!pickerModels.length} ariaLabel="Select agent model" pickerTitle="Choose a model" onSelect={(model, provider) => setModelSelection({ model, provider })} />{effectiveSelection ? <p className="mt-2 text-[11px] text-muted-foreground">{effectiveSelection.provider}:{effectiveSelection.model}</p> : null}</div> : <p className="mt-4 text-xs text-muted-foreground">Model catalog unavailable.</p>}</section></div>;
}

const capabilityTabs = [
  { id: "tools", label: "Tools" },
  { id: "services", label: "Services" },
  { id: "skills", label: "Skills" },
  { id: "extensions", label: "Extensions" },
] as const;

type CapabilityTab = (typeof capabilityTabs)[number]["id"];

type CapabilityData = {
  catalog: AgentCapability[];
  installation: AgentCapability[];
  readiness: AgentReadiness | null;
  integrations: AgentIntegration[];
  skills: AgentSkill[];
  pinnedSkills: AgentSkillVersion[];
  mcpProviders: AgentMcpProvider[];
  pinnedMcpProviders: AgentMcpProviderVersion[];
  mcpVersions: Record<string, AgentMcpProviderVersion[]>;
  extensionPackages: AgentExtensionPackage[];
};

const emptyCapabilityData: CapabilityData = {
  catalog: [],
  installation: [],
  readiness: null,
  integrations: [],
  skills: [],
  pinnedSkills: [],
  mcpProviders: [],
  pinnedMcpProviders: [],
  mcpVersions: {},
  extensionPackages: [],
};

async function loadCapabilityData(installationId: string | null, versionId: string | null): Promise<CapabilityData> {
  const [catalogResult, packagesResult, skillsResult, providersResult, installationResult, readinessResult, integrationsResult, pinnedSkillsResult, pinnedMcpResult] = await Promise.all([
    listAgentCapabilities().catch(() => ({ capabilities: [] })),
    listAgentExtensionPackages().catch(() => ({ packages: [] })),
    listAgentSkills().catch(() => ({ skills: [] })),
    listAgentMcpProviders().catch(() => ({ providers: [] })),
    installationId ? listAgentInstallationCapabilities(installationId).catch(() => ({ capabilities: [] })) : Promise.resolve({ capabilities: [] }),
    installationId ? getAgentInstallationReadiness(installationId).catch(() => null) : Promise.resolve(null),
    installationId ? listAgentInstallationIntegrations(installationId).catch(() => ({ integrations: [] })) : Promise.resolve({ integrations: [] }),
    versionId ? listAgentVersionSkills(versionId).catch(() => ({ skills: [] })) : Promise.resolve({ skills: [] }),
    versionId ? listAgentVersionMcpProviders(versionId).catch(() => ({ providers: [] })) : Promise.resolve({ providers: [] }),
  ]);
  const mcpVersionsEntries = await Promise.all(providersResult.providers.map(async (provider) => {
    const result = await listAgentMcpProviderVersions(provider.id).catch(() => ({ versions: [] }));
    return [provider.id, result.versions] as const;
  }));
  return {
    catalog: catalogResult.capabilities,
    extensionPackages: packagesResult.packages,
    installation: installationResult.capabilities,
    readiness: readinessResult,
    integrations: integrationsResult.integrations,
    skills: skillsResult.skills,
    pinnedSkills: pinnedSkillsResult.skills,
    mcpProviders: providersResult.providers,
    pinnedMcpProviders: pinnedMcpResult.providers,
    mcpVersions: Object.fromEntries(mcpVersionsEntries),
  };
}

function CapabilitiesSection({ installationId, versionId, draft, onDraftChange }: { installationId: string | null; versionId: string | null; draft: StudioCapabilityDraft; onDraftChange: (value: StudioCapabilityDraft | ((current: StudioCapabilityDraft) => StudioCapabilityDraft)) => void }) {
  const [activeTab, setActiveTab] = useState<CapabilityTab>("tools");
  const [data, setData] = useState<CapabilityData>(emptyCapabilityData);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    let mounted = true;
    void loadCapabilityData(installationId, versionId).then((next) => {
      if (mounted) {
        setData(next);
        onDraftChange((current) => ({
          ...current,
          skillVersionIds: current.skillVersionIds.length ? current.skillVersionIds : next.pinnedSkills.map((skill) => skill.id),
          allowedSkillIds: current.allowedSkillIds.length ? current.allowedSkillIds : [...new Set(next.pinnedSkills.map((skill) => skill.skill_definition_id))],
          mcpProviderVersionIds: current.mcpProviderVersionIds.length ? current.mcpProviderVersionIds : next.pinnedMcpProviders.map((provider) => provider.id),
        }));
        setLoading(false);
      }
    }).catch(() => {
      if (mounted) {
        setError("Capabilities could not be loaded");
        setLoading(false);
      }
    });
    return () => { mounted = false; };
  }, [installationId, onDraftChange, versionId, refreshKey]);

  const refresh = () => {
    setLoading(true);
    setError(null);
    setRefreshKey((current) => current + 1);
  };
  const tools = data.installation.length ? data.installation : data.catalog;
  const connectedServices = data.integrations.filter((integration) => integration.status === "connected").length;
  const enabledSkillIds = new Set(draft.allowedSkillIds);
  const enabledMcpIds = new Set(draft.mcpProviderVersionIds);
  const extensionCount = enabledMcpIds.size + draft.extensionPackages.length;
  const tabCount = (tab: CapabilityTab) => {
    if (loading) return "…";
    if (tab === "tools") return String(tools.length);
    if (tab === "services") return String(connectedServices);
    if (tab === "skills") return String(enabledSkillIds.size);
    return String(extensionCount);
  };
  const activeTabLabel = capabilityTabs.find((tab) => tab.id === activeTab)?.label ?? "Tools";

  return <div className="space-y-4">
    <p className="max-w-2xl text-xs leading-5 text-muted-foreground">Choose what this Playground version can use. Changes are pinned when the draft is saved.</p>
    {error ? <div className="flex items-center justify-between rounded-xl border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive"><span>{error}</span><Button type="button" variant="outline" size="sm" className="h-7" onClick={refresh}>Retry</Button></div> : null}
    <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as CapabilityTab)} className="gap-4">
      <TabsList aria-label="Capabilities" className="h-auto w-full justify-start overflow-x-auto rounded-xl border border-border bg-muted/30 p-1">
        {capabilityTabs.map((tab) => <TabsTrigger key={tab.id} value={tab.id} className="min-w-[7rem] flex-1 gap-2 px-3 py-2 text-xs"><span>{tab.label}</span><span className="min-w-5 rounded-full bg-muted px-1.5 py-0.5 text-center text-[10px] text-muted-foreground data-[state=active]:bg-primary/10 data-[state=active]:text-primary">{tabCount(tab.id)}</span></TabsTrigger>)}
      </TabsList>
      <TabsContent value={activeTab} className="rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-5">
        <div className="mb-4 flex items-center justify-between gap-3"><div><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Capabilities</p><h4 className="mt-1 text-sm font-semibold text-foreground">{activeTabLabel}</h4></div>{loading ? <span className="text-[11px] text-muted-foreground">Loading…</span> : null}</div>
        {activeTab === "tools" ? <ToolsPanel tools={tools} draft={draft} onDraftChange={onDraftChange} /> : null}{activeTab === "services" ? <ServicesPanel installationId={installationId} integrations={data.integrations} onRefresh={refresh} /> : null}{activeTab === "skills" ? <SkillsPanel skills={data.skills} pinnedSkills={data.pinnedSkills} draft={draft} onDraftChange={onDraftChange} /> : null}{activeTab === "extensions" ? <ExtensionsPanel packages={data.extensionPackages} providers={data.mcpProviders} pinnedProviders={data.pinnedMcpProviders} versions={data.mcpVersions} draft={draft} onDraftChange={onDraftChange} onRefresh={refresh} /> : null}
      </TabsContent>
    </Tabs>
    <details className="rounded-2xl border border-border bg-card p-4"><summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium text-foreground"><span className="flex items-center gap-2"><Eye className="size-4 text-muted-foreground" />Advanced source details</span><ChevronDown className="size-4 text-muted-foreground" /></summary><p className="mt-3 max-w-2xl text-xs leading-5 text-muted-foreground">Technical package versions, MCP endpoints, discovered tool schemas, checksums, and provider health stay available here when debugging.</p></details>
  </div>;
}

function ToolsPanel({ tools, draft, onDraftChange }: { tools: AgentCapability[]; draft: StudioCapabilityDraft; onDraftChange: (value: StudioCapabilityDraft | ((current: StudioCapabilityDraft) => StudioCapabilityDraft)) => void }) {
  const allNames = tools.map((tool) => tool.name);
  const selectedNames = new Set(draft.allowedTools.length ? draft.allowedTools : allNames);
  const toggle = (name: string) => {
    onDraftChange((current) => {
      const selected = new Set(current.allowedTools.length ? current.allowedTools : allNames);
      if (selected.has(name)) selected.delete(name);
      else selected.add(name);
      return { ...current, allowedTools: [...selected] };
    });
  };
  if (!tools.length) return <p className="text-xs text-muted-foreground">No workspace tools are available for this installation.</p>;
  return <div className="space-y-2"><p className="text-xs text-muted-foreground">Tools are explicit capabilities. Approval and credential checks still apply at runtime.</p><div className="divide-y divide-border rounded-xl border border-border">{tools.map((tool) => <label key={`${tool.name}:${tool.version}`} className="flex cursor-pointer items-start gap-3 p-3"><input type="checkbox" checked={selectedNames.has(tool.name)} onChange={() => toggle(tool.name)} className="mt-0.5 accent-[var(--brand)]" /><span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-2 text-xs font-medium text-foreground"><span>{tool.name}</span>{tool.requiresApproval ? <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">Approval</span> : null}</span><span className="mt-1 block text-[11px] leading-4 text-muted-foreground">{tool.description || "No description"}</span></span><span className={cn("text-[10px]", tool.availability === "available" ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300")}>{tool.availability}</span></label>)}</div></div>;
}

function ServicesPanel({ installationId, integrations, onRefresh }: { installationId: string | null; integrations: AgentIntegration[]; onRefresh: () => void }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  if (!installationId) return <p className="text-xs text-muted-foreground">Install this agent in Playground before connecting services.</p>;
  const connect = async (integration: AgentIntegration) => {
    setBusyId(integration.id);
    setError(null);
    try {
      if (integration.auth === "oauth2" && integration.id === "google.calendar") {
        const result = await startAgentGoogleCalendarOAuth(installationId);
        window.location.assign(result.authorizationUrl);
        return;
      }
      if (integration.auth === "api_key") {
        const apiKey = apiKeys[integration.id]?.trim();
        if (!apiKey) {
          setError(`Enter a key for ${integration.name}`);
          return;
        }
        await saveAgentIntegrationApiKey(installationId, integration.id, { apiKey });
        setApiKeys((current) => ({ ...current, [integration.id]: "" }));
        onRefresh();
        return;
      }
      setError(`${integration.name} requires its connector setup first`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Unable to connect ${integration.name}`);
    } finally {
      setBusyId(null);
    }
  };
  const disconnect = async (integration: AgentIntegration) => {
    setBusyId(integration.id);
    setError(null);
    try {
      await disconnectAgentIntegration(installationId, integration.id);
      onRefresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Unable to disconnect ${integration.name}`);
    } finally {
      setBusyId(null);
    }
  };
  return <div className="space-y-3"><p className="text-xs text-muted-foreground">Connections belong to the installation. Playground and Live credentials stay separate.</p>{error ? <p className="rounded-lg bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</p> : null}{integrations.length ? integrations.map((integration) => <div key={integration.id} className="rounded-xl border border-border p-3"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="text-xs font-medium text-foreground">{integration.name}</p><p className="mt-1 text-[11px] text-muted-foreground">{integration.description}</p></div><span className={cn("text-[10px]", integration.status === "connected" ? "text-emerald-700 dark:text-emerald-300" : "text-muted-foreground")}>{integration.status.replaceAll("_", " ")}</span></div>{integration.status === "connected" ? <Button type="button" variant="outline" size="sm" className="mt-3 h-8" onClick={() => void disconnect(integration)} disabled={busyId === integration.id}>{busyId === integration.id ? "Working…" : "Disconnect"}</Button> : integration.auth === "api_key" ? <div className="mt-3 flex gap-2"><input type="password" value={apiKeys[integration.id] ?? ""} onChange={(event) => setApiKeys((current) => ({ ...current, [integration.id]: event.target.value }))} placeholder="API key" className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary" /><Button type="button" size="sm" className="h-8" onClick={() => void connect(integration)} disabled={busyId === integration.id}>{busyId === integration.id ? "Saving…" : "Connect"}</Button></div> : <Button type="button" variant="outline" size="sm" className="mt-3 h-8" onClick={() => void connect(integration)} disabled={busyId === integration.id}>{busyId === integration.id ? "Opening…" : integration.auth === "oauth2" ? "Connect" : "Configure"}</Button>}</div>) : <p className="rounded-xl border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">No services are available for this installation.</p>}</div>;
}

function SkillsPanel({ skills, pinnedSkills, draft, onDraftChange }: { skills: AgentSkill[]; pinnedSkills: AgentSkillVersion[]; draft: StudioCapabilityDraft; onDraftChange: (value: StudioCapabilityDraft | ((current: StudioCapabilityDraft) => StudioCapabilityDraft)) => void }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [draftVersions, setDraftVersions] = useState<Record<string, string>>({});
  const selected = new Set(draft.allowedSkillIds);
  const toggle = async (skill: AgentSkill) => {
    setBusyId(skill.id);
    try {
      if (selected.has(skill.id)) {
        const pinnedVersionIds = pinnedSkills.filter((version) => version.skill_definition_id === skill.id).map((version) => version.id);
        const draftVersionId = draftVersions[skill.id];
        onDraftChange((current) => ({ ...current, allowedSkillIds: current.allowedSkillIds.filter((id) => id !== skill.id), skillVersionIds: current.skillVersionIds.filter((id) => !pinnedVersionIds.includes(id) && id !== draftVersionId) }));
        setDraftVersions((current) => { const next = { ...current }; delete next[skill.id]; return next; });
        return;
      }
      const result = await listAgentSkillVersions(skill.id);
      const latest = result.versions.filter((version) => version.status === "published").sort((left, right) => right.version_number - left.version_number)[0];
      if (!latest) return;
      setDraftVersions((current) => ({ ...current, [skill.id]: latest.id }));
      onDraftChange((current) => ({ ...current, allowedSkillIds: [...new Set([...current.allowedSkillIds, skill.id])], skillVersionIds: [...new Set([...current.skillVersionIds, latest.id])] }));
    } finally {
      setBusyId(null);
    }
  };
  const publishedSkills = skills.filter((skill) => skill.status === "published");
  return <div className="space-y-3"><p className="text-xs text-muted-foreground">Skills are versioned and pinned to the draft. A skill can declare required tools or connectors.</p>{publishedSkills.length ? <div className="divide-y divide-border rounded-xl border border-border">{publishedSkills.map((skill) => <div key={skill.id} className="flex items-center gap-3 p-3"><Sparkles className="size-4 shrink-0 text-primary" /><div className="min-w-0 flex-1"><p className="text-xs font-medium text-foreground">{skill.name}</p><p className="mt-1 text-[11px] text-muted-foreground">{skill.description || skill.slug}</p></div><Button type="button" variant={selected.has(skill.id) ? "default" : "outline"} size="sm" className="h-8" onClick={() => void toggle(skill)} disabled={busyId === skill.id}>{busyId === skill.id ? "Loading…" : selected.has(skill.id) ? "Enabled" : "Enable"}</Button></div>)}</div> : <p className="rounded-xl border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">No published skills are available.</p>}</div>;
}

function ExtensionsPanel({ packages, providers, pinnedProviders, versions, draft, onDraftChange, onRefresh }: { packages: AgentExtensionPackage[]; providers: AgentMcpProvider[]; pinnedProviders: AgentMcpProviderVersion[]; versions: Record<string, AgentMcpProviderVersion[]>; draft: StudioCapabilityDraft; onDraftChange: (value: StudioCapabilityDraft | ((current: StudioCapabilityDraft) => StudioCapabilityDraft)) => void; onRefresh: () => void }) {
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pinnedIds = new Set(draft.mcpProviderVersionIds.length ? draft.mcpProviderVersionIds : pinnedProviders.map((provider) => provider.id));
  const addServer = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!name.trim() || !endpoint.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const provider = await createAgentMcpProvider({ name: name.trim(), endpointUrl: endpoint.trim() });
      const discovered = await discoverAgentMcpProvider(provider.id);
      const published = await publishAgentMcpProviderVersion(provider.id, discovered.id);
      onDraftChange((current) => ({ ...current, mcpProviderVersionIds: [...new Set([...current.mcpProviderVersionIds, published.id])] }));
      setName("");
      setEndpoint("");
      onRefresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to add MCP server");
    } finally {
      setBusy(false);
    }
  };
  const health = async (providerId: string) => {
    setBusy(true);
    setError(null);
    try {
      await healthCheckAgentMcpProvider(providerId);
      onRefresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "MCP health check failed");
    } finally {
      setBusy(false);
    }
  };
  const togglePackage = (pkg: AgentExtensionPackage) => {
    const reference = { kind: pkg.kind, id: pkg.package_id, version: pkg.version, checksum: pkg.checksum, configuration: {} };
    const declaration = pkg.declaration;
    const permissions = Array.isArray(declaration.permissions) ? declaration.permissions.filter((permission): permission is string => typeof permission === "string") : [];
    const grant = { kind: pkg.kind, id: pkg.package_id, permissions };
    const selected = draft.extensionPackages.some((entry) => entry && typeof entry === "object" && !Array.isArray(entry) && (entry as Record<string, unknown>).kind === pkg.kind && (entry as Record<string, unknown>).id === pkg.package_id && (entry as Record<string, unknown>).version === pkg.version);
    onDraftChange((current) => ({
      ...current,
      extensionPackages: selected ? current.extensionPackages.filter((entry) => !(entry && typeof entry === "object" && !Array.isArray(entry) && (entry as Record<string, unknown>).kind === pkg.kind && (entry as Record<string, unknown>).id === pkg.package_id && (entry as Record<string, unknown>).version === pkg.version)) : [...current.extensionPackages, reference],
      extensionGrants: selected ? current.extensionGrants.filter((entry) => !(entry && typeof entry === "object" && !Array.isArray(entry) && (entry as Record<string, unknown>).kind === pkg.kind && (entry as Record<string, unknown>).id === pkg.package_id)) : [...current.extensionGrants, grant],
    }));
  };
  const publishedPackages = packages.filter((pkg) => pkg.status === "published" && pkg.kind === "plugin");
  return <div className="space-y-4"><div><p className="text-xs text-muted-foreground">MCP servers are discovered, reviewed, and pinned by published version. Plugins and other declarative packages are enabled explicitly for this draft.</p></div>{error ? <p className="rounded-lg bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</p> : null}<form onSubmit={addServer} className="grid gap-2 rounded-xl border border-border p-3 sm:grid-cols-[minmax(0,0.7fr)_minmax(0,1fr)_auto]"><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Server name" className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary" /><input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://server.example/mcp" type="url" className="h-8 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary" /><Button type="submit" size="sm" className="h-8" disabled={busy || !name.trim() || !endpoint.trim()}>{busy ? "Adding…" : "Add MCP"}</Button></form>{publishedPackages.length ? <div className="space-y-2"><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Published packages</p>{publishedPackages.map((pkg) => { const enabled = draft.extensionPackages.some((entry) => entry && typeof entry === "object" && !Array.isArray(entry) && (entry as Record<string, unknown>).kind === pkg.kind && (entry as Record<string, unknown>).id === pkg.package_id && (entry as Record<string, unknown>).version === pkg.version); return <div key={pkg.id} className="flex items-center gap-3 rounded-xl border border-border p-3"><Puzzle className="size-4 shrink-0 text-primary" /><div className="min-w-0 flex-1"><p className="text-xs font-medium text-foreground">{pkg.name || pkg.package_id}</p><p className="mt-1 text-[11px] text-muted-foreground">{pkg.kind} · v{pkg.version} · {pkg.checksum.slice(0, 10)}</p></div><Button type="button" variant={enabled ? "default" : "outline"} size="sm" className="h-8" onClick={() => togglePackage(pkg)}>{enabled ? "Enabled" : "Enable"}</Button></div>; })}</div> : null}{providers.length ? <div className="space-y-2"><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">MCP servers</p>{providers.map((provider) => { const published = (versions[provider.id] ?? []).filter((version) => version.status === "published").sort((left, right) => right.revision - left.revision)[0]; const enabled = Boolean(published && pinnedIds.has(published.id)); return <div key={provider.id} className="rounded-xl border border-border p-3"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><p className="text-xs font-medium text-foreground">{provider.name}</p><p className="mt-1 truncate text-[11px] text-muted-foreground">{provider.endpoint_url}</p></div><span className={cn("text-[10px]", provider.health_status === "healthy" ? "text-emerald-700 dark:text-emerald-300" : "text-amber-700 dark:text-amber-300")}>{provider.health_status}</span></div><div className="mt-3 flex flex-wrap items-center gap-2"><span className="text-[10px] text-muted-foreground">{published ? `${published.tools.length} tools · v${published.revision}` : "Not published"}</span><Button type="button" variant="outline" size="sm" className="ml-auto h-8" onClick={() => void health(provider.id)} disabled={busy}>Health</Button><Button type="button" variant={enabled ? "default" : "outline"} size="sm" className="h-8" disabled={!published} onClick={() => { if (!published) return; onDraftChange((current) => ({ ...current, mcpProviderVersionIds: enabled ? current.mcpProviderVersionIds.filter((id) => id !== published.id) : [...new Set([...current.mcpProviderVersionIds, published.id])] })); }}>{enabled ? "Enabled" : "Enable"}</Button></div></div>; })}</div> : <p className="rounded-xl border border-dashed border-border px-3 py-4 text-xs text-muted-foreground">No MCP servers configured.</p>}</div>;
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
