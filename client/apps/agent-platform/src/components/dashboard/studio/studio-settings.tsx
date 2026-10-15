"use client";

import { createElement, useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import Image from "@/components/ui/image";
import { useSearchParams } from "@/lib/navigation";
import {
  Activity,
  ArrowLeft,
  Bot,
  Check,
  CircleHelp,
  Clock3,
  FlaskConical,
  KeyRound,
  Layers3,
  LockKeyhole,
  MemoryStick,
  Plus,
  PlugZap,
  Puzzle,
  RefreshCw,
  Search,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Wrench,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { AgentModelPicker } from "@/components/dashboard/agents/agent-model-picker";
import { InstallationIntegrations } from "@/components/dashboard/agents/agent-detail-page-client";
import {
  createAgentMcpProvider,
  discoverAgentMcpProvider,
  getAgentInstallationReadiness,
  listAgentInstallationIntegrations,
  listAgentCapabilities,
  listAgentCapabilityDirectory,
  listAgentConnectionDirectory,
  listAgentExtensionPackages,
  listAgentPluginDirectory,
  listAgentInstallationCapabilities,
  listWorkspaceEmailConnections,
  listAgentMcpProviders,
  listAgentMcpProviderVersions,
  listAgentSkillDirectory,
  listAgentVersionMcpProviders,
  listAgentVersionSkills,
  connectAgentMcpCatalog,
  bindAgentWorkspaceEmail,
  installAgentPluginCatalog,
  installAgentSkillCatalog,
  startAgentMcpCatalogOAuth,
  pinAgentMcpProviderVersion,
  pinAgentSkillVersion,
  unpinAgentMcpProviderVersion,
  unpinAgentSkillVersion,
  publishAgentMcpProviderVersion,
  saveAgentIntegrationApiKey,
  saveAgentIntegrationLocalConnector,
  startAgentIntegrationOAuth,
  type AgentCapability,
  type AgentCapabilityDirectoryEntry,
  type AgentCapabilityToolset,
  type AgentConnectionDirectoryEntry,
  type AgentDefinition,
  type AgentIntegration,
  type AgentExtensionPackage,
  type AgentModel,
  type AgentModelCatalog,
  type AgentMcpProvider,
  type AgentMcpProviderVersion,
  type AgentReadiness,
  type AgentPluginDirectoryEntry,
  type AgentSkillDirectoryEntry,
  type AgentSkillVersion,
  type AgentVersion,
  type WorkspaceEmailConnection,
  AgentRequestError,
} from "@/lib/agent-platform";
import { cn } from "@/lib/utils";
import { getPlatformBrandColor, getPlatformBrandIcon } from "@/lib/platform-icons";

// These setup controls still need the standalone browser contracts and grants.
// This UI availability flag is not an authorization rule; backend checks remain.
const connectionSettingsAvailable = false;

type SettingsSection = "overview" | "behavior" | "capabilities" | "memory" | "gateways" | "safety" | "runtime";
type ModelSelection = Pick<AgentModel, "provider" | "model">;

export type StudioBehaviorDraft = {
  purpose: string;
  role: "standalone" | "orchestrator";
  audience: "personal" | "customer_service";
  tone: "concise" | "balanced" | "detailed" | "formal" | "warm" | "direct";
  responseLength: "short" | "balanced" | "detailed";
  initiative: "cautious" | "balanced" | "proactive";
  language: string;
  formatting: "plain" | "markdown" | "structured";
  rules: string[];
  advancedInstructions: string;
};

export type StudioMemoryDraft = {
  mode: "disabled" | "explicit" | "reviewed" | "automatic";
  readableNamespaces: string[];
  writableNamespaces: string[];
  writableTypes: string[];
  maxRetrieved: number;
  maxRetrievedTokens: number;
  maxWritesPerRun: number;
  retentionDays: string;
  allowSensitive: boolean;
};

export type StudioCapabilityDraft = {
  allowedTools: string[];
  requiredCapabilities: string[];
  allowedSkillIds: string[];
  skillVersionIds: string[];
  mcpProviderVersionIds: string[];
  extensionPackages: unknown[];
  extensionGrants: unknown[];
};

export type StudioSettingsDraft = {
  executionStrategy: "simple" | "durable";
  capabilities: StudioCapabilityDraft;
  behavior: StudioBehaviorDraft;
  memory: StudioMemoryDraft;
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

function recordAt(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringAt(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function enumAt<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;
}

const memoryNamespaces = ["conversation", "user_private", "organization_shared", "agent_private"] as const;
const memoryTypes = ["working", "semantic", "episodic", "procedural"] as const;

function listAt(value: unknown, allowed: readonly string[], fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const values = value.filter((item): item is string => typeof item === "string" && allowed.includes(item));
  return [...new Set(values)];
}

function behaviorDraftFromVersion(agent: AgentDefinition, version: AgentVersion | null, legacyInstructions?: string): StudioBehaviorDraft {
  const configuration = recordAt(version?.configuration);
  const spec = recordAt(configuration.agentSpec);
  const identity = recordAt(spec.identity);
  const execution = recordAt(spec.execution);
  const behavior = recordAt(spec.behavior);
  return {
    purpose: stringAt(identity.purpose, agent.description ?? ""),
    role: enumAt(execution.role, ["standalone", "orchestrator"], "standalone"),
    audience: enumAt(identity.audience, ["personal", "customer_service"], agent.agent_audience ?? "personal"),
    tone: enumAt(behavior.tone, ["concise", "balanced", "detailed", "formal", "warm", "direct"], "balanced"),
    responseLength: enumAt(behavior.responseLength, ["short", "balanced", "detailed"], "balanced"),
    initiative: enumAt(behavior.initiative, ["cautious", "balanced", "proactive"], "balanced"),
    language: stringAt(behavior.language, "auto"),
    formatting: enumAt(behavior.formatting, ["plain", "markdown", "structured"], "markdown"),
    rules: Array.isArray(behavior.rules) ? behavior.rules.filter((item): item is string => typeof item === "string") : typeof behavior.rules === "string" ? behavior.rules.split("\n").map((item) => item.trim()).filter(Boolean) : [],
    advancedInstructions: stringAt(behavior.advancedInstructions, legacyInstructions ?? version?.instructions ?? ""),
  };
}

function memoryDraftFromVersion(version: AgentVersion | null): StudioMemoryDraft {
  const configuration = recordAt(version?.configuration);
  const spec = recordAt(configuration.agentSpec);
  const policy = recordAt(version?.policy);
  const memory = Object.keys(recordAt(spec.memory)).length ? recordAt(spec.memory) : Object.keys(recordAt(policy.memory)).length ? recordAt(policy.memory) : recordAt(configuration.memory);
  const readableDefault = ["conversation", "user_private", "organization_shared", "agent_private"];
  const writableDefault = ["conversation", "user_private", "agent_private"];
  const writableTypesDefault = ["working", "semantic", "episodic"];
  return {
    mode: enumAt(memory.mode, ["disabled", "explicit", "reviewed", "automatic"], "explicit"),
    readableNamespaces: listAt(memory.readableNamespaces, memoryNamespaces, readableDefault),
    writableNamespaces: listAt(memory.writableNamespaces, memoryNamespaces, writableDefault),
    writableTypes: listAt(memory.writableTypes, memoryTypes, writableTypesDefault),
    maxRetrieved: typeof memory.maxRetrieved === "number" && Number.isFinite(memory.maxRetrieved) ? memory.maxRetrieved : 8,
    maxRetrievedTokens: typeof memory.maxRetrievedTokens === "number" && Number.isFinite(memory.maxRetrievedTokens) ? memory.maxRetrievedTokens : 1600,
    maxWritesPerRun: typeof memory.maxWritesPerRun === "number" && Number.isFinite(memory.maxWritesPerRun) ? memory.maxWritesPerRun : 3,
    retentionDays: memory.retentionDays === undefined || memory.retentionDays === null ? "" : String(memory.retentionDays),
    allowSensitive: memory.allowSensitive === true,
  };
}

const sections: Array<{ id: SettingsSection; label: string; description: string }> = [
  { id: "overview", label: "Overview", description: "Identity, deployment, and draft status" },
  { id: "behavior", label: "Behavior", description: "Purpose, response style, and rules" },
  { id: "capabilities", label: "Capabilities", description: "Tools, skills, and extensions" },
  { id: "memory", label: "Memory", description: "Scope and retrieval" },
  { id: "gateways", label: "Gateways", description: "Channels and surfaces" },
  { id: "safety", label: "Safety", description: "Approvals and permissions" },
  { id: "runtime", label: "Runtime", description: "Context, budgets, and limits" },
];

function formatTokens(value: number | undefined) {
  if (!value || !Number.isFinite(value)) return "Not reported";
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function googleOAuthCallbackMessage(error: string): string {
  switch (error) {
    case "access_denied":
      return "Google authorization was cancelled";
    case "google_oauth_not_configured":
      return "Google connection unavailable";
    case "google_token_exchange_failed":
      return "Google authorization failed";
    case "google_access_token_missing":
      return "Google did not return an access token";
    case "oauth_state_invalid_or_expired":
      return "Google authorization expired; try again";
    case "oauth_code_missing":
      return "Google authorization did not complete";
    default:
      return "Google authorization failed";
  }
}

export function StudioSettings({
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
  onSave: (draft?: StudioSettingsDraft) => Promise<AgentVersion | null> | void;
  saving: boolean;
  modelCatalog: AgentModelCatalog | null;
  modelCatalogLoading: boolean;
  modelSelection: ModelSelection | null;
  setModelSelection: (value: ModelSelection | null) => void;
  onClose: () => void;
}) {
  const searchParams = useSearchParams();
  const [section, setSection] = useState<SettingsSection>("overview");
  const [capabilityDraft, setCapabilityDraft] = useState<StudioCapabilityDraft>(() => capabilityDraftFromVersion(version));
  const [behaviorDraft, setBehaviorDraft] = useState<StudioBehaviorDraft>(() => behaviorDraftFromVersion(agent, version, instructions));
  const [memoryDraft, setMemoryDraft] = useState<StudioMemoryDraft>(() => memoryDraftFromVersion(version));
  const [executionStrategy, setExecutionStrategy] = useState<"simple" | "durable">(version?.configuration?.executionStrategy === "simple" ? "simple" : "durable");
  const [capabilitySaving, setCapabilitySaving] = useState(false);
  const [capabilitySaveError, setCapabilitySaveError] = useState<string | null>(null);
  const oauthError = searchParams.get("status") === "error" ? searchParams.get("error") : null;
  const oauthFeedback = oauthError ? googleOAuthCallbackMessage(oauthError) : null;

  useEffect(() => {
    if (oauthFeedback) toast.error(oauthFeedback);
  }, [oauthFeedback]);

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
    setInstructions(behaviorDraft.advancedInstructions);
    const next = await onSave({ capabilities: capabilityDraft, behavior: behaviorDraft, memory: memoryDraft, executionStrategy });
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
      onSave={saveSettings}
      saving={saving || capabilitySaving}
      executionStrategy={executionStrategy}
      setExecutionStrategy={setExecutionStrategy}
      capabilitySaveError={capabilitySaveError}
      capabilityDraft={capabilityDraft}
      setCapabilityDraft={setCapabilityDraft}
      behaviorDraft={behaviorDraft}
      setBehaviorDraft={setBehaviorDraft}
      memoryDraft={memoryDraft}
      setMemoryDraft={setMemoryDraft}
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
          <div className="min-w-0"><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Agent settings</p><h2 id="configuration-title" className="mt-1 truncate text-base font-semibold text-foreground">{agent.name}</h2></div>
        </div>
        <div className="flex items-center gap-2"><span className="hidden items-center gap-1.5 text-[11px] text-muted-foreground sm:inline-flex"><span className="size-1.5 rounded-full bg-amber-500" />Draft changes</span><button type="button" aria-label="Close settings" onClick={onClose} className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"><X className="size-4" /></button></div>
      </header>

      <div className="min-h-0 flex-1 overflow-hidden">
        <SettingsLayout content={content} section={section} setSection={setSection} />
      </div>

    </div>
  );
}

function SettingsLayout({ content, section, setSection }: { content: ReactNode; section: SettingsSection; setSection: (value: SettingsSection) => void }) {
  return <div className="flex h-full min-h-0"><SettingsNavigation section={section} setSection={setSection} /><main className="min-w-0 flex-1 overflow-y-auto bg-background/40"><div className="border-b border-border p-4 sm:hidden"><label htmlFor="studio-settings-section" className="text-xs font-medium">Settings section</label><select id="studio-settings-section" className="mt-2 h-9 w-full rounded-md border border-border bg-background px-2 text-sm" value={section} onChange={event => setSection(event.target.value as SettingsSection)}>{sections.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></div>{content}</main></div>;
}

function SettingsNavigation({ section, setSection }: { section: SettingsSection; setSection: (value: SettingsSection) => void }) {
  return <aside className="hidden w-60 shrink-0 overflow-y-auto border-r border-border bg-card p-4 sm:block"><div className="px-2 pb-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Settings</div><nav className="space-y-1">{sections.map((item) => <button key={item.id} type="button" onClick={() => setSection(item.id)} className={cn("flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors", section === item.id ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground")}><span><SettingsIcon section={item.id} /></span><span className="min-w-0 text-xs font-medium">{item.label}</span></button>)}</nav><div className="mt-6 rounded-xl border border-border bg-background/60 p-3"><div className="flex items-center gap-2 text-xs font-medium text-foreground"><FlaskConical className="size-3.5 text-primary" />Playground</div></div></aside>;
}

function SettingsIcon({ section }: { section: SettingsSection }) {
  if (section === "behavior") return <SlidersHorizontal className="size-3.5" />;
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
  behaviorDraft,
  setBehaviorDraft,
  memoryDraft,
  setMemoryDraft,
  executionStrategy,
  setExecutionStrategy,
  capabilitySaveError,
}: {
  agent: AgentDefinition;
  version: AgentVersion | null;
  installationId: string | null;
  section: SettingsSection;
  setSection: (value: SettingsSection) => void;
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
  behaviorDraft: StudioBehaviorDraft;
  setBehaviorDraft: (value: StudioBehaviorDraft | ((current: StudioBehaviorDraft) => StudioBehaviorDraft)) => void;
  memoryDraft: StudioMemoryDraft;
  setMemoryDraft: (value: StudioMemoryDraft | ((current: StudioMemoryDraft) => StudioMemoryDraft)) => void;
  executionStrategy: "simple" | "durable";
  setExecutionStrategy: (value: "simple" | "durable") => void;
  capabilitySaveError: string | null;
}) {
  const title = sections.find((item) => item.id === section)?.label ?? "Settings";
  const description = sections.find((item) => item.id === section)?.description ?? "";
  return <div className="mx-auto max-w-4xl px-5 py-6 pb-24 sm:px-8 sm:py-8"><div className="mb-7 flex items-start justify-between gap-4"><div><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Agent settings</p><h3 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-foreground">{title}</h3><p className="mt-1 text-sm text-muted-foreground">{description}</p></div><span className="hidden items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-[10px] text-muted-foreground sm:inline-flex"><span className="size-1.5 rounded-full bg-amber-500" />Draft</span></div>{capabilitySaveError ? <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">{capabilitySaveError}</div> : null}{section === "overview" ? <OverviewSection agent={agent} version={version} selectedModel={selectedModel} capabilityDraft={capabilityDraft} behaviorDraft={behaviorDraft} memoryDraft={memoryDraft} /> : null}{section === "behavior" ? <BehaviorSection draft={behaviorDraft} onDraftChange={setBehaviorDraft} /> : null}{section === "capabilities" ? connectionSettingsAvailable ? <CapabilitiesSection installationId={installationId} versionId={version?.id ?? null} draft={capabilityDraft} onDraftChange={setCapabilityDraft} /> : <SettingNote title="Capability setup pending" detail="Tool, skill, plugin and connection setup is not connected in this initial frontend. Existing version configuration is retained when editing behavior, memory or model settings." /> : null}{section === "memory" ? <MemorySection draft={memoryDraft} onDraftChange={setMemoryDraft} /> : null}{section === "gateways" ? connectionSettingsAvailable ? <GatewaysSection agent={agent} installationId={installationId} /> : <SettingNote title="Gateway setup pending" detail="Website and social-channel setup is not connected yet. Test text conversations in the playground before configuring external delivery." /> : null}{section === "safety" ? <SafetySection /> : null}{section === "runtime" ? <div><section className="mb-4 rounded-xl border border-border p-4"><label htmlFor="execution-strategy" className="text-sm font-medium">Execution</label><select id="execution-strategy" value={executionStrategy} onChange={event => setExecutionStrategy(event.target.value as "simple" | "durable")} className="mt-2 block h-10 w-full rounded-md border border-border bg-background px-3 text-sm"><option value="simple">Simple</option><option value="durable">Durable</option></select><p className="mt-2 text-xs text-muted-foreground">Simple runs finish within a bounded request. Choose durable for approvals, workflow waits and automatic recovery. Save the version and use it in Playground to apply this setting.</p></section><RuntimeSection selectedModel={selectedModel} pickerModels={pickerModels} modelCatalog={modelCatalog} modelCatalogLoading={modelCatalogLoading} effectiveSelection={effectiveSelection} setModelSelection={setModelSelection} /></div> : null}<div className="mt-8 flex flex-wrap items-center justify-end gap-3 border-t border-border pt-5"><div className="flex items-center gap-2"><Button type="button" variant="outline" size="sm" onClick={() => setSection("overview")}><ArrowLeft className="mr-1.5 size-3.5" />Overview</Button><Button type="button" size="sm" onClick={onSave} disabled={saving || section === "safety" || (!connectionSettingsAvailable && (section === "capabilities" || section === "gateways"))}>{saving ? <Clock3 className="mr-1.5 size-3.5 animate-pulse" /> : <Save className="mr-1.5 size-3.5" />}{saving ? "Saving…" : "Save draft"}</Button></div></div></div>;
}

