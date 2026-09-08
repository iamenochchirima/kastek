"use client";

// Prototype question: which settings workspace best exposes an agent's useful
// capabilities without making users learn plugin or MCP terminology?

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import Image from "next/image";
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
  Plus,
  PlugZap,
  Puzzle,
  Search,
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
import { AgentToolIntegrations } from "@/components/dashboard/agents/agent-tool-integrations";
import { InstallationIntegrations } from "@/components/dashboard/agents/agent-detail-page-client";
import {
  createAgentMcpProvider,
  discoverAgentMcpProvider,
  getAgentInstallationReadiness,
  healthCheckAgentMcpProvider,
  listAgentCapabilities,
  listAgentCapabilityDirectory,
  listAgentExtensionPackages,
  listAgentInstallationCapabilities,
  listAgentMcpProviders,
  listAgentMcpProviderVersions,
  listAgentSkillVersions,
  listAgentSkills,
  listAgentVersionMcpProviders,
  listAgentVersionSkills,
  pinAgentMcpProviderVersion,
  pinAgentSkillVersion,
  publishAgentMcpProviderVersion,
  type AgentCapability,
  type AgentCapabilityDirectoryEntry,
  type AgentCapabilityToolset,
  type AgentDefinition,
  type AgentExtensionPackage,
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

type SettingsSection = "overview" | "capabilities" | "memory" | "gateways" | "safety" | "runtime";
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
  { id: "gateways", label: "Gateways", description: "Channels and surfaces" },
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
  if (section === "gateways") return <KeyRound className="size-3.5" />;
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
  return <div className="mx-auto max-w-4xl px-5 py-6 pb-24 sm:px-8 sm:py-8"><div className="mb-7 flex items-start justify-between gap-4"><div><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Agent settings</p><h3 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-foreground">{title}</h3><p className="mt-1 text-sm text-muted-foreground">{description}</p></div><span className="hidden items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[10px] text-muted-foreground sm:inline-flex"><span className="size-1.5 rounded-full bg-amber-500" />Draft</span></div>{capabilitySaveError ? <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">{capabilitySaveError}</div> : null}{section === "overview" ? <OverviewSection agent={agent} version={version} instructions={instructions} setInstructions={setInstructions} selectedModel={selectedModel} pickerModels={pickerModels} modelCatalog={modelCatalog} modelCatalogLoading={modelCatalogLoading} effectiveSelection={effectiveSelection} setModelSelection={setModelSelection} /> : null}{section === "capabilities" ? <CapabilitiesSection installationId={installationId} versionId={version?.id ?? null} draft={capabilityDraft} onDraftChange={setCapabilityDraft} /> : null}{section === "memory" ? <MemorySection /> : null}{section === "gateways" ? <GatewaysSection agent={agent} installationId={installationId} /> : null}{section === "safety" ? <SafetySection /> : null}{section === "runtime" ? <RuntimeSection selectedModel={selectedModel} /> : null}<div className="mt-8 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5"><p className="text-[11px] text-muted-foreground">Changes apply to the next Playground version.</p><div className="flex items-center gap-2"><Button type="button" variant="outline" size="sm" onClick={() => setSection("overview")}><ArrowLeft className="mr-1.5 size-3.5" />Overview</Button><Button type="button" size="sm" onClick={onSave} disabled={saving}>{saving ? <Clock3 className="mr-1.5 size-3.5 animate-pulse" /> : <Save className="mr-1.5 size-3.5" />}{saving ? "Saving…" : "Save draft"}</Button></div></div></div>;
}