function OverviewSection({ agent, version, selectedModel, capabilityDraft, behaviorDraft, memoryDraft }: { agent: AgentDefinition; version: AgentVersion | null; selectedModel?: AgentModel; capabilityDraft: StudioCapabilityDraft; behaviorDraft: StudioBehaviorDraft; memoryDraft: StudioMemoryDraft }) {
  const deployment = agent.installation_status ?? "not_configured";
  const deploymentLabel = deployment === "active" ? "Active" : deployment === "paused" ? "Paused" : deployment === "disabled" ? "Disabled" : "Not configured";
  const playgroundLabel = agent.installation_settings?.environment === "playground" ? deploymentLabel : "Not configured";
  const publishedLabel = agent.published_version_number ? `v${agent.published_version_number} · Published` : "Not configured";
  const behaviorSummary = [behaviorDraft.tone, `${behaviorDraft.responseLength} responses`, `${behaviorDraft.initiative} initiative`].join(" · ");
  const memorySummary = memoryDraft.mode === "disabled" ? "Disabled" : `${memoryDraft.mode} · ${memoryDraft.readableNamespaces.length} read scopes · ${memoryDraft.writableNamespaces.length} write scopes`;
  const capabilityCount = capabilityDraft.allowedTools.length + capabilityDraft.requiredCapabilities.length + capabilityDraft.allowedSkillIds.length + capabilityDraft.extensionPackages.length;
  return <div className="space-y-5"><div className="grid gap-4 sm:grid-cols-2"><InfoTile label="Agent" value={agent.name} icon={<Bot className="size-4" />} /><InfoTile label="Selected version" value={version ? `v${version.version_number} · ${version.status}` : "No version"} icon={<Layers3 className="size-4" />} /><InfoTile label="Playground installation" value={playgroundLabel} icon={<FlaskConical className="size-4" />} /><InfoTile label="Published version" value={publishedLabel} icon={<Activity className="size-4" />} /><InfoTile label="Model" value={selectedModel?.label ?? selectedModel?.model ?? "Not selected"} icon={<Sparkles className="size-4" />} /></div><section className="rounded-2xl border border-border bg-card p-4 sm:p-5"><div className="flex items-center gap-2"><SlidersHorizontal className="size-4 text-primary" /><h4 className="text-sm font-semibold text-foreground">Draft summary</h4></div><dl className="mt-4 divide-y divide-border text-xs"><SummaryRow label="Behavior" value={behaviorSummary} /><SummaryRow label="Memory policy" value={memorySummary} /><SummaryRow label="Capabilities" value={capabilityCount ? `${capabilityCount} selected` : "None selected"} /><SummaryRow label="Next step" value="Save changes as a draft version" /></dl></section><SettingNote title="Overview is a summary" detail="Edit behavior, memory, and capabilities in their dedicated tabs. Platform safety, permissions, and system skills remain managed by the runtime." /></div>;
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return <div className="flex flex-col gap-1 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"><dt className="text-muted-foreground">{label}</dt><dd className="font-medium text-foreground sm:text-right">{value}</dd></div>;
}

function BehaviorSection({ draft, onDraftChange }: { draft: StudioBehaviorDraft; onDraftChange: (value: StudioBehaviorDraft | ((current: StudioBehaviorDraft) => StudioBehaviorDraft)) => void }) {
  const update = <K extends keyof StudioBehaviorDraft>(key: K, value: StudioBehaviorDraft[K]) => onDraftChange((current) => ({ ...current, [key]: value }));
  return <div className="space-y-5"><section className="rounded-2xl border border-border bg-card p-4 sm:p-5"><div><h4 className="text-sm font-semibold text-foreground">Identity</h4><p className="mt-1 text-xs text-muted-foreground">Describe the agent’s purpose and operating context.</p></div><div className="mt-4 grid gap-4 sm:grid-cols-2"><label className="block text-xs font-medium text-foreground sm:col-span-2">Purpose<input value={draft.purpose} onChange={(event) => update("purpose", event.target.value)} maxLength={2_000} placeholder="What should this agent help with?" className="mt-1.5 h-10 w-full rounded-md border border-border bg-background px-3 text-sm font-normal text-foreground outline-none focus:border-primary" /></label><label className="block text-xs font-medium text-foreground">Role<Select value={draft.role} onValueChange={(value) => update("role", value as StudioBehaviorDraft["role"])}><SelectTrigger className="mt-1.5 h-10 text-sm font-normal"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="standalone">Standalone agent</SelectItem><SelectItem value="orchestrator">Orchestrator</SelectItem></SelectContent></Select></label><label className="block text-xs font-medium text-foreground">Audience<Select value={draft.audience} onValueChange={(value) => update("audience", value as StudioBehaviorDraft["audience"])}><SelectTrigger className="mt-1.5 h-10 text-sm font-normal"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="personal">Personal workspace</SelectItem><SelectItem value="customer_service">Customer service</SelectItem></SelectContent></Select></label></div></section><section className="rounded-2xl border border-border bg-card p-4 sm:p-5"><div><h4 className="text-sm font-semibold text-foreground">Response style</h4><p className="mt-1 text-xs text-muted-foreground">Set defaults for the next Playground turn.</p></div><div className="mt-4 grid gap-4 sm:grid-cols-2"><label className="block text-xs font-medium text-foreground">Tone<Select value={draft.tone} onValueChange={(value) => update("tone", value as StudioBehaviorDraft["tone"])}><SelectTrigger className="mt-1.5 h-10 text-sm font-normal"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="concise">Concise</SelectItem><SelectItem value="balanced">Balanced</SelectItem><SelectItem value="detailed">Detailed</SelectItem><SelectItem value="formal">Formal</SelectItem><SelectItem value="warm">Warm</SelectItem><SelectItem value="direct">Direct</SelectItem></SelectContent></Select></label><label className="block text-xs font-medium text-foreground">Response length<Select value={draft.responseLength} onValueChange={(value) => update("responseLength", value as StudioBehaviorDraft["responseLength"])}><SelectTrigger className="mt-1.5 h-10 text-sm font-normal"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="short">Short</SelectItem><SelectItem value="balanced">Standard</SelectItem><SelectItem value="detailed">Long</SelectItem></SelectContent></Select></label><label className="block text-xs font-medium text-foreground">Initiative<Select value={draft.initiative} onValueChange={(value) => update("initiative", value as StudioBehaviorDraft["initiative"])}><SelectTrigger className="mt-1.5 h-10 text-sm font-normal"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="cautious">Cautious</SelectItem><SelectItem value="balanced">Balanced</SelectItem><SelectItem value="proactive">Proactive</SelectItem></SelectContent></Select></label><label className="block text-xs font-medium text-foreground">Language<input value={draft.language} onChange={(event) => update("language", event.target.value)} minLength={2} maxLength={80} placeholder="auto" className="mt-1.5 h-10 w-full rounded-md border border-border bg-background px-3 text-sm font-normal text-foreground outline-none focus:border-primary" /></label><label className="block text-xs font-medium text-foreground sm:col-span-2">Formatting<Select value={draft.formatting} onValueChange={(value) => update("formatting", value as StudioBehaviorDraft["formatting"])}><SelectTrigger className="mt-1.5 h-10 text-sm font-normal"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="plain">Plain text</SelectItem><SelectItem value="markdown">Markdown</SelectItem><SelectItem value="structured">Structured responses</SelectItem></SelectContent></Select></label></div></section><section className="rounded-2xl border border-border bg-card p-4 sm:p-5"><div><h4 className="text-sm font-semibold text-foreground">Behavior rules</h4><p className="mt-1 text-xs text-muted-foreground">Short, stable preferences that shape responses.</p></div><Textarea value={draft.rules.join("\n")} onChange={(event) => update("rules", event.target.value.split("\n").map((item) => item.trim().slice(0, 500)).filter(Boolean).slice(0, 20))} rows={4} maxLength={8_000} placeholder="One rule per line" className="mt-4 resize-y text-sm leading-6" /></section><section className="rounded-2xl border border-border bg-card p-4 sm:p-5"><div><h4 className="text-sm font-semibold text-foreground">Advanced overlay</h4><p className="mt-1 text-xs leading-5 text-muted-foreground">Optional additions to the typed behavior settings. Platform safety, permissions, and system skills remain outside this field.</p></div><Textarea value={draft.advancedInstructions} onChange={(event) => update("advancedInstructions", event.target.value)} rows={6} maxLength={20_000} placeholder="Add expert guidance for this agent…" className="mt-4 resize-y font-mono text-xs leading-5" /></section></div>;
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
  pinnedSkills: AgentSkillVersion[];
  mcpProviders: AgentMcpProvider[];
  pinnedMcpProviders: AgentMcpProviderVersion[];
  mcpVersions: Record<string, AgentMcpProviderVersion[]>;
  extensionPackages: AgentExtensionPackage[];
  connections: AgentConnectionDirectoryEntry[];
  skillDirectory: AgentSkillDirectoryEntry[];
  pluginDirectory: AgentPluginDirectoryEntry[];
  emailConnections: WorkspaceEmailConnection[];
};

const emptyCapabilityData: CapabilityData = {
  directory: [],
  toolsets: [],
  catalog: [],
  installation: [],
  readiness: null,
  pinnedSkills: [],
  mcpProviders: [],
  pinnedMcpProviders: [],
  mcpVersions: {},
  extensionPackages: [],
  connections: [],
  skillDirectory: [],
  pluginDirectory: [],
  emailConnections: [],
};