function OverviewSection({ agent, version, instructions, setInstructions, selectedModel, pickerModels, modelCatalog, modelCatalogLoading, effectiveSelection, setModelSelection }: { agent: AgentDefinition; version: AgentVersion | null; instructions: string; setInstructions: (value: string) => void; selectedModel?: AgentModel; pickerModels: AgentModel[]; modelCatalog: AgentModelCatalog | null; modelCatalogLoading: boolean; effectiveSelection: ModelSelection | null; setModelSelection: (value: ModelSelection | null) => void }) {
  return <div className="space-y-5"><div className="grid gap-4 sm:grid-cols-2"><InfoTile label="Agent" value={agent.name} icon={<Bot className="size-4" />} /><InfoTile label="Version" value={version ? `v${version.version_number} · ${version.status}` : "No version"} icon={<Layers3 className="size-4" />} /></div><section className="rounded-2xl border border-border bg-card p-4 sm:p-5"><div className="flex items-center gap-2"><Bot className="size-4 text-primary" /><h4 className="text-sm font-semibold text-foreground">Instructions</h4></div><Textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} placeholder="Define what this agent should do…" className="mt-4 min-h-44 resize-y text-sm" /></section><section className="rounded-2xl border border-border bg-card p-4 sm:p-5"><div className="flex items-start justify-between gap-4"><div><div className="flex items-center gap-2"><Sparkles className="size-4 text-primary" /><h4 className="text-sm font-semibold text-foreground">Model</h4></div><p className="mt-1 text-xs text-muted-foreground">The model used for the next Playground run.</p></div>{selectedModel ? <span className="text-[11px] text-muted-foreground">{formatTokens(selectedModel.contextWindow)} context</span> : null}</div>{modelCatalogLoading ? <p className="mt-4 text-xs text-muted-foreground">Loading models…</p> : modelCatalog ? <div className="mt-4"><AgentModelPicker model={selectedModel} models={pickerModels} disabled={!pickerModels.length} ariaLabel="Select agent model" pickerTitle="Choose a model" onSelect={(model, provider) => setModelSelection({ model, provider })} />{effectiveSelection ? <p className="mt-2 text-[11px] text-muted-foreground">{effectiveSelection.provider}:{effectiveSelection.model}</p> : null}</div> : <p className="mt-4 text-xs text-muted-foreground">Model catalog unavailable.</p>}</section></div>;
}

const capabilityTabs = [
  { id: "tools", label: "Tools" },
  { id: "skills", label: "Skills" },
  { id: "plugins", label: "Plugins" },
  { id: "connections", label: "Connections" },
  { id: "user_tools", label: "User tools" },
] as const;

type CapabilityTab = (typeof capabilityTabs)[number]["id"];

type CapabilityData = {
  directory: AgentCapabilityDirectoryEntry[];
  toolsets: AgentCapabilityToolset[];
  catalog: AgentCapability[];
  installation: AgentCapability[];
  readiness: AgentReadiness | null;
  skills: AgentSkill[];
  pinnedSkills: AgentSkillVersion[];
  mcpProviders: AgentMcpProvider[];
  pinnedMcpProviders: AgentMcpProviderVersion[];
  mcpVersions: Record<string, AgentMcpProviderVersion[]>;
  extensionPackages: AgentExtensionPackage[];
};

const emptyCapabilityData: CapabilityData = {
  directory: [],
  toolsets: [],
  catalog: [],
  installation: [],
  readiness: null,
  skills: [],
  pinnedSkills: [],
  mcpProviders: [],
  pinnedMcpProviders: [],
  mcpVersions: {},
  extensionPackages: [],
};