async function loadCapabilityData(installationId: string | null, versionId: string | null): Promise<CapabilityData> {
  const [directoryResult, catalogResult, packagesResult, providersResult, installationResult, readinessResult, pinnedSkillsResult, pinnedMcpResult, connectionsResult, skillDirectoryResult, pluginDirectoryResult, emailConnectionsResult] = await Promise.all([
    listAgentCapabilityDirectory(),
    listAgentCapabilities(),
    listAgentExtensionPackages(),
    listAgentMcpProviders(),
    installationId ? listAgentInstallationCapabilities(installationId) : Promise.resolve({ capabilities: [] }),
    installationId ? getAgentInstallationReadiness(installationId) : Promise.resolve(null),
    versionId ? listAgentVersionSkills(versionId) : Promise.resolve({ skills: [] }),
    versionId ? listAgentVersionMcpProviders(versionId) : Promise.resolve({ providers: [] }),
    installationId ? listAgentConnectionDirectory(installationId) : Promise.resolve({ connections: [] }),
    listAgentSkillDirectory(versionId ?? undefined),
    listAgentPluginDirectory(installationId ?? undefined),
    listWorkspaceEmailConnections(),
  ]);
  const mcpVersionsEntries = await Promise.all(providersResult.providers.map(async (provider) => {
    const result = await listAgentMcpProviderVersions(provider.id);
    return [provider.id, result.versions] as const;
  }));
  return {
    directory: directoryResult.directory,
    toolsets: directoryResult.toolsets,
    catalog: catalogResult.capabilities,
    extensionPackages: packagesResult.packages,
    installation: installationResult.capabilities,
    readiness: readinessResult,
    pinnedSkills: pinnedSkillsResult.skills,
    mcpProviders: providersResult.providers,
    pinnedMcpProviders: pinnedMcpResult.providers,
    mcpVersions: Object.fromEntries(mcpVersionsEntries),
    connections: connectionsResult.connections,
    skillDirectory: skillDirectoryResult.skills,
    pluginDirectory: pluginDirectoryResult.plugins,
    emailConnections: emailConnectionsResult.connections,
  };
}

function CapabilitiesSection({ installationId, versionId, draft, onDraftChange }: { installationId: string | null; versionId: string | null; draft: StudioCapabilityDraft; onDraftChange: (value: StudioCapabilityDraft | ((current: StudioCapabilityDraft) => StudioCapabilityDraft)) => void }) {
  const [activeTab, setActiveTab] = useState<CapabilityTab>("tools");
  const [data, setData] = useState<CapabilityData>(emptyCapabilityData);
  const [loading, setLoading] = useState(true);
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
        toast.error("Capabilities could not be loaded", { action: { label: "Retry", onClick: () => { setLoading(true); setRefreshKey((current) => current + 1); } } });
        setLoading(false);
      }
    });
    return () => { mounted = false; };
  }, [installationId, onDraftChange, versionId, refreshKey]);

  const refresh = () => {
    setLoading(true);
    setRefreshKey((current) => current + 1);
  };
  const plugins = data.extensionPackages.filter((pkg) => pkg.status === "published" && pkg.kind === "plugin");
  const directoryTools = data.directory.filter((entry) => ["builtin_tool", "connector_tool", "plugin_tool", "mcp_tool", "user_tool"].includes(entry.kind));
  const directorySkills = data.skillDirectory;
  const directoryPlugins = data.pluginDirectory;
  const directoryConnections = data.connections;
  const directoryUserTools = data.directory.filter((entry) => entry.kind === "user_tool");
  const tabCount = (tab: CapabilityTab) => {
    if (loading) return "…";
    if (tab === "tools") return String(directoryTools.length);
    if (tab === "skills") return String(directorySkills.length);
    if (tab === "plugins") return String(directoryPlugins.length);
    if (tab === "connections") return String(directoryConnections.length + data.mcpProviders.filter((provider) => !provider.catalog_id).length);
    return String(directoryUserTools.length);
  };
  const activeTabLabel = capabilityTabs.find((tab) => tab.id === activeTab)?.label ?? "Tools";

  return <div className="space-y-4">
    <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as CapabilityTab)} className="gap-4">
      <TabsList aria-label="Capabilities" className="h-auto w-full justify-start overflow-x-auto rounded-xl border border-border bg-muted/30 p-1">
        {capabilityTabs.map((tab) => <TabsTrigger key={tab.id} value={tab.id} className="min-w-[7rem] flex-1 gap-2 px-3 py-2 text-xs"><span>{tab.label}</span><span className="min-w-5 rounded-full bg-muted px-1.5 py-0.5 text-center text-[10px] text-muted-foreground data-[state=active]:bg-primary/10 data-[state=active]:text-primary">{tabCount(tab.id)}</span></TabsTrigger>)}
      </TabsList>
      <TabsContent value={activeTab} className="rounded-2xl border border-border bg-card p-4 shadow-sm sm:p-5">
        <div className="mb-4 flex items-center justify-between gap-3"><div><p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Capabilities</p><h4 className="mt-1 text-sm font-semibold text-foreground">{activeTabLabel}</h4></div>{loading ? <span className="text-[11px] text-muted-foreground">Loading…</span> : null}</div>
        {activeTab === "tools" ? <ToolsPanel tools={directoryTools} toolsets={data.toolsets} draft={draft} onDraftChange={onDraftChange} /> : null}{activeTab === "skills" ? <SkillsPanel directory={directorySkills} pinnedSkills={data.pinnedSkills} installationId={installationId} versionId={versionId} draft={draft} onDraftChange={onDraftChange} onRefresh={refresh} /> : null}{activeTab === "plugins" ? <PluginsPanel directory={directoryPlugins} packages={plugins} installationId={installationId} draft={draft} onDraftChange={onDraftChange} onRefresh={refresh} /> : null}{activeTab === "connections" ? <ConnectionCapabilitiesPanel installationId={installationId} connectionDirectory={directoryConnections} emailConnections={data.emailConnections} providers={data.mcpProviders} pinnedProviders={data.pinnedMcpProviders} versions={data.mcpVersions} versionId={versionId} draft={draft} onDraftChange={onDraftChange} onRefresh={refresh} /> : null}{activeTab === "user_tools" ? <UserToolsPanel tools={directoryUserTools} draft={draft} onDraftChange={onDraftChange} /> : null}
      </TabsContent>
    </Tabs>
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
  const brandIcon = getPlatformBrandIcon(logo ?? label);
  if (brandIcon) return <span className="grid size-11 shrink-0 place-items-center rounded-xl border border-border bg-background">{createElement(brandIcon, { className: cn("size-6", getPlatformBrandColor(logo ?? label)) })}</span>;
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

function SkillsPanel({ directory, pinnedSkills, installationId, versionId, draft, onDraftChange, onRefresh }: { directory: AgentSkillDirectoryEntry[]; pinnedSkills: AgentSkillVersion[]; installationId: string | null; versionId: string | null; draft: StudioCapabilityDraft; onDraftChange: (value: StudioCapabilityDraft | ((current: StudioCapabilityDraft) => StudioCapabilityDraft)) => void; onRefresh: () => void }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const selected = new Set(draft.allowedSkillIds.length ? draft.allowedSkillIds : directory.filter((entry) => entry.enabled && entry.skillId).map((entry) => entry.skillId as string));
  const toggle = async (entry: AgentSkillDirectoryEntry) => {
    if (!installationId) return;
    setBusyId(entry.id);
    try {
      if (!entry.installed) {
        const result = await installAgentSkillCatalog(installationId, entry.id, versionId ?? undefined) as { skill?: { id?: string }; version?: { id?: string } };
        const skillId = result.skill?.id ?? entry.skillId;
        const versionIdFromInstall = result.version?.id ?? entry.versionId;
        if (skillId) onDraftChange((current) => ({ ...current, allowedSkillIds: [...new Set([...current.allowedSkillIds, skillId])], skillVersionIds: versionIdFromInstall ? [...new Set([...current.skillVersionIds, versionIdFromInstall])] : current.skillVersionIds }));
      } else if (entry.skillId) {
        const enabled = selected.has(entry.skillId);
        const pinnedVersionIds = pinnedSkills.filter((version) => version.skill_definition_id === entry.skillId).map((version) => version.id);
        if (versionId && entry.versionId) {
          if (enabled) {
            await Promise.all([...new Set([...pinnedVersionIds, entry.versionId])].map((skillVersionId) => unpinAgentSkillVersion(versionId, skillVersionId)));
          } else {
            await pinAgentSkillVersion(versionId, entry.versionId);
          }
        }
        onDraftChange((current) => ({ ...current, allowedSkillIds: enabled ? current.allowedSkillIds.filter((id) => id !== entry.skillId) : [...new Set([...current.allowedSkillIds, entry.skillId as string])], skillVersionIds: enabled ? current.skillVersionIds.filter((id) => !pinnedVersionIds.includes(id) && id !== entry.versionId) : [...new Set([...current.skillVersionIds, ...(entry.versionId ? [entry.versionId] : [])])] }));
      }
      onRefresh();
    } finally {
      setBusyId(null);
    }
  };
  const filtered = directory.filter((entry) => `${entry.name} ${entry.slug} ${entry.description} ${entry.tags.join(" ")}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <div className="space-y-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><span className="text-xs text-muted-foreground">{directory.length} skills</span><DirectorySearch value={query} onChange={setQuery} placeholder="Search skills" /></div>{filtered.length ? <div className="grid gap-2 sm:grid-cols-2">{filtered.map((entry) => { const enabled = Boolean(entry.skillId && selected.has(entry.skillId)); return <div key={entry.id} className="flex items-center gap-3 rounded-xl border border-border p-3 transition-colors hover:border-primary/40"><DirectoryIcon label={entry.name} icon={<Sparkles className="size-5" />} /><div className="min-w-0 flex-1"><p className="truncate text-xs font-medium text-foreground">{entry.name}</p><p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">{entry.description}</p><p className="mt-1 text-[10px] text-muted-foreground">{entry.author} · v{entry.version}</p></div><Button type="button" variant={enabled ? "default" : "outline"} size="icon" className="size-8 shrink-0" aria-label={enabled ? `Disable ${entry.name}` : `Add ${entry.name}`} onClick={() => void toggle(entry)} disabled={busyId === entry.id || !installationId}>{busyId === entry.id ? <Clock3 className="size-3.5 animate-pulse" /> : enabled ? <Check className="size-4" /> : <Plus className="size-4" />}</Button></div>; })}</div> : <p className="rounded-xl border border-dashed border-border px-3 py-5 text-center text-xs text-muted-foreground">No skills match.</p>}</div>;
}


function isPluginSelected(draft: StudioCapabilityDraft, entry: AgentPluginDirectoryEntry) {
  return draft.extensionPackages.some((value) => value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).kind === "plugin" && (value as Record<string, unknown>).id === entry.id && (value as Record<string, unknown>).version === entry.version);
}

function PluginsPanel({ directory, packages, installationId, draft, onDraftChange, onRefresh }: { directory: AgentPluginDirectoryEntry[]; packages: AgentExtensionPackage[]; installationId: string | null; draft: StudioCapabilityDraft; onDraftChange: (value: StudioCapabilityDraft | ((current: StudioCapabilityDraft) => StudioCapabilityDraft)) => void; onRefresh: () => void }) {
  const [busyId, setBusyId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const installedPackages = new Map(packages.map((pkg) => [`${pkg.package_id}:${pkg.version}`, pkg]));
  const toggle = async (entry: AgentPluginDirectoryEntry) => {
    const selected = isPluginSelected(draft, entry);
    if (!installationId || entry.adapterStatus !== "supported" || (!selected && entry.readiness?.state !== "ready")) return;
    setBusyId(entry.id);
    try {
      const installed = installedPackages.get(`${entry.id}:${entry.version}`);
      const installedResult = installed ? null : await installAgentPluginCatalog(installationId, entry.id);
      const adapterCapabilityIds = entry.adapterCapabilityIds.length
        ? entry.adapterCapabilityIds
        : Array.isArray(installed?.declaration.capabilityIds)
          ? installed.declaration.capabilityIds.filter((value): value is string => typeof value === "string")
          : installedResult && Array.isArray(installedResult.package.declaration.capabilityIds)
            ? installedResult.package.declaration.capabilityIds.filter((value): value is string => typeof value === "string")
            : [];
      const reference = { kind: "plugin", id: entry.id, version: entry.version, checksum: entry.checksum, configuration: {} };
      const grant = { kind: "plugin", id: entry.id, permissions: [] };
      onDraftChange((current) => ({
        ...current,
        extensionPackages: selected ? current.extensionPackages.filter((value) => !(value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).kind === "plugin" && (value as Record<string, unknown>).id === entry.id)) : [...current.extensionPackages.filter((value) => !(value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).kind === "plugin" && (value as Record<string, unknown>).id === entry.id)), reference],
        extensionGrants: selected ? current.extensionGrants.filter((value) => !(value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).kind === "plugin" && (value as Record<string, unknown>).id === entry.id)) : [...current.extensionGrants.filter((value) => !(value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).kind === "plugin" && (value as Record<string, unknown>).id === entry.id)), grant],
        allowedTools: selected ? current.allowedTools.filter((id) => !adapterCapabilityIds.includes(id)) : [...new Set([...current.allowedTools, ...adapterCapabilityIds])],
      }));
      onRefresh();
    } finally {
      setBusyId(null);
    }
  };
  const filtered = directory.filter((entry) => `${entry.name} ${entry.slug} ${entry.description} ${entry.kind} ${entry.providedTools.join(" ")}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <div className="space-y-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><span className="text-xs text-muted-foreground">{directory.length} plugins</span><DirectorySearch value={query} onChange={setQuery} placeholder="Search plugins" /></div>{filtered.length ? <div className="grid gap-2 sm:grid-cols-2">{filtered.map((entry) => { const enabled = isPluginSelected(draft, entry); const unavailable = entry.adapterStatus !== "supported"; const notReady = !unavailable && Boolean(entry.readiness && entry.readiness.state !== "ready"); const meta = entry.providedTools.length ? `${entry.providedTools.length} tools` : entry.kind; const status = unavailable ? "Unavailable" : notReady ? "Connect required" : "Ready"; const logo = entry.slug.split("/").filter(Boolean).at(-1); return <div key={entry.id} className={cn("flex items-center gap-3 rounded-xl border border-border p-3", unavailable ? "opacity-70" : "transition-colors hover:border-primary/40")}><DirectoryIcon label={entry.name} logo={logo} icon={<Puzzle className="size-5" />} /><div className="min-w-0 flex-1"><p className="truncate text-xs font-medium text-foreground">{entry.name}</p><p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">{entry.description}</p><p className="mt-1 text-[10px] text-muted-foreground">{meta} · v{entry.version} · {status}</p></div><Button type="button" variant={enabled ? "default" : "outline"} size="icon" className="size-8 shrink-0" aria-label={unavailable ? `${entry.name} unavailable` : enabled ? `Disable ${entry.name}` : notReady ? `${entry.name} requires connection` : `Add ${entry.name}`} onClick={() => void toggle(entry)} disabled={busyId === entry.id || unavailable || (!enabled && notReady) || !installationId}>{busyId === entry.id ? <Clock3 className="size-3.5 animate-pulse" /> : unavailable ? <LockKeyhole className="size-3.5" /> : enabled ? <Check className="size-4" /> : <Plus className="size-4" />}</Button></div>; })}</div> : <p className="rounded-xl border border-dashed border-border px-3 py-5 text-center text-xs text-muted-foreground">No plugins match.</p>}</div>;
}

type ConnectionSetupMode = "api_key" | "local_connector" | "oauth_client";
type ConnectionFilter = "all" | "connected";