async function loadCapabilityData(installationId: string | null, versionId: string | null): Promise<CapabilityData> {
  const [directoryResult, catalogResult, packagesResult, skillsResult, providersResult, installationResult, readinessResult, pinnedSkillsResult, pinnedMcpResult] = await Promise.all([
    listAgentCapabilityDirectory(),
    listAgentCapabilities().catch(() => ({ capabilities: [] })),
    listAgentExtensionPackages().catch(() => ({ packages: [] })),
    listAgentSkills().catch(() => ({ skills: [] })),
    listAgentMcpProviders().catch(() => ({ providers: [] })),
    installationId ? listAgentInstallationCapabilities(installationId).catch(() => ({ capabilities: [] })) : Promise.resolve({ capabilities: [] }),
    installationId ? getAgentInstallationReadiness(installationId).catch(() => null) : Promise.resolve(null),
    versionId ? listAgentVersionSkills(versionId).catch(() => ({ skills: [] })) : Promise.resolve({ skills: [] }),
    versionId ? listAgentVersionMcpProviders(versionId).catch(() => ({ providers: [] })) : Promise.resolve({ providers: [] }),
  ]);
  const mcpVersionsEntries = await Promise.all(providersResult.providers.map(async (provider) => {
    const result = await listAgentMcpProviderVersions(provider.id).catch(() => ({ versions: [] }));
    return [provider.id, result.versions] as const;
  }));
  return {
    directory: directoryResult.directory,
    toolsets: directoryResult.toolsets,
    catalog: catalogResult.capabilities,
    extensionPackages: packagesResult.packages,
    installation: installationResult.capabilities,
    readiness: readinessResult,
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
  const plugins = data.extensionPackages.filter((pkg) => pkg.status === "published" && pkg.kind === "plugin");
  const directoryTools = data.directory.filter((entry) => ["builtin_tool", "connector_tool", "plugin_tool", "mcp_tool", "user_tool"].includes(entry.kind));
  const directorySkills = data.directory.filter((entry) => entry.kind === "skill");
  const directoryPlugins = data.directory.filter((entry) => entry.kind === "plugin");
  const directoryMcpServers = data.directory.filter((entry) => entry.kind === "mcp_server");
  const directoryConnections = data.directory.filter((entry) => entry.kind === "connector" || entry.kind === "mcp_server");
  const directoryUserTools = data.directory.filter((entry) => entry.kind === "user_tool");
  const tabCount = (tab: CapabilityTab) => {
    if (loading) return "…";
    if (tab === "tools") return String(directoryTools.length);
    if (tab === "skills") return String(directorySkills.length);
    if (tab === "plugins") return String(directoryPlugins.length);
    if (tab === "connections") return String(directoryConnections.length);
    return String(directoryUserTools.length);
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
        {activeTab === "tools" ? <ToolsPanel tools={directoryTools} toolsets={data.toolsets} draft={draft} onDraftChange={onDraftChange} /> : null}{activeTab === "skills" ? <SkillsPanel directory={directorySkills} skills={data.skills} pinnedSkills={data.pinnedSkills} draft={draft} onDraftChange={onDraftChange} /> : null}{activeTab === "plugins" ? <PluginsPanel directory={directoryPlugins} packages={plugins} draft={draft} onDraftChange={onDraftChange} /> : null}{activeTab === "connections" ? <ConnectionCapabilitiesPanel installationId={installationId} directory={directoryConnections} mcpDirectory={directoryMcpServers} providers={data.mcpProviders} pinnedProviders={data.pinnedMcpProviders} versions={data.mcpVersions} draft={draft} onDraftChange={onDraftChange} onRefresh={refresh} /> : null}{activeTab === "user_tools" ? <UserToolsPanel tools={directoryUserTools} draft={draft} onDraftChange={onDraftChange} /> : null}
      </TabsContent>
    </Tabs>
    <details className="rounded-2xl border border-border bg-card p-4"><summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-sm font-medium text-foreground"><span className="flex items-center gap-2"><Eye className="size-4 text-muted-foreground" />Advanced source details</span><ChevronDown className="size-4 text-muted-foreground" /></summary><p className="mt-3 max-w-2xl text-xs leading-5 text-muted-foreground">Technical package versions, MCP endpoints, discovered tool schemas, checksums, and provider health stay available here when debugging.</p></details>
  </div>;
}

const directoryTones = [
  "bg-violet-500/15 text-violet-300",
  "bg-sky-500/15 text-sky-300",
  "bg-emerald-500/15 text-emerald-300",
  "bg-amber-500/15 text-amber-300",
  "bg-rose-500/15 text-rose-300",
  "bg-cyan-500/15 text-cyan-300",
];

function directoryTone(label: string) {
  const index = [...label].reduce((sum, character) => sum + character.charCodeAt(0), 0) % directoryTones.length;
  return directoryTones[index];
}

function DirectoryIcon({ label, icon, logo }: { label: string; icon: ReactNode; logo?: string }) {
  if (["google-calendar", "apple", "tavily"].includes(logo ?? "")) {
    return <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-border bg-background"><Image src={`/images/integrations/${logo}.svg`} alt="" width={32} height={32} className="size-8 rounded-lg" /></span>;
  }
  return <span className={cn("grid size-11 shrink-0 place-items-center rounded-xl", directoryTone(label))}>{icon}</span>;
}

function DirectorySearch({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return <label className="relative block w-full sm:max-w-xs"><Search className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" /><input value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="h-9 w-full rounded-lg border border-border bg-background pl-9 pr-3 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-primary" /></label>;
}

function ToolsPanel({ tools, toolsets, draft, onDraftChange }: { tools: AgentCapabilityDirectoryEntry[]; toolsets: AgentCapabilityToolset[]; draft: StudioCapabilityDraft; onDraftChange: (value: StudioCapabilityDraft | ((current: StudioCapabilityDraft) => StudioCapabilityDraft)) => void }) {
  const [query, setQuery] = useState("");
  const allNames = tools.filter((tool) => tool.kind === "builtin_tool" || tool.kind === "connector_tool").map((tool) => tool.id);
  const selectedNames = new Set(draft.allowedTools.length ? draft.allowedTools : allNames);
  const filteredTools = tools.filter((tool) => `${tool.id} ${tool.name} ${tool.description} ${tool.tags.join(" ")}`.toLowerCase().includes(query.trim().toLowerCase()));
  const toggle = (name: string) => {
    onDraftChange((current) => {
      const selected = new Set(current.allowedTools.length ? current.allowedTools : allNames);
      if (selected.has(name)) selected.delete(name);
      else selected.add(name);
      return { ...current, allowedTools: [...selected] };
    });
  };
  if (!tools.length) return <p className="text-xs text-muted-foreground">No workspace tools are available for this installation.</p>;
  return <div className="space-y-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><p className="text-xs text-muted-foreground">All executable tools discovered by the platform registry.</p><DirectorySearch value={query} onChange={setQuery} placeholder="Search tools" /></div>{toolsets.length ? <div className="flex flex-wrap gap-1.5">{toolsets.slice(0, 12).map((toolset) => <span key={`${toolset.id}:${toolset.version}`} className="rounded-full border border-border bg-muted/30 px-2 py-1 text-[10px] text-muted-foreground">{toolset.name} · {toolset.capabilityIds.length}</span>)}{toolsets.length > 12 ? <span className="rounded-full border border-border bg-muted/30 px-2 py-1 text-[10px] text-muted-foreground">+{toolsets.length - 12} toolsets</span> : null}</div> : null}<div className="grid gap-3 sm:grid-cols-2">{filteredTools.map((tool) => { const grantable = tool.kind === "builtin_tool" || tool.kind === "connector_tool"; const selected = selectedNames.has(tool.id); const sourceLabel = tool.kind.replaceAll("_", " "); return <label key={`${tool.id}:${tool.version}`} className={cn("group flex items-center gap-3 rounded-xl border border-border p-3 transition-colors", grantable ? "cursor-pointer hover:border-primary/40 hover:bg-muted/20" : "cursor-default opacity-75")}><input type="checkbox" checked={selected} onChange={() => grantable && toggle(tool.id)} disabled={!grantable} className="sr-only" /><DirectoryIcon label={tool.name} logo={tool.logo} icon={tool.kind === "mcp_tool" ? <PlugZap className="size-5" /> : tool.kind === "plugin_tool" ? <Puzzle className="size-5" /> : tool.kind === "user_tool" ? <Bot className="size-5" /> : <Wrench className="size-5" />} /><span className="min-w-0 flex-1"><span className="flex flex-wrap items-center gap-2 text-xs font-medium text-foreground"><span className="truncate">{tool.name}</span>{tool.runtime.requiresApproval ? <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[10px] text-amber-700 dark:text-amber-300">Approval</span> : null}</span><span className="mt-1 block line-clamp-2 text-[11px] leading-4 text-muted-foreground">{tool.description || "No description"}</span><span className="mt-1 block text-[10px] capitalize text-muted-foreground/70">{sourceLabel} · v{tool.version}</span></span><span className={cn("grid size-7 shrink-0 place-items-center rounded-lg", !grantable ? "bg-muted text-muted-foreground" : selected ? "bg-emerald-500/15 text-emerald-400" : "bg-muted text-muted-foreground")}>{!grantable ? <LockKeyhole className="size-3.5" /> : selected ? <Check className="size-4" /> : <Plus className="size-4" />}</span></label>; })}</div>{!filteredTools.length ? <p className="rounded-xl border border-dashed border-border px-3 py-5 text-center text-xs text-muted-foreground">No tools match this search.</p> : null}</div>;
}