function connectionCategoryLabel(value: string): string {
  return value
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function connectionCategoryRank(value: string): number {
  switch (value.toLowerCase()) {
    case "google": return 0;
    case "custom": return 1;
    case "productivity": return 2;
    case "messaging": return 3;
    case "search": return 4;
    case "development": return 5;
    case "data": return 6;
    case "observability": return 7;
    default: return 8;
  }
}

function connectionErrorMessage(cause: unknown): string {
  if (cause instanceof AgentRequestError) {
    switch (cause.code) {
      case "google_oauth_not_configured": return "Google connection unavailable";
      case "mcp_oauth_not_configured": return "OAuth is unavailable";
      case "mcp_oauth_client_registration_failed": return "Provider rejected OAuth registration";
      case "mcp_oauth_provider_unavailable": return "Provider OAuth metadata is unavailable";
      case "mcp_oauth_start_failed": return "Unable to start OAuth";
      default: return cause.message;
    }
  }
  return cause instanceof Error ? cause.message : "Unable to connect";
}

function ConnectionCataloguePanel({ installationId, versionId, directory, emailConnections, providers, pinnedProviders, versions, draft, onDraftChange, onRefresh }: { installationId: string; versionId: string | null; directory: AgentConnectionDirectoryEntry[]; emailConnections: WorkspaceEmailConnection[]; providers: AgentMcpProvider[]; pinnedProviders: AgentMcpProviderVersion[]; versions: Record<string, AgentMcpProviderVersion[]>; draft: StudioCapabilityDraft; onDraftChange: (value: StudioCapabilityDraft | ((current: StudioCapabilityDraft) => StudioCapabilityDraft)) => void; onRefresh: () => void }) {
  const [integrations, setIntegrations] = useState<AgentIntegration[]>([]);
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [connectionFilter, setConnectionFilter] = useState<ConnectionFilter>("all");
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [setupId, setSetupId] = useState<string | null>(null);
  const [setupMode, setSetupMode] = useState<ConnectionSetupMode | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [secret, setSecret] = useState("");
  const [oauthClientId, setOauthClientId] = useState("");
  const [oauthClientSecret, setOauthClientSecret] = useState("");
  const [customOpen, setCustomOpen] = useState(false);
  const [customName, setCustomName] = useState("");
  const [customEndpoint, setCustomEndpoint] = useState("");
  const [customBusy, setCustomBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listAgentInstallationIntegrations(installationId);
      setIntegrations(result.integrations);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Unable to load connections", { action: { label: "Retry", onClick: () => void refresh() } });
    } finally {
      setLoading(false);
    }
  }, [installationId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const liveById = new Map(integrations.map((integration) => [integration.id, integration]));
  const setupEntry = setupId ? directory.find((entry) => entry.id === setupId) : undefined;
  const normalizedQuery = query.trim().toLowerCase();
  const pinnedMcpVersionIds = new Set(draft.mcpProviderVersionIds.length ? draft.mcpProviderVersionIds : pinnedProviders.map((provider) => provider.id));
  const customProviders = providers.filter((provider) => !provider.catalog_id);
  const customConnections: AgentConnectionDirectoryEntry[] = customProviders.map((provider) => ({
    id: `custom:${provider.id}`,
    kind: "mcp",
    name: provider.name,
    description: provider.endpoint_url,
    category: "Custom",
    logo: "",
    auth: "none",
    source: "custom",
    endpointUrl: provider.endpoint_url,
    managed: true,
    configured: true,
    status: provider.health_status === "unhealthy" ? "unhealthy" : "ready",
    providerId: provider.id,
  }));
  const allConnections = [...directory.filter((entry) => entry.kind === "native" || entry.kind === "mcp"), ...customConnections];

  const closeSetup = () => {
    setSetupId(null);
    setSetupMode(null);
    setApiKey("");
    setEndpoint("");
    setSecret("");
    setOauthClientId("");
    setOauthClientSecret("");
  };

  const openSetup = (entry: AgentConnectionDirectoryEntry, mode: ConnectionSetupMode, integration?: AgentIntegration) => {
    setSetupId(entry.id);
    setSetupMode(mode);
    if (mode === "local_connector") setEndpoint(typeof integration?.configuration.endpoint === "string" ? integration.configuration.endpoint : "");
  };

  const customVersion = (entry: AgentConnectionDirectoryEntry) => entry.source === "custom" && entry.providerId
    ? (versions[entry.providerId] ?? []).filter((version) => version.status === "published").sort((left, right) => right.revision - left.revision)[0]
    : undefined;
  const emailProviderForEntry = (entry: AgentConnectionDirectoryEntry): string | null => {
    if (entry.id === "google.email") return "google";
    if (entry.id === "microsoft.email") return "microsoft";
    return null;
  };
  const workspaceEmailStatus = (connection: WorkspaceEmailConnection) => {
    if (connection.status.toUpperCase() !== "CONNECTED") return "Disconnected";
    if (connection.healthStatus.toUpperCase() !== "HEALTHY" || connection.inboundStatus === "RETRYABLE_FAILURE") return "Needs attention";
    if (connection.inboundStatus === "SYNCING" || connection.inboundStatus === "PENDING") return "Syncing";
    if (connection.inboxStatus === "ACTIVE" && connection.inboundStatus === "READY") return "Ready";
    return "Setting up";
  };
  const isWorkspaceEmailConnected = (entry: AgentConnectionDirectoryEntry) => {
    const provider = emailProviderForEntry(entry);
    return Boolean(provider && emailConnections.some((connection) => connection.provider.toLowerCase() === provider && connection.status.toLowerCase() === "connected"));
  };
  const isWorkspaceEmailBound = (entry: AgentConnectionDirectoryEntry, integration?: AgentIntegration) => {
    const provider = emailProviderForEntry(entry);
    if (!provider || integration?.status !== "connected") return false;
    const coreConnectionId = typeof integration.configuration.coreConnectionId === "string" ? integration.configuration.coreConnectionId : "";
    return Boolean(coreConnectionId && emailConnections.some((connection) => connection.id === coreConnectionId && connection.provider.toLowerCase() === provider && connection.status.toLowerCase() === "connected"));
  };
  const isConnected = (entry: AgentConnectionDirectoryEntry, integration?: AgentIntegration) => isWorkspaceEmailConnected(entry) || entry.source === "custom"
    ? entry.source === "custom"
      ? Boolean(customVersion(entry) && pinnedMcpVersionIds.has(customVersion(entry)!.id))
      : isWorkspaceEmailBound(entry, integration)
    : entry.kind === "native"
      ? integration?.status === "connected" && integration.available || entry.status === "ready"
      : entry.status === "connected" || entry.status === "ready";

  const connectedCount = allConnections.filter((entry) => isConnected(entry, entry.kind === "native" ? liveById.get(entry.id) : undefined)).length;
  const categories = [...new Set([...allConnections.map((entry) => entry.category.trim().toLowerCase()).filter(Boolean), "custom"])].sort((left, right) => {
    const rankDifference = connectionCategoryRank(left) - connectionCategoryRank(right);
    return rankDifference || connectionCategoryLabel(left).localeCompare(connectionCategoryLabel(right));
  });
  const filtered = allConnections
    .filter((entry) => !normalizedQuery || `${entry.name} ${entry.description} ${entry.category} ${(entry.keywords ?? []).join(" ")}`.toLowerCase().includes(normalizedQuery))
    .filter((entry) => categoryFilter === "all" || entry.category.trim().toLowerCase() === categoryFilter)
    .filter((entry) => connectionFilter !== "connected" || isConnected(entry, entry.kind === "native" ? liveById.get(entry.id) : undefined))
    .sort((left, right) => {
      const leftConnected = isConnected(left, left.kind === "native" ? liveById.get(left.id) : undefined);
      const rightConnected = isConnected(right, right.kind === "native" ? liveById.get(right.id) : undefined);
      if (leftConnected !== rightConnected) return leftConnected ? -1 : 1;
      const categoryDifference = connectionCategoryRank(left.category) - connectionCategoryRank(right.category);
      return categoryDifference || left.name.localeCompare(right.name);
    });

  const connect = async (entry: AgentConnectionDirectoryEntry, integration?: AgentIntegration) => {
    setBusyId(entry.id);
    try {
      const workspaceProvider = emailProviderForEntry(entry);
      const workspaceMailboxes = workspaceProvider
        ? emailConnections.filter((connection) => connection.provider.toLowerCase() === workspaceProvider && connection.status.toLowerCase() === "connected")
        : [];
      if (workspaceProvider && workspaceMailboxes.length > 0) {
        if (workspaceMailboxes.length !== 1) {
          toast.error("Choose a mailbox above");
          return;
        }
        await bindAgentWorkspaceEmail(installationId, entry.id, workspaceMailboxes[0]!.id);
        toast.success("Mailbox added to agent");
        await refresh();
        onRefresh();
        return;
      }
      if (entry.kind === "mcp") {
        if (entry.auth === "oauth") {
          const result = await startAgentMcpCatalogOAuth(installationId, entry.id, {
            agentVersionId: versionId ?? undefined,
            ...(setupMode === "oauth_client" && oauthClientId.trim()
              ? { clientId: oauthClientId.trim(), ...(oauthClientSecret.trim() ? { clientSecret: oauthClientSecret.trim() } : {}) }
              : {}),
          });
          window.location.assign(result.authorizationUrl);
          return;
        }
        await connectAgentMcpCatalog(installationId, entry.id, { apiKey: apiKey.trim() || undefined, agentVersionId: versionId ?? undefined });
      } else if (entry.kind === "native" && entry.auth === "oauth2") {
        const result = await startAgentIntegrationOAuth(installationId, entry.id);
        window.location.assign(result.authorizationUrl);
        return;
      } else if (entry.auth === "api_key" || integration?.auth === "api_key") {
        await saveAgentIntegrationApiKey(installationId, entry.id, { apiKey: apiKey.trim() });
      } else if (entry.auth === "local_connector" || integration?.auth === "local_connector") {
        await saveAgentIntegrationLocalConnector(installationId, entry.id, { endpoint: endpoint.trim(), secret: secret.trim() });
      }
      closeSetup();
      await refresh();
      onRefresh();
    } catch (cause) {
      if (entry.kind === "mcp" && entry.auth === "oauth" && cause instanceof AgentRequestError && cause.code === "mcp_oauth_client_registration_unsupported") {
        openSetup(entry, "oauth_client", integration);
      } else {
        toast.error(connectionErrorMessage(cause));
      }
    } finally {
      setBusyId(null);
    }
  };

  const toggleCustom = async (entry: AgentConnectionDirectoryEntry) => {
    const version = customVersion(entry);
    if (!entry.providerId || !version) {
      toast.error("This connector has no published tools");
      return;
    }
    const enabled = pinnedMcpVersionIds.has(version.id);
    setBusyId(entry.id);
    try {
      if (versionId) {
        if (enabled) await unpinAgentMcpProviderVersion(versionId, version.id);
        else await pinAgentMcpProviderVersion(versionId, version.id);
      }
      onDraftChange((current) => ({ ...current, mcpProviderVersionIds: enabled ? current.mcpProviderVersionIds.filter((id) => id !== version.id) : [...new Set([...current.mcpProviderVersionIds, version.id])] }));
      onRefresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Unable to update custom connector");
    } finally {
      setBusyId(null);
    }
  };

  const addCustomConnector = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!customName.trim() || !customEndpoint.trim()) return;
    setCustomBusy(true);
    try {
      const provider = await createAgentMcpProvider({ name: customName.trim(), endpointUrl: customEndpoint.trim() });
      const discovered = await discoverAgentMcpProvider(provider.id);
      const published = await publishAgentMcpProviderVersion(provider.id, discovered.id);
      if (versionId) await pinAgentMcpProviderVersion(versionId, published.id);
      onDraftChange((current) => ({ ...current, mcpProviderVersionIds: [...new Set([...current.mcpProviderVersionIds, published.id])] }));
      setCustomName("");
      setCustomEndpoint("");
      setCustomOpen(false);
      toast.success("Custom connector added");
      onRefresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : "Unable to add custom connector");
    } finally {
      setCustomBusy(false);
    }
  };

  const authLabel = (entry: AgentConnectionDirectoryEntry, integration?: AgentIntegration) => {
    if (entry.source === "custom") return "Custom MCP";
    if (entry.kind === "mcp") return entry.auth === "oauth" ? "OAuth" : entry.auth === "api_key" ? "API key" : "No key";
    if ((integration?.auth ?? entry.auth) === "oauth2") return "OAuth";
    if ((integration?.auth ?? entry.auth) === "api_key") return "API key";
    if ((integration?.auth ?? entry.auth) === "local_connector") return "Connector";
    return (integration?.auth ?? entry.auth) === "internal" ? "Included" : "Server";
  };

  const setupDisabled = setupMode === "api_key"
    ? !apiKey.trim()
    : setupMode === "local_connector"
      ? !endpoint.trim() || !secret.trim()
      : !oauthClientId.trim();

  return <div className="space-y-4">
    {emailConnections.length ? <section className="rounded-xl border border-border bg-muted/20 p-3"><div className="flex items-center justify-between gap-3"><div><p className="text-xs font-medium text-foreground">Workspace mailboxes</p><p className="mt-1 text-[11px] text-muted-foreground">Shared with Inbox</p></div><span className="text-[10px] text-muted-foreground">{emailConnections.length}</span></div><div className="mt-3 grid gap-2 sm:grid-cols-2">{emailConnections.map((connection) => { const provider = connection.provider.toLowerCase(); const integrationId = provider === "microsoft" ? "microsoft.email" : "google.email"; const integration = liveById.get(integrationId); const bound = integration?.status === "connected" && integration.configuration.coreConnectionId === connection.id; const status = workspaceEmailStatus(connection); const ready = status === "Ready"; return <div key={connection.id} className="flex items-center gap-2 rounded-lg border border-border bg-background/40 px-2.5 py-2"><span className={cn("size-1.5 shrink-0 rounded-full", ready ? "bg-emerald-500" : status === "Needs attention" ? "bg-amber-500" : "bg-blue-400")} /><div className="min-w-0 flex-1"><p className="truncate text-[11px] font-medium text-foreground">{connection.emailAddress}</p><p className="truncate text-[10px] text-muted-foreground">{connection.provider} · {status}</p></div><Button type="button" size="sm" variant={bound ? "outline" : "secondary"} className="h-7 px-2 text-[10px]" disabled={bound || busyId === connection.id || connection.status.toUpperCase() !== "CONNECTED"} onClick={() => { setBusyId(connection.id); void bindAgentWorkspaceEmail(installationId, integrationId, connection.id).then(async () => { toast.success("Mailbox added to agent"); await refresh(); onRefresh(); }).catch((cause) => toast.error(connectionErrorMessage(cause))).finally(() => setBusyId(null)); }}>{bound ? "Bound" : busyId === connection.id ? "…" : "Use"}</Button></div>; })}</div></section> : null}
    <div className="flex justify-end"><Button type="button" size="sm" onClick={() => setCustomOpen(true)}><Plus className="mr-1.5 size-3.5" />Add</Button></div>
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant={connectionFilter === "all" ? "secondary" : "outline"} onClick={() => setConnectionFilter("all")}>All <span className="ml-1 rounded-full bg-background/60 px-1.5 py-0.5 text-[10px]">{allConnections.length}</span></Button>
      <Button type="button" size="sm" variant={connectionFilter === "connected" ? "secondary" : "outline"} onClick={() => setConnectionFilter("connected")}>Connected{connectedCount ? ` · ${connectedCount}` : ""}</Button>
      <Select value={categoryFilter} onValueChange={setCategoryFilter}>
        <SelectTrigger className="h-8 w-full text-xs sm:w-44"><SelectValue placeholder="Category" /></SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All categories</SelectItem>
          {categories.map((category) => <SelectItem key={category} value={category}>{connectionCategoryLabel(category)}</SelectItem>)}
        </SelectContent>
      </Select>
      </div>
      <DirectorySearch value={query} onChange={setQuery} placeholder="Search connections" />
    </div>
    {loading ? <div className="grid gap-2 sm:grid-cols-2"><div className="h-24 animate-pulse rounded-xl border border-border bg-muted/20" /><div className="h-24 animate-pulse rounded-xl border border-border bg-muted/20" /></div> : null}
    {!loading && filtered.length ? <div className="grid gap-2 sm:grid-cols-2">{filtered.map((entry) => {
      const integration = entry.kind === "native" ? liveById.get(entry.id) : undefined;
      const connected = isConnected(entry, integration);
      const needsAttention = entry.status === "unhealthy";
      const unsupported = entry.kind === "mcp" && (entry.status === "unsupported" || entry.transport === "stdio" || !entry.managed);
      const needsApiKey = entry.auth === "api_key";
      const needsLocalConnector = entry.kind === "native" && (entry.auth === "local_connector" || integration?.auth === "local_connector");
      const actionDisabled = unsupported || (connected && entry.source !== "custom") || busyId === entry.id || entry.auth === "observability" || entry.auth === "internal" || integration?.auth === "observability" || integration?.auth === "internal";
      return <div key={entry.id} className={cn("rounded-xl border border-border p-3 transition-colors", unsupported ? "opacity-60" : "hover:border-primary/40")}>
        <div className="flex items-center gap-3"><DirectoryIcon label={entry.name} logo={entry.logo} icon={entry.kind === "mcp" ? <PlugZap className="size-5" /> : <Wrench className="size-5" />} /><div className="min-w-0 flex-1"><p className="truncate text-xs font-medium text-foreground">{entry.name}</p><p className="mt-1 line-clamp-2 text-[11px] leading-4 text-muted-foreground">{entry.description}</p><p className="mt-1 text-[10px] text-muted-foreground">{authLabel(entry, integration)}</p></div><span className={cn("size-1.5 shrink-0 rounded-full", connected ? "bg-emerald-500" : unsupported ? "bg-muted-foreground/40" : "bg-amber-500")} /><Button type="button" variant={connected || needsAttention ? "outline" : "default"} size="icon" className="size-8 shrink-0" aria-label={unsupported ? `${entry.name} unavailable` : connected && entry.source === "custom" ? `Disable ${entry.name}` : connected ? `${entry.name} connected` : needsAttention ? `Retry ${entry.name}` : `Connect ${entry.name}`} disabled={actionDisabled} onClick={() => { if (entry.source === "custom") void toggleCustom(entry); else if (entry.kind === "mcp" && entry.auth === "oauth") void connect(entry, integration); else if (needsApiKey) openSetup(entry, "api_key", integration); else if (needsLocalConnector) openSetup(entry, "local_connector", integration); else void connect(entry, integration); }}>{busyId === entry.id ? <Clock3 className="size-3.5 animate-pulse" /> : connected ? <Check className="size-4 text-emerald-500" /> : unsupported ? <LockKeyhole className="size-3.5" /> : entry.auth === "observability" || integration?.auth === "observability" ? <Activity className="size-3.5" /> : entry.auth === "internal" || integration?.auth === "internal" ? <Check className="size-4" /> : needsAttention ? <RefreshCw className="size-3.5" /> : <Plus className="size-4" />}</Button></div>
      </div>;
    })}</div> : null}
    {!loading && !filtered.length ? <p className="rounded-xl border border-dashed border-border px-3 py-5 text-center text-xs text-muted-foreground">No connections match.</p> : null}
    <Dialog open={Boolean(setupId)} onOpenChange={(open) => { if (!open) closeSetup(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>{setupEntry?.name ?? "Connect"}</DialogTitle></DialogHeader>
        {setupMode === "api_key" ? <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="API key" className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary" autoComplete="off" /> : null}
        {setupMode === "local_connector" ? <div className="space-y-2"><input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} placeholder="Connector URL" className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary" /><input type="password" value={secret} onChange={(event) => setSecret(event.target.value)} placeholder="Connector secret" className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary" autoComplete="off" /></div> : null}
        {setupMode === "oauth_client" ? <div className="space-y-2"><input value={oauthClientId} onChange={(event) => setOauthClientId(event.target.value)} placeholder="OAuth client ID" className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary" autoComplete="off" /><input type="password" value={oauthClientSecret} onChange={(event) => setOauthClientSecret(event.target.value)} placeholder="OAuth client secret (optional)" className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary" autoComplete="off" /></div> : null}
        <DialogFooter><Button type="button" variant="ghost" onClick={closeSetup}>Cancel</Button><Button type="button" disabled={!setupEntry || setupDisabled || busyId === setupId} onClick={() => { if (setupEntry) void connect(setupEntry, setupEntry.kind === "native" ? liveById.get(setupEntry.id) : undefined); }}>{busyId === setupId ? "…" : setupMode === "oauth_client" ? "Continue" : "Connect"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={customOpen} onOpenChange={(open) => { setCustomOpen(open); if (!open) { setCustomName(""); setCustomEndpoint(""); } }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>Add custom connector</DialogTitle><p className="text-sm leading-5 text-muted-foreground">Connect KasiTek to your data and tools.</p></DialogHeader>
        <form onSubmit={addCustomConnector} className="space-y-4">
          <div className="space-y-2"><input value={customName} onChange={(event) => setCustomName(event.target.value)} placeholder="Name" className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary" autoFocus /><p className="text-xs text-muted-foreground">Shown in the connections list.</p></div>
          <div className="space-y-2"><input value={customEndpoint} onChange={(event) => setCustomEndpoint(event.target.value)} placeholder="Remote MCP server URL" type="url" className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary" /><p className="text-xs text-muted-foreground">The HTTPS address where the server accepts MCP requests.</p></div>
          <p className="text-xs leading-5 text-muted-foreground">Only use connectors from developers you trust.</p>
          <DialogFooter><Button type="button" variant="ghost" onClick={() => setCustomOpen(false)}>Cancel</Button><Button type="submit" disabled={customBusy || !customName.trim() || !customEndpoint.trim()}>{customBusy ? "Adding…" : "Continue"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </div>;
}

function ConnectionCapabilitiesPanel({ installationId, connectionDirectory, emailConnections, providers, pinnedProviders, versions, versionId, draft, onDraftChange, onRefresh }: { installationId: string | null; connectionDirectory: AgentConnectionDirectoryEntry[]; emailConnections: WorkspaceEmailConnection[]; providers: AgentMcpProvider[]; pinnedProviders: AgentMcpProviderVersion[]; versions: Record<string, AgentMcpProviderVersion[]>; versionId: string | null; draft: StudioCapabilityDraft; onDraftChange: (value: StudioCapabilityDraft | ((current: StudioCapabilityDraft) => StudioCapabilityDraft)) => void; onRefresh: () => void }) {
  return installationId ? <ConnectionCataloguePanel installationId={installationId} versionId={versionId} directory={connectionDirectory} emailConnections={emailConnections} providers={providers} pinnedProviders={pinnedProviders} versions={versions} draft={draft} onDraftChange={onDraftChange} onRefresh={onRefresh} /> : null;
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

function memoryLabel(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function MemoryCheckboxGroup({ title, values, selected, onChange }: { title: string; values: readonly string[]; selected: string[]; onChange: (next: string[]) => void }) {
  const selectedSet = new Set(selected);
  return <fieldset className="rounded-xl border border-border p-3"><legend className="px-1 text-xs font-medium text-foreground">{title}</legend><div className="mt-2 grid gap-2 sm:grid-cols-2">{values.map((value) => <label key={value} className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs text-muted-foreground hover:bg-muted/50"><input type="checkbox" checked={selectedSet.has(value)} onChange={(event) => onChange(event.target.checked ? [...selected, value] : selected.filter((item) => item !== value))} className="size-3.5 accent-primary" />{memoryLabel(value)}</label>)}</div></fieldset>;
}

function MemorySection({ draft, onDraftChange }: { draft: StudioMemoryDraft; onDraftChange: (value: StudioMemoryDraft | ((current: StudioMemoryDraft) => StudioMemoryDraft)) => void }) {
  const update = <K extends keyof StudioMemoryDraft>(key: K, value: StudioMemoryDraft[K]) => onDraftChange((current) => ({ ...current, [key]: value }));
  return <div className="space-y-5"><section className="rounded-2xl border border-border bg-card p-4 sm:p-5"><div className="flex items-start gap-3"><span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary"><MemoryStick className="size-4" /></span><div><h4 className="text-sm font-semibold text-foreground">Memory policy</h4><p className="mt-1 text-xs leading-5 text-muted-foreground">Controls runtime retrieval, writes, and retention. Memory records stay in the current environment.</p></div></div><label className="mt-5 block text-xs font-medium text-foreground">Mode<Select value={draft.mode} onValueChange={(value) => update("mode", value as StudioMemoryDraft["mode"])}><SelectTrigger className="mt-1.5 h-10 text-sm font-normal"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="disabled">Disabled</SelectItem><SelectItem value="explicit">Explicit retrieval</SelectItem><SelectItem value="reviewed">Reviewed writes</SelectItem><SelectItem value="automatic">Automatic</SelectItem></SelectContent></Select></label></section><section className="rounded-2xl border border-border bg-card p-4 sm:p-5"><div className="grid gap-4 sm:grid-cols-2"><MemoryCheckboxGroup title="Readable scopes" values={memoryNamespaces} selected={draft.readableNamespaces} onChange={(next) => update("readableNamespaces", next)} /><MemoryCheckboxGroup title="Writable scopes" values={memoryNamespaces} selected={draft.writableNamespaces} onChange={(next) => update("writableNamespaces", next)} /><MemoryCheckboxGroup title="Writable types" values={memoryTypes} selected={draft.writableTypes} onChange={(next) => update("writableTypes", next)} /></div></section><section className="rounded-2xl border border-border bg-card p-4 sm:p-5"><div><h4 className="text-sm font-semibold text-foreground">Limits and retention</h4><p className="mt-1 text-xs text-muted-foreground">Keep memory evidence bounded for each run.</p></div><div className="mt-4 grid gap-4 sm:grid-cols-2"><label className="block text-xs font-medium text-foreground">Retrieved items<input type="number" min={0} max={50} value={draft.maxRetrieved} onChange={(event) => update("maxRetrieved", Math.max(0, Math.min(50, Number(event.target.value) || 0)))} className="mt-1.5 h-10 w-full rounded-md border border-border bg-background px-3 text-sm font-normal text-foreground outline-none focus:border-primary" /></label><label className="block text-xs font-medium text-foreground">Retrieved tokens<input type="number" min={256} max={8_000} value={draft.maxRetrievedTokens} onChange={(event) => update("maxRetrievedTokens", Math.max(256, Math.min(8_000, Number(event.target.value) || 256)))} className="mt-1.5 h-10 w-full rounded-md border border-border bg-background px-3 text-sm font-normal text-foreground outline-none focus:border-primary" /></label><label className="block text-xs font-medium text-foreground">Writes per run<input type="number" min={0} max={20} value={draft.maxWritesPerRun} onChange={(event) => update("maxWritesPerRun", Math.max(0, Math.min(20, Number(event.target.value) || 0)))} className="mt-1.5 h-10 w-full rounded-md border border-border bg-background px-3 text-sm font-normal text-foreground outline-none focus:border-primary" /></label><label className="block text-xs font-medium text-foreground">Retention days<input type="number" min={1} max={3_650} value={draft.retentionDays} onChange={(event) => update("retentionDays", event.target.value)} placeholder="No limit" className="mt-1.5 h-10 w-full rounded-md border border-border bg-background px-3 text-sm font-normal text-foreground outline-none focus:border-primary" /></label></div><label className="mt-4 flex items-center gap-2 text-xs text-foreground"><input type="checkbox" checked={draft.allowSensitive} onChange={(event) => update("allowSensitive", event.target.checked)} className="size-3.5 accent-primary" />Allow sensitive memory</label></section><SettingNote title="Environment-local memory" detail="Changing this policy affects the next Playground turn after save. It does not copy memories into a candidate or change Live until deployment." /></div>;
}

function GatewaysSection({ agent, installationId }: { agent: AgentDefinition; installationId: string | null }) {
  if (!installationId) return <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground">No agent installation.</p>;
  return <InstallationIntegrations agentId={agent.id} installationId={installationId} personal={agent.execution_mode === "system_hosted"} agentName={agent.name} gatewaysOnly />;
}

function SafetySection() {
  return <div className="space-y-4"><SettingNote title="Runtime safety" detail="The backend enforces workspace access and tool permissions. Approval requirements depend on the version and action; this screen does not change them." /><SettingNote title="Policy review pending" detail="A detailed safety-policy view is not connected in this initial frontend. Run evidence and approval requests appear in the observatory when available." /></div>;
}

function RuntimeSection({ selectedModel, pickerModels, modelCatalog, modelCatalogLoading, effectiveSelection, setModelSelection }: { selectedModel?: AgentModel; pickerModels: AgentModel[]; modelCatalog: AgentModelCatalog | null; modelCatalogLoading: boolean; effectiveSelection: ModelSelection | null; setModelSelection: (value: ModelSelection | null) => void }) {
  return <div className="space-y-4"><section className="rounded-2xl border border-border bg-card p-4 sm:p-5"><div className="flex items-start justify-between gap-4"><div><div className="flex items-center gap-2"><Sparkles className="size-4 text-primary" /><h4 className="text-sm font-semibold text-foreground">Model</h4></div><p className="mt-1 text-xs text-muted-foreground">The model used for the next Playground run.</p></div>{selectedModel ? <span className="text-[11px] text-muted-foreground">{formatTokens(selectedModel.contextWindow)} context</span> : null}</div>{modelCatalogLoading ? <p className="mt-4 text-xs text-muted-foreground">Loading models…</p> : modelCatalog ? <div className="mt-4"><AgentModelPicker model={selectedModel} models={pickerModels} disabled={!pickerModels.length} ariaLabel="Select agent model" pickerTitle="Choose a model" onSelect={(model, provider) => setModelSelection({ model, provider })} />{effectiveSelection ? <p className="mt-2 text-[11px] text-muted-foreground">{effectiveSelection.provider}:{effectiveSelection.model}</p> : null}</div> : <p className="mt-4 text-xs text-muted-foreground">Model catalog unavailable.</p>}</section><div className="grid gap-4 sm:grid-cols-2"><InfoTile label="Context window" value={formatTokens(selectedModel?.contextWindow)} icon={<MemoryStick className="size-4" />} /><InfoTile label="Max output" value={formatTokens(selectedModel?.maxOutputTokens)} icon={<Activity className="size-4" />} /><InfoTile label="Run budget" value="Configured per version" icon={<Clock3 className="size-4" />} /><InfoTile label="Overflow recovery" value="Runtime-managed" icon={<Wrench className="size-4" />} /></div><SettingNote title="Runtime policy stays with the context runtime" detail="This screen exposes the policy and measurements. It does not calculate token usage in the browser." /></div>;
}

function InfoTile({ label, value, icon }: { label: string; value: string; icon: ReactNode }) {
  return <div className="rounded-2xl border border-border bg-card p-4"><div className="flex items-center gap-2 text-muted-foreground">{icon}<span className="text-[11px]">{label}</span></div><p className="mt-3 text-sm font-medium text-foreground">{value}</p></div>;
}

function SettingNote({ title, detail }: { title: string; detail: string }) {
  return <div className="flex gap-3 rounded-2xl border border-primary/20 bg-primary/5 p-4"><CircleHelp className="mt-0.5 size-4 shrink-0 text-primary" /><div><p className="text-xs font-medium text-foreground">{title}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p></div></div>;
}