function SkillsPanel({ directory, skills, pinnedSkills, draft, onDraftChange }: { directory: AgentCapabilityDirectoryEntry[]; skills: AgentSkill[]; pinnedSkills: AgentSkillVersion[]; draft: StudioCapabilityDraft; onDraftChange: (value: StudioCapabilityDraft | ((current: StudioCapabilityDraft) => StudioCapabilityDraft)) => void }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [draftVersions, setDraftVersions] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
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
  const directorySkillNames = new Set(directory.map((entry) => entry.name));
  const publishedSkills = skills.filter((skill) => skill.status === "published" && (!directory.length || directorySkillNames.has(skill.name)));
  const filteredSkills = publishedSkills.filter((skill) => `${skill.name} ${skill.slug} ${skill.description ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <div className="space-y-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><p className="text-xs text-muted-foreground">{directory.length} published skill version{directory.length === 1 ? "" : "s"} discovered from the registry.</p><DirectorySearch value={query} onChange={setQuery} placeholder="Search skills" /></div>{filteredSkills.length ? <div className="grid gap-3 sm:grid-cols-2">{filteredSkills.map((skill) => { const enabled = selected.has(skill.id); const directoryEntry = directory.find((entry) => entry.name === skill.name); return <div key={skill.id} className="flex items-center gap-3 rounded-xl border border-border p-3 transition-colors hover:border-primary/40"><DirectoryIcon label={skill.name} logo={directoryEntry?.logo} icon={<Sparkles className="size-5" />} /><div className="min-w-0 flex-1"><p className="truncate text-xs font-medium text-foreground">{skill.name}</p><p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">{skill.description || skill.slug}</p></div><Button type="button" variant={enabled ? "default" : "outline"} size="icon" className="size-8 shrink-0" aria-label={enabled ? `Disable ${skill.name}` : `Enable ${skill.name}`} onClick={() => void toggle(skill)} disabled={busyId === skill.id}>{busyId === skill.id ? <Clock3 className="size-3.5 animate-pulse" /> : enabled ? <Check className="size-4" /> : <Plus className="size-4" />}</Button></div>; })}</div> : <p className="rounded-xl border border-dashed border-border px-3 py-5 text-center text-xs text-muted-foreground">{publishedSkills.length ? "No skills match this search." : "No published skills are available."}</p>}</div>;
}

function isPackageSelected(draft: StudioCapabilityDraft, pkg: AgentExtensionPackage) {
  return draft.extensionPackages.some((entry) => entry && typeof entry === "object" && !Array.isArray(entry) && (entry as Record<string, unknown>).kind === pkg.kind && (entry as Record<string, unknown>).id === pkg.package_id && (entry as Record<string, unknown>).version === pkg.version);
}

function packageDescription(pkg: AgentExtensionPackage) {
  const description = pkg.declaration.description;
  if (typeof description === "string" && description.trim()) return description;
  const permissions = Array.isArray(pkg.declaration.permissions) ? pkg.declaration.permissions.filter((permission): permission is string => typeof permission === "string") : [];
  return permissions.length ? `${permissions.length} permission${permissions.length === 1 ? "" : "s"} requested` : "Declarative extension for this agent";
}

function PluginsPanel({ directory, packages, draft, onDraftChange }: { directory: AgentCapabilityDirectoryEntry[]; packages: AgentExtensionPackage[]; draft: StudioCapabilityDraft; onDraftChange: (value: StudioCapabilityDraft | ((current: StudioCapabilityDraft) => StudioCapabilityDraft)) => void }) {
  const [query, setQuery] = useState("");
  const directoryPackageKeys = new Set(directory.map((entry) => `${entry.source.id}@${entry.version}`));
  const visiblePackages = packages.filter((pkg) => !directory.length || directoryPackageKeys.has(`${pkg.package_id}@${pkg.version}`));
  const filteredPackages = visiblePackages.filter((pkg) => `${pkg.name ?? ""} ${pkg.package_id} ${packageDescription(pkg)}`.toLowerCase().includes(query.trim().toLowerCase()));
  const togglePackage = (pkg: AgentExtensionPackage) => {
    const reference = { kind: pkg.kind, id: pkg.package_id, version: pkg.version, checksum: pkg.checksum, configuration: {} };
    const permissions = Array.isArray(pkg.declaration.permissions) ? pkg.declaration.permissions.filter((permission): permission is string => typeof permission === "string") : [];
    const grant = { kind: pkg.kind, id: pkg.package_id, permissions };
    const selected = isPackageSelected(draft, pkg);
    onDraftChange((current) => ({
      ...current,
      extensionPackages: selected ? current.extensionPackages.filter((entry) => !(entry && typeof entry === "object" && !Array.isArray(entry) && (entry as Record<string, unknown>).kind === pkg.kind && (entry as Record<string, unknown>).id === pkg.package_id && (entry as Record<string, unknown>).version === pkg.version)) : [...current.extensionPackages, reference],
      extensionGrants: selected ? current.extensionGrants.filter((entry) => !(entry && typeof entry === "object" && !Array.isArray(entry) && (entry as Record<string, unknown>).kind === pkg.kind && (entry as Record<string, unknown>).id === pkg.package_id)) : [...current.extensionGrants, grant],
    }));
  };
  return <div className="space-y-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><p className="text-xs text-muted-foreground">{directory.length} published plugin package{directory.length === 1 ? "" : "s"} discovered from the registry.</p><DirectorySearch value={query} onChange={setQuery} placeholder="Search plugins" /></div>{filteredPackages.length ? <div className="grid gap-3 sm:grid-cols-2">{filteredPackages.map((pkg) => { const enabled = isPackageSelected(draft, pkg); const title = pkg.name || pkg.package_id; const directoryEntry = directory.find((entry) => entry.source.id === pkg.package_id && entry.version === pkg.version); return <div key={pkg.id} className="flex items-center gap-3 rounded-xl border border-border p-3 transition-colors hover:border-primary/40"><DirectoryIcon label={title} logo={directoryEntry?.logo} icon={<Puzzle className="size-5" />} /><div className="min-w-0 flex-1"><p className="truncate text-xs font-medium text-foreground">{title}</p><p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">{packageDescription(pkg)}</p><p className="mt-1 text-[10px] text-muted-foreground">v{pkg.version}</p></div><Button type="button" variant={enabled ? "default" : "outline"} size="icon" className="size-8 shrink-0" aria-label={enabled ? `Disable ${title}` : `Enable ${title}`} onClick={() => togglePackage(pkg)}>{enabled ? <Check className="size-4" /> : <Plus className="size-4" />}</Button></div>; })}</div> : <p className="rounded-xl border border-dashed border-border px-3 py-5 text-center text-xs text-muted-foreground">{visiblePackages.length ? "No plugins match this search." : "No published plugins are available."}</p>}</div>;
}

function ConnectionCapabilitiesPanel({ installationId, directory, mcpDirectory, providers, pinnedProviders, versions, draft, onDraftChange, onRefresh }: { installationId: string | null; directory: AgentCapabilityDirectoryEntry[]; mcpDirectory: AgentCapabilityDirectoryEntry[]; providers: AgentMcpProvider[]; pinnedProviders: AgentMcpProviderVersion[]; versions: Record<string, AgentMcpProviderVersion[]>; draft: StudioCapabilityDraft; onDraftChange: (value: StudioCapabilityDraft | ((current: StudioCapabilityDraft) => StudioCapabilityDraft)) => void; onRefresh: () => void }) {
  return <div className="space-y-6">
    {installationId ? <section className="space-y-3"><h5 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Services</h5><AgentToolIntegrations installationId={installationId} embedded directory={directory} /></section> : null}
    <section className="space-y-3"><h5 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">MCP servers</h5><McpPanel directory={mcpDirectory} providers={providers} pinnedProviders={pinnedProviders} versions={versions} draft={draft} onDraftChange={onDraftChange} onRefresh={onRefresh} /></section>
  </div>;
}

function McpPanel({ directory, providers, pinnedProviders, versions, draft, onDraftChange, onRefresh }: { directory: AgentCapabilityDirectoryEntry[]; providers: AgentMcpProvider[]; pinnedProviders: AgentMcpProviderVersion[]; versions: Record<string, AgentMcpProviderVersion[]>; draft: StudioCapabilityDraft; onDraftChange: (value: StudioCapabilityDraft | ((current: StudioCapabilityDraft) => StudioCapabilityDraft)) => void; onRefresh: () => void }) {
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [addOpen, setAddOpen] = useState(false);
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
  const filteredProviders = providers.filter((provider) => `${provider.name} ${provider.endpoint_url}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <div className="space-y-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><p className="text-xs text-muted-foreground">{directory.length} published MCP revision{directory.length === 1 ? "" : "s"} discovered from the registry.</p><div className="flex flex-wrap gap-2"><DirectorySearch value={query} onChange={setQuery} placeholder="Search MCP servers" /><Button type="button" size="sm" onClick={() => setAddOpen((current) => !current)}><Plus className="mr-1.5 size-3.5" />Add server</Button></div></div>{addOpen ? <form onSubmit={addServer} className="grid gap-2 rounded-xl border border-primary/20 bg-primary/5 p-3 sm:grid-cols-[minmax(0,0.7fr)_minmax(0,1fr)_auto]"><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Server name" className="h-9 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary" /><input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="https://server.example/mcp" type="url" className="h-9 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary" /><Button type="submit" size="sm" className="h-9" disabled={busy || !name.trim() || !endpoint.trim()}>{busy ? "Adding…" : "Add MCP"}</Button></form> : null}{error ? <p className="rounded-lg bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</p> : null}{filteredProviders.length ? <div className="grid gap-3 sm:grid-cols-2">{filteredProviders.map((provider) => { const published = (versions[provider.id] ?? []).filter((version) => version.status === "published").sort((left, right) => right.revision - left.revision)[0]; const enabled = Boolean(published && pinnedIds.has(published.id)); const directoryEntry = directory.find((entry) => entry.source.id === published?.id); return <div key={provider.id} className="flex items-center gap-3 rounded-xl border border-border p-3 transition-colors hover:border-primary/40"><DirectoryIcon label={provider.name} logo={directoryEntry?.logo} icon={<PlugZap className="size-5" />} /><div className="min-w-0 flex-1"><div className="flex items-center gap-2"><p className="truncate text-xs font-medium text-foreground">{provider.name}</p><span className={cn("size-1.5 shrink-0 rounded-full", provider.health_status === "healthy" ? "bg-emerald-500" : "bg-amber-500")} /></div><p className="mt-1 truncate text-[11px] text-muted-foreground">{provider.endpoint_url}</p><p className="mt-1 text-[10px] text-muted-foreground">{published ? `${published.tools.length} tools · v${published.revision}` : "Not published"}</p></div><div className="flex shrink-0 items-center gap-1"><Button type="button" variant="ghost" size="sm" className="h-8 px-2 text-[10px]" onClick={() => void health(provider.id)} disabled={busy}>Health</Button><Button type="button" variant={enabled ? "default" : "outline"} size="icon" className="size-8" aria-label={enabled ? `Disable ${provider.name}` : `Enable ${provider.name}`} disabled={!published || busy} onClick={() => { if (!published) return; onDraftChange((current) => ({ ...current, mcpProviderVersionIds: enabled ? current.mcpProviderVersionIds.filter((id) => id !== published.id) : [...new Set([...current.mcpProviderVersionIds, published.id])] })); }}>{enabled ? <Check className="size-4" /> : <Plus className="size-4" />}</Button></div></div>; })}</div> : <p className="rounded-xl border border-dashed border-border px-3 py-5 text-center text-xs text-muted-foreground">{providers.length ? "No MCP servers match this search." : "No MCP servers configured."}</p>}</div>;
}

function UserToolsPanel({ tools, draft, onDraftChange }: { tools: AgentCapabilityDirectoryEntry[]; draft: StudioCapabilityDraft; onDraftChange: (value: StudioCapabilityDraft | ((current: StudioCapabilityDraft) => StudioCapabilityDraft)) => void }) {
  const [query, setQuery] = useState("");
  const selected = new Set(draft.allowedTools);
  const filtered = tools.filter((tool) => `${tool.name} ${tool.description} ${tool.tags.join(" ")}`.toLowerCase().includes(query.trim().toLowerCase()));
  const toggle = (tool: AgentCapabilityDirectoryEntry) => onDraftChange((current) => ({
    ...current,
    allowedTools: selected.has(tool.id) ? current.allowedTools.filter((id) => id !== tool.id) : [...new Set([...current.allowedTools, tool.id])],
  }));
  return <div className="space-y-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><p className="text-xs text-muted-foreground">Tools created by this organization and published to the registry.</p><DirectorySearch value={query} onChange={setQuery} placeholder="Search user tools" /></div>{filtered.length ? <div className="grid gap-3 sm:grid-cols-2">{filtered.map((tool) => { const enabled = selected.has(tool.id); return <div key={`${tool.id}:${tool.version}`} className="flex items-center gap-3 rounded-xl border border-border p-3"><DirectoryIcon label={tool.name} logo={tool.logo} icon={<Bot className="size-5" />} /><div className="min-w-0 flex-1"><p className="truncate text-xs font-medium text-foreground">{tool.name}</p><p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">{tool.description}</p><p className="mt-1 text-[10px] text-muted-foreground">v{tool.version}</p></div><Button type="button" variant={enabled ? "default" : "outline"} size="icon" className="size-8 shrink-0" aria-label={enabled ? `Disable ${tool.name}` : `Enable ${tool.name}`} onClick={() => toggle(tool)}>{enabled ? <Check className="size-4" /> : <Plus className="size-4" />}</Button></div>; })}</div> : <p className="rounded-xl border border-dashed border-border px-3 py-5 text-center text-xs text-muted-foreground">No published user tools are available.</p>}</div>;
}

function CapabilityRow({ icon, title, detail, status, statusText, action, onAction }: { icon: ReactNode; title: string; detail: string; status: "ready" | "attention" | "included" | "not_configured"; statusText: string; action: string; onAction?: () => void }) {
  return <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-border bg-card p-4 sm:flex-nowrap"><span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">{icon}</span><div className="min-w-0 flex-1"><p className="text-sm font-medium text-foreground">{title}</p><p className="mt-1 text-xs text-muted-foreground">{detail}</p></div><span className={cn("inline-flex items-center gap-1.5 text-[11px]", statusClass(status))}><StatusDot status={status} />{statusText}</span><Button type="button" variant="outline" size="sm" className="h-8 shrink-0" onClick={onAction}>{action}</Button></div>;
}

function MemorySection() {
  return <div className="space-y-4"><CapabilityRow icon={<MemoryStick className="size-4" />} title="Agent memory" detail="Control what this agent can retrieve and write" status="not_configured" statusText="Review policy" action="Configure" /><div className="grid gap-4 sm:grid-cols-2"><InfoTile label="Scope" value="Workspace" icon={<Database className="size-4" />} /><InfoTile label="Retrieval" value="Not configured" icon={<Eye className="size-4" />} /></div><SettingNote title="Memory stays scoped" detail="The agent only receives evidence allowed by its workspace, environment, and candidate policy." /></div>;
}

function GatewaysSection({ agent, installationId }: { agent: AgentDefinition; installationId: string | null }) {
  if (!installationId) return <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">No agent installation.</p>;
  return <InstallationIntegrations agentId={agent.id} installationId={installationId} personal={agent.execution_mode === "system_hosted"} agentName={agent.name} gatewaysOnly />;
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

function SettingNote({ title, detail }: { title: string; detail: string }) {
  return <div className="flex gap-3 rounded-2xl border border-primary/20 bg-primary/5 p-4"><CircleHelp className="mt-0.5 size-4 shrink-0 text-primary" /><div><p className="text-xs font-medium text-foreground">{title}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p></div></div>;
}

function PrototypeSwitcher({ variant, onChange }: { variant: PrototypeVariant; onChange: (value: PrototypeVariant) => void }) {
  const index = variants.findIndex((item) => item.id === variant);
  const previous = variants[(index - 1 + variants.length) % variants.length];
  const next = variants[(index + 1) % variants.length];
  return <div className="fixed bottom-4 left-1/2 z-[70] flex -translate-x-1/2 items-center gap-2 rounded-full border border-primary/30 bg-slate-950 px-2 py-1.5 text-white shadow-2xl"><button type="button" aria-label={`Previous prototype: ${previous.label}`} onClick={() => onChange(previous.id)} className="rounded-full p-1.5 hover:bg-white/10"><ArrowLeft className="size-3.5" /></button><span className="px-2 text-[10px] font-medium">Prototype {variant.toUpperCase()} · {variants[index].label}</span><button type="button" aria-label={`Next prototype: ${next.label}`} onClick={() => onChange(next.id)} className="rounded-full p-1.5 hover:bg-white/10"><ArrowRight className="size-3.5" /></button></div>;
}
