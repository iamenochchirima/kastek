"use client";

import Link from "next/link";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { Archive, ArrowLeft, BarChart3, BookOpen, CheckCircle2, Copy, Cpu, Globe2, History, KeyRound, LayoutDashboard, MessageSquare, PlugZap, RefreshCw, Rocket, RotateCcw, Settings2, SlidersHorizontal, Sparkles, Trash2, Upload, Workflow, Wrench } from "lucide-react";
import type { IconType } from "react-icons";
import { SiDiscord, SiInstagram, SiMessenger, SiModelcontextprotocol, SiTelegram, SiWhatsapp } from "react-icons/si";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useConfirmationDialog } from "@/components/ui/confirmation-provider";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { AgentWorkflowEditor, type WorkflowGraphValue } from "./agent-workflow-editor";
import { AgentChatPanel } from "./agent-chat-panel";
import { AgentAnalyticsPanel } from "./agent-analytics-panel";
import { AgentModelPicker } from "./agent-model-picker";
import { AgentRuntimeLimits, defaultAgentRuntimeLimits, parseAgentRuntimeLimits, type AgentRuntimeLimitsValue } from "./agent-runtime-limits";
import { AgentToolIntegrations } from "./agent-tool-integrations";
import { AgentMessageMedia, agentMessageHasMedia } from "./agent-message-media";
import { listWorkspaceConnections, type WorkspaceConnection } from "@/lib/connections";
import {
  archiveAgent,
  deleteAgent,
  archiveExternalAgent,
  updateAgent,
  getExternalAgentHealth,
  getAgentModelCatalog,
  listAgentProviderCredentials,
  verifyAgentProviderCredential,
  createAgentProviderCredential,
  getKasiAiHome,
  setAgentInstallationStatus,
  publishAgentVersion,
  createAgentVersion,
  rollbackAgentVersion,
  retireAgentVersion,
  updateAgentInstallationSettings,
  updateKasiAiConversation,
  updateKasiAiPreferences,
  getPlatformConversation,
  listAgentConversations,
  sendPlatformMessage,
  createAgentInstallationCredential,
  listAgentInstallationCredentials,
  revokeAgentInstallationCredential,
  rotateAgentInstallationCredential,
  type AgentInstallationCredential,
  grantAgentInstallationTool,
  listAgentInstallationCapabilities,
  getAgentInstallationReadiness,
  type AgentReadiness,
  type AgentCapability,
  listAgentInstallationGrants,
  grantAgentInstallationResource,
  listAgentConnectors,
  listAgentInstallationConnectors,
  grantAgentInstallationConnector,
  type AgentConnector,
  listAgentInstallationRuns,
  listAgentInstallationOperations,
  type AgentInstallationRun,
  type AgentInstallationOperation,
  type AgentInstallationOperationSummary,
  listAgentInstallationSchedules,
  createAgentInstallationSchedule,
  setAgentScheduleStatus,
  type AgentSchedule,
  listAgentKnowledgeSources,
  getAgentKnowledgeSource,
  createAgentKnowledgeSource,
  startAgentWebsiteCrawl,
  getAgentWebsiteCrawl,
  cancelAgentWebsiteCrawl,
  ingestAgentKnowledgeSourceFile,
  ingestAgentKnowledgeSourceText,
  deleteAgentKnowledgeSource,
  listAgentMemory,
  deleteAgentMemory,
  revalidateAgentMemory,
  reviewAgentMemory,
  type AgentKnowledgeSource,
  type AgentMemory,
  listKasiAiChannels,
  createAgentChannelConnection,
  revokeAgentChannelConnection,
  updateAgentChannelAllowedUsers,
  updateAgentChannelAllowedPhones,
  issueAgentChannelPairing,
  disconnectKasiAiChannel,
  createAgentWebsiteDeployment,
  listAgentWebsiteDeployments,
  updateAgentWebsiteDeployment,
  setAgentWebsiteDeploymentStatus,
  type AgentChannelConnection,
  type AgentChannelBinding,
  type AgentIntegration,
  type AgentDefinition,
  type AgentModel,
  type AgentModelCatalog,
  type AgentModelProvider,
  type AgentProviderCredential,
  type KasiAiHome,
  type AgentVersion,
  type AgentMessage,
  type AgentConversation,
  type AgentWebsiteDeployment,
  AGENT_MODEL_PROVIDERS,
  AGENT_MODEL_PROVIDER_LABELS,
} from "@/lib/agent-platform";

function versionStatusClass(status: string) {
  if (status === "published") return "border-status-success/30 bg-status-success-soft text-status-success";
  if (status === "draft") return "border-status-attention/30 bg-status-attention-soft text-status-attention";
  return "border-border bg-secondary text-muted-foreground";
}

const EMPTY_KASIAI_MODELS: AgentModel[] = [];
const MODEL_PROVIDERS: AgentModelProvider[] = [...AGENT_MODEL_PROVIDERS];

function providerLabel(provider?: AgentModelProvider | null) {
  return provider ? AGENT_MODEL_PROVIDER_LABELS[provider] : "provider";
}

function ProviderLogo({ provider, compact = false }: { provider: AgentModelProvider; compact?: boolean }) {
  const size = compact ? 24 : 36;
  return <span className={`grid shrink-0 place-items-center overflow-hidden rounded-lg ${compact ? "h-6 w-6" : "h-9 w-9"}`} aria-hidden="true">
    <Image src={`/images/model-providers/${provider}.svg`} alt="" width={size} height={size} className="h-full w-full" />
  </span>;
}

function ProviderTabs({ value, onChange, configuredProviders }: { value: AgentModelProvider | null; onChange: (provider: AgentModelProvider) => void; configuredProviders: AgentModelProvider[] }) {
  return <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" role="tablist" aria-label="API key providers">
    {MODEL_PROVIDERS.map((provider) => {
      const configured = configuredProviders.includes(provider);
      const selected = value === provider;
      return <button key={provider} type="button" role="tab" aria-selected={selected} onClick={() => onChange(provider)} className={`rounded-lg border p-3 text-left transition-colors ${selected ? "border-primary bg-primary/10" : "border-border bg-background hover:border-primary/50"}`}>
        <span className="flex items-center justify-between gap-2"><span className="flex min-w-0 items-center gap-2"><ProviderLogo provider={provider} /><span className="truncate font-medium text-foreground">{providerLabel(provider)}</span></span>{selected ? <Badge className="border-primary/30 bg-primary/10 text-primary">Selected</Badge> : null}</span>
        <span className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground"><span className={`h-1.5 w-1.5 rounded-full ${configured ? "bg-status-success" : "bg-muted-foreground/50"}`} />{configured ? "Configured" : "Not configured"}</span>
      </button>;
    })}
  </div>;
}

type ApiKeyConfigurationDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: AgentModelProvider;
  credentialKey: string;
  onCredentialKeyChange: (value: string) => void;
  credentialSaving: boolean;
  credentialError: string | null;
  credentialSaved: boolean;
  onSave: () => void;
};

function ApiKeyConfigurationDialog({
  open,
  onOpenChange,
  provider,
  credentialKey,
  onCredentialKeyChange,
  credentialSaving,
  credentialError,
  credentialSaved,
  onSave,
}: ApiKeyConfigurationDialogProps) {
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="max-w-xl">
      <DialogHeader>
        <DialogTitle>{providerLabel(provider)} API key</DialogTitle>
        <DialogDescription>API key</DialogDescription>
      </DialogHeader>
      <div className="space-y-4">
        <label className="text-xs font-medium text-foreground">API key<Input type="password" value={credentialKey} onChange={(event) => onCredentialKeyChange(event.target.value)} autoComplete="new-password" className="mt-1" placeholder={`Your ${providerLabel(provider)} key`} /></label>
        {credentialSaved ? <p className="text-xs text-status-success" role="status">API key saved.</p> : null}
        {credentialError ? <p className="text-xs text-destructive" role="alert">{credentialError}</p> : null}
      </div>
      <DialogFooter className="mt-2">
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button type="button" disabled={!credentialKey.trim() || credentialSaving} onClick={onSave}>{credentialSaving ? "Saving…" : "Verify & save"}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function capabilityGroup(capability: AgentCapability) {
  const scope = capability.permission?.scope || capability.name.split(".")[2] || "platform";
  return scope.split(".")[0] || "platform";
}

function KasiAiModels({ installationId }: { installationId: string }) {
  const [home, setHome] = useState<KasiAiHome | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [credentialMode, setCredentialMode] = useState<"platform" | "user">("platform");
  const [credentialProvider, setCredentialProvider] = useState<AgentModelProvider | null>(null);
  const [credentialReference, setCredentialReference] = useState("");
  const [providerCredentials, setProviderCredentials] = useState<AgentProviderCredential[]>([]);
  const [credentialKey, setCredentialKey] = useState("");
  const [credentialSaving, setCredentialSaving] = useState(false);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [credentialSaved, setCredentialSaved] = useState(false);
  const [apiKeyDialogOpen, setApiKeyDialogOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void getKasiAiHome(installationId)
      .then((response) => {
        if (!cancelled) {
          const savedReference = response.preferences?.default_credential_reference ?? "";
          setHome(response);
          setCredentialReference(savedReference);
          setCredentialMode(savedReference ? "user" : "platform");
        }
      })
      .catch((cause) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "Unable to load KasiAi settings");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [installationId]);

  useEffect(() => {
    let cancelled = false;
    void listAgentProviderCredentials()
      .then((response) => {
        if (!cancelled) setProviderCredentials(response.credentials);
      })
      .catch((cause) => {
        if (!cancelled) setCredentialError(cause instanceof Error ? cause.message : "Unable to load saved API keys");
      });
    return () => { cancelled = true; };
  }, []);

  const models = home?.models ?? EMPTY_KASIAI_MODELS;
  const configuredProvider = home?.preferences?.default_model_provider;
  const configuredModel = home?.preferences?.default_model;
  const fallbackModel = models.find((model) => model.isWorkspaceDefault) ?? models[0];
  const selectedProvider = configuredProvider ?? fallbackModel?.provider;
  const selectedModelId = configuredModel ?? fallbackModel?.model;
  const selectedAvailable = models.some((model) => model.provider === selectedProvider && model.model === selectedModelId);
  const pickerModels = useMemo<AgentModel[]>(() => {
    if (!selectedProvider || !selectedModelId || selectedAvailable) return models;
    return [{ provider: selectedProvider, model: selectedModelId, label: selectedModelId, description: "Saved model is not in the current catalog.", tier: "balanced" }, ...models];
  }, [models, selectedAvailable, selectedModelId, selectedProvider]);
  const selected = pickerModels.find((model) => model.provider === selectedProvider && model.model === selectedModelId);
  const activeProviderCredentials = providerCredentials.filter((credential) => credential.provider === credentialProvider && credential.status === "active");

  const selectModel = async (model: string, provider: AgentModelProvider) => {
    setSaving(true);
    setError(null);
    try {
      const savedCredentialReference = credentialReference || home?.preferences?.default_credential_reference || "";
      const credentialBelongsToPreviousProvider = Boolean(savedCredentialReference && home?.preferences?.default_model_provider && home.preferences.default_model_provider !== provider);
      const response = await updateKasiAiPreferences(installationId, { defaultModelProvider: provider, defaultModel: model, ...(credentialBelongsToPreviousProvider ? { defaultCredentialReference: null } : {}) });
      if (home?.channelDefaultConversationId) {
        await updateKasiAiConversation(home.channelDefaultConversationId, { modelProvider: provider, model });
      }
      setHome((current) => current ? { ...current, preferences: response.preferences } : current);
      if (credentialBelongsToPreviousProvider) {
        setCredentialReference("");
        setCredentialMode("platform");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to change the KasiAi model");
    } finally {
      setSaving(false);
    }
  };

  const selectProviderCredential = async (reference: string) => {
    if (reference === "new" || !selectedProvider || saving) {
      setCredentialReference("");
      setCredentialMode("user");
      setCredentialSaved(false);
      if (reference === "new") setApiKeyDialogOpen(true);
      return;
    }
    if (!reference) {
      const savedCredentialReference = credentialReference || home?.preferences?.default_credential_reference || "";
      if (!savedCredentialReference) {
        setCredentialMode("platform");
        return;
      }
      setSaving(true);
      setCredentialError(null);
      try {
        const response = await updateKasiAiPreferences(installationId, { defaultCredentialReference: null });
        setHome((current) => current ? { ...current, preferences: response.preferences } : current);
        setCredentialReference("");
        setCredentialMode("platform");
      } catch (cause) {
        setCredentialError(cause instanceof Error ? cause.message : "Unable to use the platform API key");
      } finally {
        setSaving(false);
      }
      return;
    }
    if (credentialProvider !== selectedProvider) {
      setCredentialError(`Select ${providerLabel(credentialProvider)} as the model provider before using this key.`);
      return;
    }
    setSaving(true);
    setCredentialError(null);
    try {
      const response = await updateKasiAiPreferences(installationId, { defaultCredentialReference: reference });
      setHome((current) => current ? { ...current, preferences: response.preferences } : current);
      setCredentialReference(reference);
      setCredentialMode("user");
      setCredentialSaved(true);
      setApiKeyDialogOpen(false);
    } catch (cause) {
      setCredentialError(cause instanceof Error ? cause.message : "Unable to select this API key");
    } finally {
      setSaving(false);
    }
  };

  const saveProviderCredential = async () => {
    if (!credentialProvider || !credentialKey.trim() || credentialSaving) return;
    setCredentialSaving(true);
    setCredentialError(null);
    setCredentialSaved(false);
    try {
      await verifyAgentProviderCredential({ provider: credentialProvider, apiKey: credentialKey.trim() });
      const created = await createAgentProviderCredential({ provider: credentialProvider, apiKey: credentialKey.trim() });
      const response = credentialProvider === selectedProvider
        ? await updateKasiAiPreferences(installationId, { defaultCredentialReference: created.id })
        : null;
      const metadata: AgentProviderCredential = { ...created, funding_source: "user", status: "active", created_at: new Date().toISOString() };
      setProviderCredentials((current) => [metadata, ...current.filter((credential) => credential.id !== created.id)]);
      if (response) {
        setHome((current) => current ? { ...current, preferences: response.preferences } : current);
        setCredentialReference(created.id);
      } else {
        setCredentialReference("");
      }
      setCredentialMode("user");
      setCredentialKey("");
      setCredentialSaved(true);
      setApiKeyDialogOpen(false);
    } catch (cause) {
      setCredentialError(cause instanceof Error ? cause.message : "Unable to save this API key");
    } finally {
      setCredentialSaving(false);
    }
  };

  return <>
    <Card><CardContent className="space-y-4 p-6">
    <div><h2 className="text-lg font-semibold text-foreground">Models</h2><p className="mt-1 text-sm text-muted-foreground">Choose the default model and API key.</p></div>
    <div className="rounded-xl border border-border bg-secondary/20 p-4">
      <h3 className="text-sm font-semibold text-foreground">Default model</h3>
      <div className="mt-3 max-w-xl">
        <AgentModelPicker model={selected} models={pickerModels} disabled={loading || saving || !pickerModels.length} pickerTitle="Choose a model for KasiAi" ariaLabel="Choose KasiAi's model" onSelect={(model, provider) => void selectModel(model, provider)} />
      </div>
      <p className="mt-2 text-xs text-muted-foreground">Used for new chats and connected channels.</p>
      {loading ? <p className="mt-2 text-xs text-muted-foreground">Loading available models…</p> : null}
      {home?.modelCatalog?.error ? <p className="mt-2 text-xs text-status-attention">Showing fallback models while the live catalog is unavailable.</p> : null}
      {error ? <p className="mt-2 text-xs text-destructive" role="alert">{error}</p> : null}
    </div>
    <div className="rounded-xl border border-border bg-secondary/20 p-4">
      <h3 className="text-sm font-semibold text-foreground">API key</h3>
      <div className="mt-3 max-w-xl">
        <span className="text-xs font-medium text-foreground">Key source</span>
        <div className="mt-1 inline-flex max-w-full flex-wrap rounded-lg border border-border bg-background p-1">
          <Button type="button" size="sm" variant={credentialMode === "platform" ? "default" : "ghost"} onClick={() => { setCredentialMode("platform"); setCredentialSaved(false); setCredentialError(null); setApiKeyDialogOpen(false); void selectProviderCredential(""); }}>Platform key</Button>
          <Button type="button" size="sm" variant={credentialMode === "user" ? "default" : "ghost"} onClick={() => { setCredentialMode("user"); setCredentialSaved(false); setCredentialError(null); setApiKeyDialogOpen(false); }}>Use my own API key</Button>
        </div>
      </div>
      {credentialMode === "user" ? <div className="mt-3 space-y-3">
        <div>
          <span className="text-xs font-medium text-foreground">Provider</span>
          <div className="mt-1"><ProviderTabs value={credentialProvider} configuredProviders={providerCredentials.filter((credential) => credential.status === "active").map((credential) => credential.provider)} onChange={(provider) => { setCredentialProvider(provider); setCredentialReference(""); setCredentialSaved(false); setCredentialError(null); setApiKeyDialogOpen(true); }} /></div>
        </div>
        {activeProviderCredentials.length ? <label className="block text-xs font-medium text-foreground">Saved {providerLabel(credentialProvider)} key
          <Select value={credentialReference || "new"} onValueChange={(value) => void selectProviderCredential(value)}>
            <SelectTrigger className="mt-1"><SelectValue placeholder="Choose a saved key" /></SelectTrigger>
            <SelectContent><SelectItem value="new">Enter a new API key</SelectItem>{activeProviderCredentials.map((credential) => <SelectItem key={credential.id} value={credential.id}>{credential.label}</SelectItem>)}</SelectContent>
          </Select>
        </label> : null}
      </div> : <p className="mt-2 text-xs text-muted-foreground">Uses the configured KasiTek provider key.</p>}
      {credentialSaved ? <p className="text-xs text-status-success" role="status">API key saved.</p> : null}
      {credentialError ? <p className="text-xs text-destructive" role="alert">{credentialError}</p> : null}
    </div>
    </CardContent></Card>
    {apiKeyDialogOpen && credentialProvider ? <ApiKeyConfigurationDialog open={apiKeyDialogOpen} onOpenChange={setApiKeyDialogOpen} provider={credentialProvider} credentialKey={credentialKey} onCredentialKeyChange={setCredentialKey} credentialSaving={credentialSaving || saving} credentialError={credentialError} credentialSaved={credentialSaved} onSave={() => void saveProviderCredential()} /> : null}
  </>;
}

function availabilityLabel(availability: string) {
  switch (availability) {
    case "available":
      return "Granted";
    case "not_granted":
      return "Not granted";
    case "not_configured":
      return "Needs setup";
    case "unhealthy":
      return "Unavailable";
    default:
      return availability.replaceAll("_", " ");
  }
}

function TelegramPairingActions({ username, token }: { username?: string; token: string }) {
  const [copied, setCopied] = useState(false);
  const command = `/start ${token}`;

  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-2">
      {username ? (
        <Button asChild className="w-full">
          <a href={`https://t.me/${encodeURIComponent(username)}?start=${encodeURIComponent(token)}`} target="_blank" rel="noreferrer">Open Telegram</a>
        </Button>
      ) : null}
      {username ? (
        <div className="flex items-center gap-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground" aria-label="or">
          <span className="h-px flex-1 bg-border" />
          <span>OR</span>
          <span className="h-px flex-1 bg-border" />
        </div>
      ) : null}
      <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
        <code className="block min-w-0 max-w-full overflow-x-auto whitespace-nowrap rounded-lg bg-secondary px-3 py-2 text-xs text-foreground">{command}</code>
        <Button type="button" variant="outline" size="sm" className="shrink-0 px-3 text-xs" onClick={() => void copyCommand()}>
          {copied ? "Copied" : "Copy command"}
        </Button>
      </div>
    </div>
  );
}

function capabilityReason(capability: AgentCapability): string {
  return capability.reasonCode || capability.availability;
}

function availabilityClass(availability: string) {
  if (availability === "available") return "border-status-success/30 bg-status-success-soft text-status-success";
  if (availability === "not_granted") return "border-status-attention/30 bg-status-attention-soft text-status-attention";
  return "border-destructive/30 bg-status-danger-soft text-destructive";
}

function slugifyAgentName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
}

function sanitizeAgentSlug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80);
}

type DetailSection = "overview" | "analytics" | "activity" | "conversations" | "operations" | "knowledge" | "behavior" | "models" | "tools" | "integrations" | "appearance" | "deployment" | "connection" | "settings" | "advanced";

type DetailNavigationItem = {
  section: DetailSection;
  label: string;
  description: string;
  icon: typeof LayoutDashboard;
};

type DetailNavigationGroup = {
  label?: string;
  items: DetailNavigationItem[];
};

function isDetailSection(value: string | null): value is DetailSection {
  return value === "overview" || value === "analytics" || value === "activity" || value === "conversations" || value === "operations" || value === "knowledge" || value === "behavior" || value === "models" || value === "tools" || value === "integrations" || value === "appearance" || value === "deployment" || value === "connection" || value === "settings" || value === "advanced";
}

export function AgentDetailPageClient({ agent, initialVersions }: { agent: AgentDefinition; initialVersions: AgentVersion[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [versions, setVersions] = useState(initialVersions);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agentName, setAgentName] = useState(agent.name);
  const [agentDescription, setAgentDescription] = useState(agent.description ?? "");
  const [agentSlug, setAgentSlug] = useState(agent.slug);
  const [slugEdited, setSlugEdited] = useState(false);
  const [savingIdentity, setSavingIdentity] = useState(false);
  const [installationStatus, setInstallationStatus] = useState(agent.installation_status ?? "disabled");
  const [tone, setTone] = useState(String(agent.installation_settings?.tone ?? "balanced"));
  const [responseDetail, setResponseDetail] = useState(String(agent.installation_settings?.responseDetail ?? "standard"));
  const [language, setLanguage] = useState(String(agent.installation_settings?.language ?? "en"));
  const [notificationsEnabled, setNotificationsEnabled] = useState(agent.installation_settings?.notificationsEnabled !== false);
  const [savingSettings, setSavingSettings] = useState(false);
  const baseVersion = initialVersions.find((version) => version.status === "published") ?? initialVersions[0];
  const baseConfiguration = baseVersion?.configuration ?? {};
  const basePolicy = baseVersion?.policy?.modelPolicy && typeof baseVersion.policy.modelPolicy === "object" ? baseVersion.policy.modelPolicy as Record<string, unknown> : {};
  const basePrimary = basePolicy.primary && typeof basePolicy.primary === "object" ? basePolicy.primary as Record<string, unknown> : {};
  const initialCredentialReference = String(baseConfiguration.credentialReference ?? basePolicy.credentialReference ?? "");
  const [instructions, setInstructions] = useState(baseVersion?.instructions ?? "");
  const [modelProvider, setModelProvider] = useState<AgentModelProvider>(String(basePrimary.provider ?? baseConfiguration.provider ?? "openrouter") as AgentModelProvider);
  const [model, setModel] = useState(String(basePrimary.model ?? baseConfiguration.model ?? "openai/gpt-oss-20b"));
  const [credentialMode, setCredentialMode] = useState<"platform" | "user">(initialCredentialReference ? "user" : "platform");
  const [credentialProvider, setCredentialProvider] = useState<AgentModelProvider | null>(null);
  const [credentialReference, setCredentialReference] = useState(initialCredentialReference);
  const [providerCredentials, setProviderCredentials] = useState<AgentProviderCredential[]>([]);
  const [credentialsLoading, setCredentialsLoading] = useState(false);
  const [credentialKey, setCredentialKey] = useState("");
  const [credentialSaving, setCredentialSaving] = useState(false);
  const [credentialError, setCredentialError] = useState<string | null>(null);
  const [credentialSaved, setCredentialSaved] = useState(false);
  const [apiKeyDialogOpen, setApiKeyDialogOpen] = useState(false);
  const [modelCatalog, setModelCatalog] = useState<AgentModelCatalog | null>(null);
  const [modelCatalogLoading, setModelCatalogLoading] = useState(false);
  const [modelCatalogLoadError, setModelCatalogLoadError] = useState<string | null>(null);
  const [runtimeLimits, setRuntimeLimits] = useState<AgentRuntimeLimitsValue>({
    ...defaultAgentRuntimeLimits,
    maxIterations: String(baseConfiguration.maxIterations ?? defaultAgentRuntimeLimits.maxIterations),
    maxToolCalls: String(baseConfiguration.maxToolCalls ?? defaultAgentRuntimeLimits.maxToolCalls),
    maxModelCalls: String(baseConfiguration.maxModelCalls ?? defaultAgentRuntimeLimits.maxModelCalls),
    maxTotalTokens: String(basePolicy.maxTokensPerRun ?? baseConfiguration.maxTotalTokens ?? defaultAgentRuntimeLimits.maxTotalTokens),
    maxContextMessages: String(baseConfiguration.maxContextMessages ?? defaultAgentRuntimeLimits.maxContextMessages),
    maxContextTokens: String(baseConfiguration.maxContextTokens ?? defaultAgentRuntimeLimits.maxContextTokens),
    maxWallTimeMs: String(baseConfiguration.maxWallTimeMs ?? defaultAgentRuntimeLimits.maxWallTimeMs),
  });
  const [creatingVersion, setCreatingVersion] = useState(false);
  const [workflow, setWorkflow] = useState<WorkflowGraphValue | null>(null);
  const [workflowValid, setWorkflowValid] = useState(true);
  const [workflowReady, setWorkflowReady] = useState(false);
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false);
  const [deleteConfirmationValue, setDeleteConfirmationValue] = useState("");
  const [websiteChatConfigured, setWebsiteChatConfigured] = useState(false);
  const protectedAgent = agent.protected;
  const executionMode = agent.execution_mode ?? (protectedAgent ? "system_hosted" : "kasitek_hosted");
  const externalAgent = executionMode === "external_connected";
  const hostedAgent = executionMode === "system_hosted" || executionMode === "kasitek_hosted";
  const kasitekHostedAgent = executionMode === "kasitek_hosted";
  const customHostedAgent = kasitekHostedAgent && agent.creation_profile === "custom";
  const customerServiceAgent = agent.agent_audience === "customer_service";
  // KasiAi is a system-hosted personal agent with private pairing controls.
  // Custom personal agents stay in the private/test surface and never expose
  // customer channels, website chat, or the live customer queue.
  const privateSystemAgent = executionMode === "system_hosted";
  const customerConversationSurface = kasitekHostedAgent && customerServiceAgent;
  const channelSurface = hostedAgent && (customerServiceAgent || privateSystemAgent);
  const deletableAgent = !protectedAgent && agent.owner_type === "organization";
  const requestedSection = searchParams.get("section");
  const requestedDetailSection: DetailSection = isDetailSection(requestedSection) ? requestedSection : "overview";
  // Keep old deep links working while presenting one Settings destination.
  const normalizedSection: DetailSection = requestedDetailSection === "advanced" ? "settings" : requestedDetailSection;
  const activeSection: DetailSection = (
    (normalizedSection === "conversations" && !customerConversationSurface)
    || (normalizedSection === "tools" && !hostedAgent)
    || (["integrations", "deployment", "appearance"].includes(normalizedSection) && !channelSurface)
  ) ? "activity" : normalizedSection;

  useEffect(() => {
    if (!kasitekHostedAgent || activeSection !== "models") return;
    let cancelled = false;
    setModelCatalogLoading(true);
    setModelCatalogLoadError(null);
    void getAgentModelCatalog()
      .then((catalog) => {
        if (!cancelled) setModelCatalog(catalog);
      })
      .catch((cause) => {
        if (!cancelled) {
          setModelCatalog(null);
          setModelCatalogLoadError(cause instanceof Error ? cause.message : "Unable to load available models");
        }
      })
      .finally(() => {
        if (!cancelled) setModelCatalogLoading(false);
      });
    return () => { cancelled = true; };
  }, [activeSection, kasitekHostedAgent]);

  useEffect(() => {
    if (!kasitekHostedAgent || activeSection !== "models") return;
    let cancelled = false;
    setCredentialsLoading(true);
    void listAgentProviderCredentials()
      .then((response) => {
        if (!cancelled) setProviderCredentials(response.credentials);
      })
      .catch((cause) => {
        if (!cancelled) setCredentialError(cause instanceof Error ? cause.message : "Unable to load saved API keys");
      })
      .finally(() => {
        if (!cancelled) setCredentialsLoading(false);
      });
    return () => { cancelled = true; };
  }, [activeSection, kasitekHostedAgent]);

  const providerOptions = MODEL_PROVIDERS;

  const providerModels = useMemo(() => modelCatalog?.models.filter((entry) => entry.provider === modelProvider) ?? [], [modelCatalog, modelProvider]);
  const activeProviderCredentials = useMemo(
    () => providerCredentials.filter((credential) => credential.provider === credentialProvider && credential.status === "active"),
    [credentialProvider, providerCredentials],
  );
  const selectedModelAvailable = providerModels.some((entry) => entry.model === model);
  const pickerModels = useMemo<AgentModel[]>(() => {
    if (!model || selectedModelAvailable) return providerModels;
    return [{ provider: modelProvider, model, label: model, description: "Saved model is not in the current catalog.", tier: "balanced" }, ...providerModels];
  }, [model, modelProvider, providerModels, selectedModelAvailable]);

  const changeModelProvider = (provider: AgentModelProvider) => {
    setModelProvider(provider);
    setCredentialProvider(provider);
    setCredentialReference("");
    setCredentialSaved(false);
    setCredentialError(null);
    const firstModel = modelCatalog?.models.find((entry) => entry.provider === provider);
    if (firstModel) setModel(firstModel.model);
    else if (modelCatalog) setModel("");
  };

  const saveProviderCredential = async () => {
    const apiKey = credentialKey.trim();
    if (!credentialProvider || !apiKey || credentialSaving) return;
    setCredentialSaving(true);
    setCredentialError(null);
    setCredentialSaved(false);
    try {
      await verifyAgentProviderCredential({ provider: credentialProvider, apiKey });
      const created = await createAgentProviderCredential({ provider: credentialProvider, apiKey });
      const metadata: AgentProviderCredential = {
        ...created,
        funding_source: "user",
        status: "active",
        created_at: new Date().toISOString(),
      };
      setProviderCredentials((current) => [metadata, ...current.filter((credential) => credential.id !== created.id)]);
      setCredentialReference(credentialProvider === modelProvider ? created.id : "");
      setCredentialKey("");
      setCredentialSaved(true);
      setApiKeyDialogOpen(false);
    } catch (cause) {
      setCredentialError(cause instanceof Error ? cause.message : "Unable to save this API key");
    } finally {
      setCredentialSaving(false);
    }
  };

  useEffect(() => {
    if (!customerServiceAgent || !hostedAgent || protectedAgent || !agent.installation_id) {
      setWebsiteChatConfigured(false);
      return;
    }
    let cancelled = false;
    void listAgentWebsiteDeployments(agent.installation_id)
      .then((result) => {
        if (!cancelled) setWebsiteChatConfigured(result.deployments.some((deployment) => deployment.status !== "REVOKED"));
      })
      .catch(() => {
        if (!cancelled) setWebsiteChatConfigured(false);
      });
    return () => { cancelled = true; };
  }, [agent.installation_id, customerServiceAgent, hostedAgent, protectedAgent]);

  const navigationGroups = useMemo<DetailNavigationGroup[]>(() => {
    const activityItems: DetailNavigationItem[] = [{ section: "activity", label: "Test chat", description: "Chat with this agent privately", icon: MessageSquare }];
    if (customerConversationSurface) {
      activityItems.push({ section: "conversations", label: "Chat history", description: "Customer conversations with this agent", icon: MessageSquare });
    }
    if (kasitekHostedAgent) {
      activityItems.push({ section: "operations", label: "Operations", description: "Runs and delivery activity", icon: History });
    }
    const groups: DetailNavigationGroup[] = [
      {
        items: [
          { section: "overview", label: "Overview", description: "Status and setup", icon: LayoutDashboard },
        ],
      },
      {
        label: "Activity",
        items: hostedAgent
          ? activityItems
          : [{ section: externalAgent ? "operations" : "activity", label: externalAgent ? "Operations" : "Private chat", description: externalAgent ? "External calls, usage, and outcomes" : "Your private agent test chat", icon: externalAgent ? History : MessageSquare }],
      },
      {
        label: "Insights",
        items: [{ section: "analytics", label: "Analytics", description: "Runs, usage, outcomes, and health", icon: BarChart3 }],
      },
    ];
    if (hostedAgent) {
      groups.push(
        { label: "Training data", items: [{ section: "knowledge", label: "Knowledge", description: "Files, text, and Q&A", icon: BookOpen }] },
        ...(kasitekHostedAgent ? [{ label: "Behaviour", items: [{ section: "behavior" as const, label: "Tune agent", description: "Instructions, runtime, and workflow", icon: SlidersHorizontal }] }] : []),
        { label: "Models", items: [{ section: "models", label: "Models", description: "Model and API key", icon: Cpu }] },
        { label: "Tools", items: [{ section: "tools", label: "Tools", description: "Capabilities and access", icon: Wrench }] },
        ...(channelSurface ? [{
          label: "Deployment",
          items: [
            { section: "integrations" as const, label: "Integrations", description: "Connect channels and surfaces", icon: PlugZap },
            ...(websiteChatConfigured ? [{ section: "appearance" as const, label: "Appearance", description: "Customize Website Chat", icon: Sparkles }] : []),
            { section: "deployment" as const, label: "Channels & status", description: "Health, routing, and delivery", icon: Rocket },
          ],
        }] : []),
      );
    } else {
      groups.push({ label: "Connection", items: [{ section: "connection", label: "Credentials", description: "Connect and monitor runtime", icon: KeyRound }] });
    }
    if (!protectedAgent) {
      groups.push({
        label: "Settings",
        items: [
          { section: "settings", label: "Settings", description: hostedAgent ? "Identity, preferences, access, and versions" : "Identity, credentials, and access", icon: Settings2 },
        ],
      });
    } else {
      groups.push({ label: "Settings", items: [{ section: "settings", label: "Settings", description: "Access and platform settings", icon: Settings2 }] });
    }
    return groups;
  }, [channelSurface, customerConversationSurface, externalAgent, hostedAgent, kasitekHostedAgent, protectedAgent, websiteChatConfigured]);

  const selectSection = (section: DetailSection) => {
    if (section === "appearance") {
      router.push(`/agents/${encodeURIComponent(agent.id)}/appearance`);
      return;
    }
    const query = new URLSearchParams(searchParams.toString());
    if (section === "overview") query.delete("section");
    else query.set("section", section);
    const suffix = query.toString();
    router.push(`${window.location.pathname}${suffix ? `?${suffix}` : ""}`);
  };

  const handleWorkflowChange = useCallback((next: WorkflowGraphValue | null) => {
    setWorkflow(next);
    setWorkflowReady(true);
  }, []);

  const handleWorkflowValidity = useCallback((valid: boolean) => {
    setWorkflowValid(valid);
    setWorkflowReady(true);
  }, []);

  const runWorkflowTest = useCallback(async (message: string) => {
    if (!agent.installation_id || !hostedAgent) throw new Error("This installation does not support hosted chat.");
    if (installationStatus !== "active") throw new Error("Resume the installation before testing it.");
    return sendPlatformMessage(agent.installation_id, {
      message,
      idempotencyKey: crypto.randomUUID(),
      createNew: true,
      context: { route: window.location.pathname, pageTitle: `${agentName} workflow test` },
    });
  }, [agent.installation_id, agentName, hostedAgent, installationStatus]);

  const mutate = async (action: string, operation: () => Promise<unknown>) => {
    setBusy(action);
    setError(null);
    try {
      await operation();
      router.refresh();
      setVersions((current) => current.map((version) => {
        if (action === `publish:${version.id}` || action === `rollback:${version.id}`) return { ...version, status: "published", published_at: new Date().toISOString() };
        if (action === `retire:${version.id}`) return { ...version, status: "retired", retired_at: new Date().toISOString() };
        return action === "archive" ? current[0] ?? version : version;
      }));
      if (action === "archive" || action === "delete") router.push("/agents");
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Agent operation failed");
      return false;
    } finally {
      setBusy(null);
    }
  };

  const deleteCurrentAgent = () => {
    if (busy || !deletableAgent) return;
    setError(null);
    setDeleteConfirmationValue("");
    setDeleteConfirmationOpen(true);
  };

  const confirmDeleteCurrentAgent = async () => {
    if (busy || !deleteConfirmationOpen || deleteConfirmationValue !== agentName) return;
    const deleted = await mutate("delete", () => deleteAgent(agent.id));
    if (deleted) {
      setDeleteConfirmationOpen(false);
      setDeleteConfirmationValue("");
    }
  };

  const saveSettings = async () => {
    if (!agent.installation_id) return;
    setSavingSettings(true);
    setError(null);
    try {
      await updateAgentInstallationSettings(agent.installation_id, { language: language.trim() || "en", tone: tone as "concise" | "balanced" | "detailed", responseDetail: responseDetail as "concise" | "standard" | "detailed", notificationsEnabled });
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save agent settings");
    } finally {
      setSavingSettings(false);
    }
  };

  const saveIdentity = async () => {
    const name = agentName.trim();
    const slug = sanitizeAgentSlug(agentSlug.trim() || slugifyAgentName(name));
    if (!name || !slug || savingIdentity || protectedAgent) return;
    setSavingIdentity(true);
    setError(null);
    try {
      const updated = await updateAgent(agent.id, { name, slug, description: agentDescription.trim() || null });
      setAgentName(updated.name);
      setAgentSlug(updated.slug);
      setAgentDescription(updated.description ?? "");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save agent details");
    } finally {
      setSavingIdentity(false);
    }
  };

  const toggleInstallation = async () => {
    if (!agent.installation_id || busy || installationStatus === "disabled") return;
    const nextStatus = installationStatus === "active" ? "paused" : "active";
    setBusy("installation-status");
    setError(null);
    try {
      await setAgentInstallationStatus(agent.installation_id, nextStatus);
      setInstallationStatus(nextStatus);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to update installation status");
    } finally {
      setBusy(null);
    }
  };

  const createVersion = async () => {
    if (!instructions.trim() || creatingVersion || protectedAgent) return;
    if (credentialMode === "user" && !credentialReference) {
      setError("Select a saved API key or save a new one before creating the version.");
      return;
    }
    if (credentialMode === "user" && credentialProvider !== modelProvider) {
      setError(`The saved ${providerLabel(credentialProvider)} key must match the ${providerLabel(modelProvider)} model provider.`);
      return;
    }
    setCreatingVersion(true);
    setError(null);
    try {
      const parsedLimits = parseAgentRuntimeLimits(runtimeLimits);
      const created = await createAgentVersion(agent.id, {
        instructions: instructions.trim(),
        configuration: { provider: modelProvider, model: model.trim(), ...parsedLimits, ...(credentialMode === "user" && credentialReference ? { credentialReference } : {}), ...(workflow ? { workflow } : {}) },
        policy: { modelPolicy: { version: "hosted-agent-v1", primary: { provider: modelProvider, model: model.trim() }, ...(credentialMode === "user" && credentialReference ? { credentialReference } : {}), fallback: [], allowUserFundedFallbackToKasiTek: false, maxTokensPerRun: parsedLimits.maxTotalTokens }, runLimits: parsedLimits },
      });
      setVersions((current) => [created, ...current]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create agent version");
    } finally {
      setCreatingVersion(false);
    }
  };

  return (
    <div className="min-h-[100dvh] p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-[1240px]">
        <Link href="/agents" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" />Back to agents</Link>
        <Card className="mt-5 border-border/80 shadow-sm">
          <CardContent className="space-y-4 p-4 sm:p-5">
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
              <div className="flex items-start gap-3">
                <div className="grid h-11 w-11 place-items-center rounded-full bg-primary/10 text-primary">{protectedAgent ? <Sparkles className="h-5 w-5" /> : <History className="h-5 w-5" />}</div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Agent details</p>
                  <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">{agentName}</h1>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">{agentDescription || "Installed Agent Platform agent"}</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">{customHostedAgent ? <Button asChild><Link href={`/agents/${encodeURIComponent(agent.id)}/workflow`}><Workflow className="mr-2 h-4 w-4" />Edit workflow</Link></Button> : null}{agent.installation_id && installationStatus !== "disabled" ? <Button type="button" variant="outline" disabled={busy !== null} onClick={() => void toggleInstallation()}>{busy === "installation-status" ? "Updating…" : installationStatus === "active" ? "Pause installation" : "Resume installation"}</Button> : null}{protectedAgent ? <Badge className="w-fit border-primary/20 bg-primary/10 text-primary">Protected system agent</Badge> : deletableAgent ? <Button type="button" variant="outline" disabled={busy === "archive" || busy === "delete"} onClick={() => void mutate("archive", () => externalAgent && agent.installation_id ? archiveExternalAgent(agent.installation_id) : archiveAgent(agent.id))}><Archive className="mr-2 h-4 w-4" />{busy === "archive" ? "Archiving…" : "Archive agent"}</Button> : null}</div>
            </div>
            {externalAgent ? <p className="rounded-lg border border-status-info/20 bg-status-info-soft/40 px-3 py-2 text-sm text-muted-foreground">This is an external-connected installation. It calls KasiTek through MCP or REST and does not run hosted chat, channels, schedules, knowledge, or model workflows here.</p> : null}
          </CardContent>
        </Card>

        {error ? <p className="mt-4 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive" role="alert">{error}</p> : null}
        <div className="mt-6 grid items-start gap-6 lg:grid-cols-[230px_minmax(0,1fr)]">
          <aside className="lg:sticky lg:top-6">
            <Card className="overflow-hidden border-border/80 shadow-sm"><CardContent className="p-3 sm:p-4">
              <div className="mb-3 px-2"><p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Manage agent</p><p className="mt-1 truncate text-sm font-medium text-foreground">{agentName}</p></div>
              <nav aria-label="Agent management" className="flex gap-1 overflow-x-auto lg:block">
                {navigationGroups.map((group, groupIndex) => <div key={group.label ?? `group-${groupIndex}`} className="lg:mt-4 first:mt-0">{group.label ? <p className="mb-1 px-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{group.label}</p> : null}{group.items.map((item) => { const Icon = item.icon; const active = activeSection === item.section; return <button key={item.section} type="button" aria-current={active ? "page" : undefined} title={item.description} onClick={() => selectSection(item.section)} className={`flex min-w-max items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition-colors lg:min-w-0 lg:w-full ${active ? "bg-primary/10 font-semibold text-primary" : "text-foreground/80 hover:bg-secondary hover:text-foreground"}`}><Icon className="h-4 w-4 shrink-0" /><span>{item.label}</span></button>; })}{group.label === "Settings" && deletableAgent ? <><div className="my-2 border-t border-border/70" /><button type="button" title="Permanently delete this agent" onClick={() => void deleteCurrentAgent()} disabled={busy !== null} className="flex min-w-max items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50 lg:min-w-0 lg:w-full"><Trash2 className="h-4 w-4 shrink-0" /><span>{busy === "delete" ? "Deleting…" : "Delete agent"}</span></button></> : null}</div>)}
              </nav>
              <div className="mt-4 hidden rounded-xl border border-border bg-secondary/30 p-3 lg:block"><p className="text-xs text-muted-foreground">{protectedAgent ? "Protected platform agent" : externalAgent ? "External runtime" : "Hosted runtime"}</p><p className="mt-1 text-xs font-medium capitalize text-foreground">{installationStatus.replaceAll("_", " ")}</p></div>
            </CardContent></Card>
          </aside>
          <main className="min-w-0 space-y-6">
        {activeSection === "overview" ? <Card><CardContent className="space-y-5 p-6"><div><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-primary">Overview</p><h2 className="mt-1 text-xl font-semibold text-foreground">Manage {agentName}</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">Use the sections on the left to update knowledge, behaviour, deployment, access, and activity without searching through one long page.</p></div><div className="grid gap-3 sm:grid-cols-3"><button type="button" onClick={() => selectSection(hostedAgent ? "knowledge" : "connection")} className="rounded-xl border border-border bg-secondary/20 p-4 text-left transition-colors hover:border-primary/40 hover:bg-primary/5"><BookOpen className="h-5 w-5 text-primary" /><p className="mt-3 text-sm font-semibold text-foreground">{hostedAgent ? "Add knowledge" : "Connect runtime"}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{hostedAgent ? "Upload files or paste information." : "Manage credentials and connection health."}</p></button><button type="button" onClick={() => selectSection(hostedAgent ? "behavior" : "settings")} className="rounded-xl border border-border bg-secondary/20 p-4 text-left transition-colors hover:border-primary/40 hover:bg-primary/5"><SlidersHorizontal className="h-5 w-5 text-primary" /><p className="mt-3 text-sm font-semibold text-foreground">{hostedAgent ? "Tune behaviour" : "Review access"}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{hostedAgent ? "Adjust response settings and capabilities." : "Review scopes and audit information."}</p></button><button type="button" onClick={() => selectSection(hostedAgent ? "activity" : externalAgent ? "operations" : "activity")} className="rounded-xl border border-border bg-secondary/20 p-4 text-left transition-colors hover:border-primary/40 hover:bg-primary/5"><MessageSquare className="h-5 w-5 text-primary" /><p className="mt-3 text-sm font-semibold text-foreground">{hostedAgent ? "Test chat" : externalAgent ? "View operations" : "Private chat"}</p><p className="mt-1 text-xs leading-5 text-muted-foreground">{hostedAgent ? "Try a conversation with this agent." : externalAgent ? "Review calls, outcomes, and usage." : "Test this private platform agent."}</p></button></div></CardContent></Card> : null}

        {activeSection === "settings" && !protectedAgent ? <Card><CardContent className="space-y-4 p-6"><div><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-primary">Settings</p><h2 className="mt-1 text-xl font-semibold text-foreground">Agent identity</h2><p className="mt-2 text-sm text-muted-foreground">Change the name, description, or public slug for this agent.</p></div><div className="grid gap-4 sm:grid-cols-2"><label className="text-sm font-medium text-foreground">Name<Input value={agentName} onChange={(event) => { const next = event.target.value; setAgentName(next); if (!slugEdited) setAgentSlug(slugifyAgentName(next)); }} maxLength={160} className="mt-2" /></label><label className="text-sm font-medium text-foreground">Slug<Input value={agentSlug} onChange={(event) => { setSlugEdited(true); setAgentSlug(sanitizeAgentSlug(event.target.value)); }} maxLength={80} className="mt-2" /><span className="mt-1 block text-xs text-muted-foreground">Updates automatically from the name until you edit it.</span></label></div><label className="text-sm font-medium text-foreground">Description<Textarea value={agentDescription} onChange={(event) => setAgentDescription(event.target.value)} rows={4} maxLength={2000} className="mt-2 resize-y" /></label><div className="flex items-center justify-between gap-3"><button type="button" className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline" onClick={() => { setSlugEdited(false); setAgentSlug(slugifyAgentName(agentName)); }}>Reset slug from name</button><Button type="button" onClick={() => void saveIdentity()} disabled={savingIdentity || !agentName.trim() || !agentSlug.trim()}>{savingIdentity ? "Saving…" : "Save details"}</Button></div></CardContent></Card> : null}

        {activeSection === "settings" && hostedAgent ? <Card>
          <CardContent className="space-y-4 p-6">
            <div><h2 className="text-lg font-semibold text-foreground">Workspace preferences</h2><p className="mt-1 text-sm text-muted-foreground">These settings affect this workspace installation only. Protected instructions and tool policy remain unchanged.</p></div>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-sm font-medium text-foreground">Response tone<Select value={tone} onValueChange={setTone}><SelectTrigger className="mt-2"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="concise">Concise</SelectItem><SelectItem value="balanced">Balanced</SelectItem><SelectItem value="detailed">Detailed</SelectItem></SelectContent></Select></label>
              <label className="text-sm font-medium text-foreground">Response detail<Select value={responseDetail} onValueChange={setResponseDetail}><SelectTrigger className="mt-2"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="concise">Concise</SelectItem><SelectItem value="standard">Standard</SelectItem><SelectItem value="detailed">Detailed</SelectItem></SelectContent></Select></label>
              <label className="text-sm font-medium text-foreground">Language<Input value={language} onChange={(event) => setLanguage(event.target.value)} maxLength={20} placeholder="en" className="mt-2" /></label>
            </div>
            <label className="flex items-center gap-2 text-sm text-muted-foreground"><Checkbox checked={notificationsEnabled} onCheckedChange={(checked) => setNotificationsEnabled(checked === true)} />Send run and approval notifications for this installation</label><Button type="button" onClick={() => void saveSettings()} disabled={!agent.installation_id || savingSettings}>{savingSettings ? "Saving…" : "Save preferences"}</Button>
          </CardContent>
        </Card> : null}

        {activeSection === "operations" && externalAgent && agent.installation_id ? <ExternalAgentHealth installationId={agent.installation_id} /> : null}

        {activeSection === "connection" && externalAgent && agent.installation_id ? <InstallationCredentials installationId={agent.installation_id} /> : null}

        {activeSection === "knowledge" && hostedAgent && agent.installation_id ? <InstallationKnowledge agentId={agent.id} installationId={agent.installation_id} /> : null}

        {activeSection === "tools" && hostedAgent && agent.installation_id ? <section className="space-y-3" aria-labelledby="agent-tools-title">
          <div><h2 id="agent-tools-title" className="text-lg font-semibold text-foreground">Tools</h2><p className="text-sm text-muted-foreground">{protectedAgent ? "Platform-approved capabilities." : "Capabilities, resource grants, and connectors."}</p></div>
          <InstallationCapabilities installationId={agent.installation_id} protectedAgent={protectedAgent} />
          {!protectedAgent ? <InstallationAccessScope installationId={agent.installation_id} /> : null}
        </section> : null}

        {activeSection === "settings" && agent.installation_id ? <section className="space-y-3" aria-labelledby="additional-settings-title">
          <div><h2 id="additional-settings-title" className="text-lg font-semibold text-foreground">Additional settings</h2><p className="text-sm text-muted-foreground">Access, schedules, and activation controls.</p></div>
          {kasitekHostedAgent ? <details className="group rounded-xl border border-border bg-card">
            <summary className="cursor-pointer list-none p-5 [&::-webkit-details-marker]:hidden"><div className="flex items-center justify-between gap-3"><div><h3 className="font-semibold text-foreground">Schedules</h3><p className="mt-1 text-sm text-muted-foreground">Run this agent on a recurring schedule.</p></div><span className="text-xs font-medium text-primary group-open:hidden">Open</span><span className="hidden text-xs font-medium text-primary group-open:inline">Close</span></div></summary>
            <div className="border-t border-border p-5"><InstallationSchedules installationId={agent.installation_id} /></div>
          </details> : null}
        </section> : null}

        {activeSection === "operations" && kasitekHostedAgent && agent.installation_id ? <InstallationRuns installationId={agent.installation_id} /> : null}

        {activeSection === "operations" && externalAgent && agent.installation_id ? <ExternalAgentOperations installationId={agent.installation_id} /> : null}

        {activeSection === "analytics" && agent.installation_id ? <AgentAnalyticsPanel agentName={agentName} installationId={agent.installation_id} handoffEnabled={customerConversationSurface} /> : null}

        {activeSection === "conversations" && customerConversationSurface && agent.installation_id ? <AgentConversationHistory agentId={agent.id} installationId={agent.installation_id} /> : null}

        {activeSection === "integrations" && agent.installation_id ? channelSurface ? <InstallationIntegrations agentId={agent.id} installationId={agent.installation_id} personal={executionMode === "system_hosted"} agentName={agent.name} onWebsiteDeploymentStateChange={setWebsiteChatConfigured} /> : <AgentToolIntegrations installationId={agent.installation_id} /> : null}

        {activeSection === "deployment" && channelSurface && agent.installation_id ? <InstallationChannels installationId={agent.installation_id} personal={executionMode === "system_hosted"} /> : null}

        {activeSection === "deployment" && channelSurface && agent.installation_id ? <InstallationReadiness installationId={agent.installation_id} /> : null}

        {activeSection === "activity" && agent.installation_id && hostedAgent ? <AgentChatPanel installationId={agent.installation_id} active={installationStatus === "active"} initialModelProvider={modelProvider} initialModel={model} /> : null}

        {activeSection === "behavior" && kasitekHostedAgent ? <AgentWorkflowEditor configuration={baseConfiguration} onChange={handleWorkflowChange} onValidityChange={handleWorkflowValidity} onTestRun={agent.installation_id && installationStatus === "active" ? runWorkflowTest : undefined} /> : null}

        {activeSection === "models" && executionMode === "system_hosted" && agent.installation_id ? <KasiAiModels installationId={agent.installation_id} /> : null}

        {activeSection === "models" && kasitekHostedAgent ? (
          <>
          <Card>
            <CardContent className="space-y-4 p-6">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Models</h2>
                <p className="mt-1 text-sm text-muted-foreground">Choose the model and API key for this agent.</p>
              </div>
              <div className="rounded-xl border border-border bg-secondary/20 p-4">
                <h3 className="text-sm font-semibold text-foreground">Model policy</h3>
                <div className="mt-3 grid gap-3 sm:grid-cols-[0.65fr_1.35fr]">
                  <label className="text-xs font-medium text-foreground">Provider
                    <Select value={modelProvider} onValueChange={(value) => changeModelProvider(value as AgentModelProvider)}>
                      <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
                      <SelectContent>{providerOptions.map((provider) => <SelectItem key={provider} value={provider}><span className="flex items-center gap-2"><ProviderLogo provider={provider} compact />{providerLabel(provider)}</span></SelectItem>)}</SelectContent>
                    </Select>
                  </label>
                  <div className="min-w-0 text-xs font-medium text-foreground">
                    <span>Model</span>
                    {modelCatalog && providerModels.length ? <div className="mt-1"><AgentModelPicker model={pickerModels.find((entry) => entry.provider === modelProvider && entry.model === model)} models={pickerModels} disabled={modelCatalogLoading} onSelect={(value) => setModel(value)} /></div> : <Input value={model} onChange={(event) => setModel(event.target.value)} className="mt-1" disabled={modelCatalogLoading} />}
                    {modelCatalogLoading ? <p className="mt-1 text-[11px] font-normal text-muted-foreground">Loading available models…</p> : null}
                    {modelCatalogLoadError ? <p className="mt-1 text-[11px] font-normal text-status-attention">Model list unavailable. Enter a model ID manually.</p> : null}
                    {modelCatalog?.error ? <p className="mt-1 text-[11px] font-normal text-status-attention">Showing fallback models while the live catalog is unavailable.</p> : null}
                    {modelCatalog && providerModels.length && model.trim() && !selectedModelAvailable ? <p className="mt-1 text-[11px] font-normal text-destructive">The saved model is unavailable. Choose another model before saving.</p> : null}
                  </div>
                </div>
              </div>
              <div className="rounded-xl border border-border bg-secondary/20 p-4">
                <h3 className="text-sm font-semibold text-foreground">API key</h3>
                <div className="mt-3 max-w-xl">
                  <span className="text-xs font-medium text-foreground">Key source</span>
                  <div className="mt-1 inline-flex max-w-full flex-wrap rounded-lg border border-border bg-background p-1">
                    <Button type="button" size="sm" variant={credentialMode === "platform" ? "default" : "ghost"} onClick={() => { setCredentialMode("platform"); setCredentialSaved(false); setCredentialError(null); setCredentialReference(""); setApiKeyDialogOpen(false); }}>Platform key</Button>
                    <Button type="button" size="sm" variant={credentialMode === "user" ? "default" : "ghost"} onClick={() => { setCredentialMode("user"); setCredentialSaved(false); setCredentialError(null); setApiKeyDialogOpen(false); }}>Use my own API key</Button>
                  </div>
                </div>
                {credentialMode === "user" ? <div className="mt-3 space-y-3">
                  <div>
                    <span className="text-xs font-medium text-foreground">Provider</span>
                    <div className="mt-1"><ProviderTabs value={credentialProvider} configuredProviders={providerCredentials.filter((credential) => credential.status === "active").map((credential) => credential.provider)} onChange={(provider) => { setCredentialProvider(provider); setCredentialReference(""); setCredentialSaved(false); setCredentialError(null); setApiKeyDialogOpen(true); }} /></div>
                  </div>
                  {activeProviderCredentials.length ? <label className="block text-xs font-medium text-foreground">Saved {providerLabel(credentialProvider)} key
                    <Select value={credentialReference || "new"} onValueChange={(value) => { setCredentialReference(value === "new" ? "" : value); setCredentialSaved(false); if (value === "new") setApiKeyDialogOpen(true); }}>
                      <SelectTrigger className="mt-1"><SelectValue placeholder={credentialsLoading ? "Loading saved keys…" : "Choose a saved key"} /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="new">Enter a new API key</SelectItem>
                        {credentialReference && !activeProviderCredentials.some((credential) => credential.id === credentialReference) ? <SelectItem value={credentialReference}>Current saved key</SelectItem> : null}
                        {activeProviderCredentials.map((credential) => <SelectItem key={credential.id} value={credential.id}>{credential.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                  </label> : null}
                </div> : <p className="mt-2 text-xs text-muted-foreground">Uses the configured KasiTek provider key.</p>}
                {credentialSaved ? <p className="text-xs text-status-success" role="status">API key saved{credentialProvider !== modelProvider ? `. Select ${providerLabel(credentialProvider)} as the model provider to use it` : ""}.</p> : null}
                {credentialError ? <p className="text-xs text-destructive" role="alert">{credentialError}</p> : null}
              </div>
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-muted-foreground">Changes are saved as a new version. Publish it from Settings when you are ready.</p>
                <Button type="button" disabled={creatingVersion || !instructions.trim() || !model.trim() || Boolean(modelCatalog && providerModels.length && !selectedModelAvailable) || !workflowReady || !workflowValid || !workflow || (credentialMode === "user" && (!credentialReference || credentialProvider !== modelProvider))} onClick={() => void createVersion()}>{creatingVersion ? "Saving…" : "Save version"}</Button>
              </div>
            </CardContent>
          </Card>
          {apiKeyDialogOpen && credentialProvider ? <ApiKeyConfigurationDialog open={apiKeyDialogOpen} onOpenChange={setApiKeyDialogOpen} provider={credentialProvider} credentialKey={credentialKey} onCredentialKeyChange={setCredentialKey} credentialSaving={credentialSaving} credentialError={credentialError} credentialSaved={credentialSaved} onSave={() => void saveProviderCredential()} /> : null}
          </>
        ) : null}

        {activeSection === "behavior" && kasitekHostedAgent ? (
          <Card>
            <CardContent className="space-y-4 p-6">
              <div>
                <h2 className="text-lg font-semibold text-foreground">Agent behaviour</h2>
                <p className="mt-1 text-sm text-muted-foreground">Set instructions and runtime limits for this agent.</p>
              </div>
              <AgentRuntimeLimits value={runtimeLimits} onChange={setRuntimeLimits} />
              <Textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} rows={8} maxLength={200000} className="resize-y font-mono leading-6" aria-label="Agent instructions" />
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-muted-foreground">Changes are saved as a new version. Publish it from Settings when you are ready.</p>
                <Button type="button" disabled={creatingVersion || !instructions.trim() || !model.trim() || Boolean(modelCatalog && providerModels.length && !selectedModelAvailable) || !workflowReady || !workflowValid || !workflow || (credentialMode === "user" && (!credentialReference || credentialProvider !== modelProvider))} onClick={() => void createVersion()}>{creatingVersion ? "Saving…" : "Save version"}</Button>
              </div>
            </CardContent>
          </Card>
        ) : null}

        {activeSection === "settings" ? <details className="group rounded-xl border border-border bg-card" aria-labelledby="agent-versions-title">
          <summary className="cursor-pointer list-none p-5 [&::-webkit-details-marker]:hidden"><div className="flex items-center justify-between gap-3"><div><h2 id="agent-versions-title" className="font-semibold text-foreground">Version history</h2><p className="mt-1 text-sm text-muted-foreground">Publish, retire, or roll back agent versions.</p></div><span className="text-xs font-medium text-primary group-open:hidden">Open</span><span className="hidden text-xs font-medium text-primary group-open:inline">Close</span></div></summary>
          <div className="space-y-3 border-t border-border p-5">
          {error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
          {!versions.length ? <Card><CardContent className="p-6 text-sm text-muted-foreground">No versions are available for this agent.</CardContent></Card> : versions.map((version) => (
            <Card key={version.id}><CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div><div className="flex items-center gap-2"><h3 className="font-semibold text-foreground">Version {version.version_number}</h3>{version.id === agent.published_version_id ? <><CheckCircle2 className="h-4 w-4 text-status-success" aria-label="Published" /><Badge className="border-status-success/30 bg-status-success-soft text-status-success">Published</Badge></> : <Badge className={versionStatusClass(version.status)}>{version.status}</Badge>}{version.id === agent.installation_version_id ? <Badge className="border-primary/30 bg-primary/10 text-primary">Deployed</Badge> : null}</div><p className="mt-1 text-xs text-muted-foreground">Created {new Date(version.created_at).toLocaleString()}{version.published_at ? ` · Published ${new Date(version.published_at).toLocaleString()}` : ""}</p></div>
              {kasitekHostedAgent ? <div className="flex flex-wrap gap-2">
                {version.status === "draft" ? <Button type="button" size="sm" disabled={busy !== null} onClick={() => void mutate(`publish:${version.id}`, () => publishAgentVersion(agent.id, version.id))}>Publish</Button> : null}
                {version.status === "retired" ? <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => void mutate(`rollback:${version.id}`, () => rollbackAgentVersion(agent.id, version.id))}><RotateCcw className="mr-1.5 h-3.5 w-3.5" />Rollback</Button> : null}
                {version.status === "published" ? <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => void mutate(`retire:${version.id}`, () => retireAgentVersion(agent.id, version.id))}>Retire</Button> : null}
              </div> : null}
            </CardContent></Card>
          ))}
          </div>
        </details> : null}
          </main>
        </div>
        <Dialog open={deleteConfirmationOpen} onOpenChange={(open) => {
          if (!open && busy === null) { setDeleteConfirmationOpen(false); setDeleteConfirmationValue(""); }
        }}>
          <DialogContent className="max-w-md border-destructive/30">
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-destructive/10 text-destructive"><Trash2 className="h-5 w-5" aria-hidden="true" /></div>
            <DialogHeader className="mt-4"><DialogTitle>Delete agent permanently?</DialogTitle><DialogDescription>This permanently removes the agent, its versions, installations, conversations, knowledge, credentials, and run history.</DialogDescription></DialogHeader>
            <p className="mt-4 text-sm text-foreground">Type <code className="rounded bg-secondary px-1.5 py-0.5 font-mono text-xs">{agentName}</code> to continue.</p>
            <Input autoFocus value={deleteConfirmationValue} onChange={(event) => setDeleteConfirmationValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void confirmDeleteCurrentAgent(); }} className="mt-2" aria-label={`Type ${agentName} to confirm deletion`} placeholder={agentName} />
            {error ? <p className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
            <DialogFooter className="mt-6"><Button type="button" variant="outline" disabled={busy !== null} onClick={() => { setDeleteConfirmationOpen(false); setDeleteConfirmationValue(""); }}>Cancel</Button><Button type="button" variant="destructive" disabled={busy !== null || deleteConfirmationValue !== agentName} onClick={() => void confirmDeleteCurrentAgent()}>{busy === "delete" ? "Deleting…" : "Delete permanently"}</Button></DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}

function InstallationCredentials({ installationId }: { installationId: string }) {
  const [credentials, setCredentials] = useState<AgentInstallationCredential[]>([]);
  const [label, setLabel] = useState("");
  const [clientKeyId, setClientKeyId] = useState("");
  const [clientPublicKey, setClientPublicKey] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [rotating, setRotating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { confirm } = useConfirmationDialog();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await listAgentInstallationCredentials(installationId);
      setCredentials(response.credentials);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load agent credentials");
    } finally {
      setLoading(false);
    }
  }, [installationId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const create = async () => {
    if (!label.trim() || creating) return;
    setCreating(true);
    setSecret(null);
    setError(null);
    try {
      const created = await createAgentInstallationCredential(installationId, {
        label: label.trim(),
        ...(clientKeyId.trim() ? { clientKeyId: clientKeyId.trim() } : {}),
        ...(clientPublicKey.trim() ? { clientPublicKey: clientPublicKey.trim() } : {}),
      });
      setCredentials((current) => [created.credential, ...current]);
      setLabel("");
      setClientKeyId("");
      setClientPublicKey("");
      setSecret(created.secret);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create credential");
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (credential: AgentInstallationCredential) => {
    if (!await confirm({ title: `Revoke ${credential.label}?`, description: "Existing tokens will stop working.", confirmLabel: "Revoke", variant: "destructive" })) return;
    try {
      await revokeAgentInstallationCredential(installationId, credential.id);
      setCredentials((current) => current.map((entry) => entry.id === credential.id ? { ...entry, status: "revoked" } : entry));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to revoke credential");
    }
  };

  const rotate = async (credential: AgentInstallationCredential) => {
    if (rotating || !await confirm({ title: `Rotate ${credential.label}?`, description: "Existing tokens will stop working immediately.", confirmLabel: "Rotate", variant: "destructive" })) return;
    setRotating(credential.id);
    setError(null);
    try {
      const rotated = await rotateAgentInstallationCredential(installationId, credential.id);
      setCredentials((current) => [{ ...rotated.credential }, ...current.map((entry) => entry.id === credential.id ? { ...entry, status: "revoked" as const } : entry)]);
      setSecret(rotated.secret);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to rotate credential");
    } finally {
      setRotating(null);
    }
  };

  return <Card>
    <CardContent className="space-y-4 p-6">
      <div className="flex items-start gap-3"><KeyRound className="mt-0.5 h-5 w-5 text-primary" /><div><h2 className="text-lg font-semibold text-foreground">External agent credentials</h2><p className="mt-1 text-sm text-muted-foreground">Create named credentials for Codex, Claude, n8n, or your own agent. Secrets are shown once and can be revoked independently.</p></div></div>
      <div className="grid gap-3 rounded-xl border border-border bg-secondary/20 p-4 sm:grid-cols-[1fr_1fr_2fr_auto] sm:items-end">
        <label className="text-sm font-medium text-foreground">Credential name<Input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Local Codex" className="mt-2" /></label>
        <label className="text-sm font-medium text-foreground">Client key id<span className="ml-1 text-xs font-normal text-muted-foreground">(optional)</span><Input value={clientKeyId} onChange={(event) => setClientKeyId(event.target.value)} placeholder="codex-prod-1" className="mt-2" /></label>
        <label className="text-sm font-medium text-foreground">Client public key<span className="ml-1 text-xs font-normal text-muted-foreground">(SPKI PEM, optional)</span><Textarea value={clientPublicKey} onChange={(event) => setClientPublicKey(event.target.value)} placeholder="-----BEGIN PUBLIC KEY-----" rows={3} className="mt-2 resize-y font-mono text-xs" /></label>
        <Button type="button" onClick={() => void create()} disabled={creating || !label.trim()}>{creating ? "Creating…" : "Create credential"}</Button>
      </div>
      {secret ? <div className="rounded-xl border border-status-attention/40 bg-status-attention-soft p-4" role="alert"><p className="text-sm font-semibold text-status-attention">Copy this secret now. It will not be shown again.</p><div className="mt-2 flex gap-2"><code className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-background px-3 py-2 text-xs text-foreground">{secret}</code><Button type="button" variant="outline" size="sm" onClick={() => void navigator.clipboard?.writeText(secret)}><Copy className="mr-1.5 h-3.5 w-3.5" />Copy</Button></div><ExternalConnectionSetup secret={secret} /></div> : null}
      {error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
      {loading ? <p className="text-sm text-muted-foreground">Loading credentials…</p> : credentials.length ? <div className="space-y-2">{credentials.map((credential) => <div key={credential.id} className="flex flex-col gap-3 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-medium text-foreground">{credential.label}</p><p className="mt-1 text-xs text-muted-foreground">{credential.status}{credential.client_key_id ? ` · key ${credential.client_key_id}` : ""}</p></div>{credential.status === "active" ? <div className="flex gap-2"><Button type="button" variant="outline" size="sm" disabled={rotating !== null} onClick={() => void rotate(credential)}>{rotating === credential.id ? "Rotating…" : "Rotate"}</Button><Button type="button" variant="outline" size="sm" disabled={rotating !== null} onClick={() => void revoke(credential)}><Trash2 className="mr-1.5 h-3.5 w-3.5" />Revoke</Button></div> : null}</div>)}</div> : <p className="text-sm text-muted-foreground">No external credentials yet.</p>}
    </CardContent>
  </Card>;
}

function ExternalConnectionSetup({ secret }: { secret: string }) {
  const [mode, setMode] = useState<"mcp" | "rest">("mcp");
  const [copied, setCopied] = useState(false);
  const mcpExchange = [
    "curl -sS https://agents.kasitek.co.za/v1/installation-tokens/exchange",
    "  -H 'content-type: application/json'",
    `  -d '{\"secret\":\"${secret}\",\"audience\":\"mcp\"}'`,
  ].join("\n");
  const restExchange = [
    "curl -sS https://api.kasitek.co.za/v1/installation-tokens/exchange",
    "  -H 'content-type: application/json'",
    `  -d '{\"secret\":\"${secret}\",\"audience\":\"kasitek-public-api\"}'`,
  ].join("\n");
  const snippet = mode === "mcp" ? mcpExchange : restExchange;
  const copy = async () => {
    await navigator.clipboard?.writeText(snippet);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };
  return <div className="mt-4 rounded-lg border border-border bg-background/70 p-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><p className="text-sm font-semibold text-foreground">Connect an external agent</p><p className="mt-1 text-xs leading-5 text-muted-foreground">Exchange this secret once for a short-lived token. The secret is never sent to the MCP gateway or included in run history.</p></div><div className="flex rounded-lg border border-border bg-card p-0.5"><button type="button" className={`rounded-md px-2.5 py-1 text-xs ${mode === "mcp" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`} onClick={() => setMode("mcp")}>MCP</button><button type="button" className={`rounded-md px-2.5 py-1 text-xs ${mode === "rest" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`} onClick={() => setMode("rest")}>REST</button></div></div><p className="mt-3 text-xs text-muted-foreground">{mode === "mcp" ? "Use the returned access_token as Bearer authentication for https://agents.kasitek.co.za/mcp." : "Use the returned access_token as Bearer authentication for https://api.kasitek.co.za/v1."}</p><div className="mt-2 flex gap-2"><pre className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-secondary/60 p-3 text-[11px] leading-5 text-foreground">{snippet}</pre><Button type="button" variant="outline" size="sm" onClick={() => void copy()}>{copied ? "Copied" : "Copy"}</Button></div></div>;
}

function InstallationReadiness({ installationId }: { installationId: string }) {
  const [readiness, setReadiness] = useState<AgentReadiness | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setReadiness(await getAgentInstallationReadiness(installationId));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load activation readiness");
    } finally {
      setLoading(false);
    }
  }, [installationId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const checkClass = (status: string) => status === "ready" || status === "not_required"
    ? "border-status-success/30 bg-status-success-soft text-status-success"
    : "border-status-attention/30 bg-status-attention-soft text-status-attention";

  return <Card>
    <CardContent className="space-y-4 p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Deployment</p><h2 className="mt-1 text-lg font-semibold text-foreground">Activation readiness</h2><p className="mt-1 max-w-2xl text-sm text-muted-foreground">One summary of the checks that determine whether this installation can be tested and used.</p></div>
        <div className="flex items-center gap-2"><Badge className={readiness?.ready ? "border-status-success/30 bg-status-success-soft text-status-success" : "border-status-attention/30 bg-status-attention-soft text-status-attention"}>{loading ? "Checking…" : readiness?.ready ? "Ready" : "Needs setup"}</Badge><Button type="button" variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}><RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />Refresh</Button></div>
      </div>
      {error ? <div className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-status-danger-soft px-3 py-2 text-sm text-destructive" role="alert"><span>{error}</span><Button type="button" variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>Retry</Button></div> : null}
      {readiness ? <>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          <div className="rounded-lg border border-border bg-secondary/30 p-3"><p className="text-xs text-muted-foreground">Installation</p><Badge className={`mt-2 ${checkClass(readiness.checks.deployment.status)}`}>{readiness.checks.deployment.installationStatus}</Badge></div>
          <div className="rounded-lg border border-border bg-secondary/30 p-3"><p className="text-xs text-muted-foreground">Workflow</p><Badge className={`mt-2 ${checkClass(readiness.checks.workflow.status)}`}>{readiness.checks.workflow.status}</Badge></div>
          <div className="rounded-lg border border-border bg-secondary/30 p-3"><p className="text-xs text-muted-foreground">Capabilities</p><Badge className={`mt-2 ${checkClass(readiness.checks.capabilities.missing.length ? "blocked" : "ready")}`}>{readiness.checks.capabilities.available.length}/{readiness.checks.capabilities.required.length} ready</Badge></div>
          <div className="rounded-lg border border-border bg-secondary/30 p-3"><p className="text-xs text-muted-foreground">Connections</p><Badge className={`mt-2 ${checkClass(readiness.checks.connections.missing.length ? "blocked" : "ready")}`}>{readiness.checks.connections.configured.length}/{readiness.checks.connections.required.length} ready</Badge></div>
          <div className="rounded-lg border border-border bg-secondary/30 p-3"><p className="text-xs text-muted-foreground">Model credential</p><Badge className={`mt-2 ${checkClass(readiness.checks.credentials.status)}`}>{readiness.checks.credentials.status.replaceAll("_", " ")}</Badge></div>
        </div>
        {readiness.blockers.length ? <div className="rounded-lg border border-status-attention/30 bg-status-attention-soft p-4"><p className="text-sm font-semibold text-status-attention">What needs attention</p><ul className="mt-2 space-y-2 text-sm text-foreground">{readiness.blockers.map((blocker, index) => <li key={`${blocker.code}:${blocker.capability ?? blocker.connection ?? index}`}><span className="font-medium">{blocker.title}:</span> {blocker.detail}</li>)}</ul></div> : <p className="rounded-lg border border-status-success/20 bg-status-success-soft/40 px-3 py-2 text-sm text-muted-foreground">All activation checks are ready. Capability grants and provider effects are still enforced when a run executes.</p>}
      </> : null}
    </CardContent>
  </Card>;
}

function InstallationCapabilities({ installationId, protectedAgent }: { installationId: string; protectedAgent: boolean }) {
  const [capabilities, setCapabilities] = useState<AgentCapability[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await listAgentInstallationCapabilities(installationId);
      setCapabilities(response.capabilities);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load capabilities");
    } finally {
      setLoading(false);
    }
  }, [installationId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const groupedCapabilities = useMemo(() => {
    const groups = new Map<string, AgentCapability[]>();
    for (const capability of capabilities) {
      const group = capabilityGroup(capability);
      groups.set(group, [...(groups.get(group) || []), capability]);
    }
    return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
  }, [capabilities]);

  const grant = async (capability: AgentCapability) => {
    if (busy || capability.available === true) return;
    setBusy(capability.name);
    setError(null);
    try {
      await grantAgentInstallationTool(installationId, capability.name);
      setCapabilities((current) => current.map((entry) => entry.name === capability.name ? { ...entry, availability: "available", available: true, reasonCode: "available" } : entry));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to grant capability");
    } finally {
      setBusy(null);
    }
  };

  const grantedCount = capabilities.filter((capability) => capability.available === true || capability.availability === "available").length;
  const pendingCount = capabilities.filter((capability) => capabilityReason(capability) === "not_granted").length;

  return <Card>
    <CardContent className="p-0">
      <details className="group" open>
        <summary className="cursor-pointer list-none p-6 [&::-webkit-details-marker]:hidden">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Installation access</p>
              <h2 className="mt-1 text-lg font-semibold text-foreground">Service capabilities</h2>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">View which services this installation can use and change grantable services. The gateway checks these grants again for every request.</p>
            </div>
            <span className="shrink-0 rounded-full border border-border bg-secondary px-2.5 py-1 text-xs text-muted-foreground">{loading ? "Loading…" : `${grantedCount}/${capabilities.length} granted${pendingCount ? ` · ${pendingCount} pending` : ""}`}</span>
          </div>
          <span className="mt-3 inline-block text-xs font-medium text-primary group-open:hidden">Open service access</span>
          <span className="mt-3 hidden text-xs font-medium text-primary group-open:inline">Hide service access</span>
        </summary>
        <div className="space-y-4 border-t border-border p-6">
          {protectedAgent ? <p className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs leading-5 text-muted-foreground">KasiAi uses a platform-managed approved service allowlist. This panel reports its live grant state; it does not grant every capability registered in the platform.</p> : null}
          <div className="flex justify-end"><Button type="button" variant="outline" size="sm" onClick={() => void refresh()} disabled={loading || busy !== null}><RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />{loading ? "Refreshing…" : "Refresh"}</Button></div>
          {error ? <div className="flex flex-col gap-2 rounded-lg border border-destructive/30 bg-status-danger-soft px-3 py-2 text-sm text-destructive sm:flex-row sm:items-center sm:justify-between" role="alert"><span>{error}</span><Button type="button" variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}>Retry</Button></div> : null}
          {loading ? <p className="text-sm text-muted-foreground">Loading service capabilities…</p> : capabilities.length ? <div className="space-y-5">
            {groupedCapabilities.map(([group, entries]) => <section key={group} aria-labelledby={`capability-group-${group}`}>
              <div className="mb-2 flex items-center justify-between gap-3"><h3 id={`capability-group-${group}`} className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{group}</h3><span className="text-xs text-muted-foreground">{entries.filter((entry) => entry.available === true || entry.availability === "available").length}/{entries.length} granted</span></div>
              <div className="space-y-2">{entries.map((capability) => {
                const reason = capabilityReason(capability);
                const canGrant = reason === "not_granted" && !protectedAgent;
                const isAvailable = capability.available === true || capability.availability === "available";
                return <div key={capability.name} className="flex flex-col gap-3 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="font-medium text-foreground">{capability.name}</p><span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${availabilityClass(reason)}`}>{availabilityLabel(reason)}</span></div><p className="mt-1 text-xs leading-5 text-muted-foreground">{capability.description} · {capability.riskClass}{capability.requiresApproval ? " · approval required" : ""}{capability.permission?.scope ? ` · ${capability.permission.scope}` : ""}</p>{capability.subscription || capability.providerReadiness || capability.featureFlag ? <p className="mt-1 text-[11px] text-muted-foreground">Subscription: {capability.subscription ?? "unknown"} · provider: {capability.providerReadiness ?? "unknown"} · feature: {capability.featureFlag ?? "unknown"}</p> : null}{!canGrant && !isAvailable ? <p className="mt-1 text-xs text-status-attention">This capability is not grantable until its dependency is configured and healthy.</p> : null}</div>
                  <Button type="button" size="sm" variant={isAvailable ? "outline" : "default"} disabled={!canGrant || busy !== null} onClick={() => void grant(capability)}>{isAvailable ? "Granted" : busy === capability.name ? "Granting…" : canGrant ? "Grant service" : availabilityLabel(reason)}</Button>
                </div>;
              })}</div>
            </section>)}
          </div> : <p className="text-sm text-muted-foreground">No service capabilities are registered for this installation.</p>}
        </div>
      </details>
    </CardContent>
  </Card>;
}

function InstallationAccessScope({ installationId }: { installationId: string }) {
  const [resources, setResources] = useState<Array<{ resourceType: string; resourceId: string }>>([]);
  const [connectors, setConnectors] = useState<AgentConnector[]>([]);
  const [availableConnectors, setAvailableConnectors] = useState<AgentConnector[]>([]);
  const [resourceType, setResourceType] = useState("");
  const [resourceId, setResourceId] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [grants, installationConnectors, allConnectors] = await Promise.all([
        listAgentInstallationGrants(installationId),
        listAgentInstallationConnectors(installationId),
        listAgentConnectors(),
      ]);
      setResources(grants.resources);
      setConnectors(installationConnectors.connectors);
      setAvailableConnectors(allConnectors.connectors);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load access scope");
    } finally {
      setLoading(false);
    }
  }, [installationId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const addResource = async () => {
    if (!resourceType.trim() || !resourceId.trim() || busy) return;
    setBusy("resource");
    setError(null);
    try {
      await grantAgentInstallationResource(installationId, resourceType.trim(), resourceId.trim());
      setResources((current) => current.some((entry) => entry.resourceType === resourceType.trim() && entry.resourceId === resourceId.trim()) ? current : [...current, { resourceType: resourceType.trim(), resourceId: resourceId.trim() }]);
      setResourceType("");
      setResourceId("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to grant resource");
    } finally {
      setBusy(null);
    }
  };

  const grantConnector = async (connector: AgentConnector) => {
    if (busy || connectors.some((entry) => entry.id === connector.id)) return;
    setBusy(`connector:${connector.id}`);
    setError(null);
    try {
      await grantAgentInstallationConnector(installationId, connector.id);
      setConnectors((current) => [...current, connector]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to grant connector");
    } finally {
      setBusy(null);
    }
  };

  return <Card>
    <CardContent className="p-0">
      <details className="group" open>
        <summary className="cursor-pointer list-none p-6 [&::-webkit-details-marker]:hidden">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Installation access</p>
              <h2 className="mt-1 text-lg font-semibold text-foreground">Data scope and connectors</h2>
              <p className="mt-1 max-w-2xl text-sm text-muted-foreground">Review the records and provider connections this installation may use. These grants are checked again whenever a capability runs.</p>
            </div>
            <span className="shrink-0 rounded-full border border-border bg-secondary px-2.5 py-1 text-xs text-muted-foreground">{loading ? "Loading…" : `${resources.length} resource${resources.length === 1 ? "" : "s"} · ${connectors.length} connector${connectors.length === 1 ? "" : "s"}`}</span>
          </div>
          <span className="mt-3 inline-block text-xs font-medium text-primary group-open:hidden">Open data scope</span>
          <span className="mt-3 hidden text-xs font-medium text-primary group-open:inline">Hide data scope</span>
        </summary>
        <div className="space-y-4 border-t border-border p-6">
          {error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
          {loading ? <p className="text-sm text-muted-foreground">Loading data scope…</p> : <>
            <div className="rounded-xl border border-border bg-secondary/20 p-4"><p className="text-sm font-semibold text-foreground">Resource grants</p><p className="mt-1 text-xs text-muted-foreground">Add a resource only when the client must be limited to a known record.</p><div className="mt-3 grid gap-2 sm:grid-cols-[0.8fr_1.2fr_auto]"><Input value={resourceType} onChange={(event) => setResourceType(event.target.value)} placeholder="Resource type (e.g. content_post)" /><Input value={resourceId} onChange={(event) => setResourceId(event.target.value)} placeholder="Resource ID" /><Button type="button" size="sm" disabled={busy !== null || !resourceType.trim() || !resourceId.trim()} onClick={() => void addResource()}>{busy === "resource" ? "Granting…" : "Grant resource"}</Button></div>{resources.length ? <div className="mt-3 flex flex-wrap gap-2">{resources.map((resource) => <span key={`${resource.resourceType}:${resource.resourceId}`} className="rounded-full border border-border bg-background px-2.5 py-1 text-xs text-foreground">{resource.resourceType}: {resource.resourceId}</span>)}</div> : <p className="mt-3 text-xs text-muted-foreground">No resource-specific grants. Capability-level policy still applies.</p>}</div>
            <div className="rounded-xl border border-border bg-secondary/20 p-4"><p className="text-sm font-semibold text-foreground">Connector grants</p>{connectors.length ? <div className="mt-3 flex flex-wrap gap-2">{connectors.map((connector) => <span key={connector.id} className="rounded-full border border-status-success/30 bg-status-success-soft px-2.5 py-1 text-xs text-status-success">{connector.displayName || connector.id}</span>)}</div> : <p className="mt-3 text-xs text-muted-foreground">No connectors are granted to this installation.</p>}{availableConnectors.length ? <div className="mt-4 space-y-2">{availableConnectors.map((connector) => { const granted = connectors.some((entry) => entry.id === connector.id); return <div key={connector.id} className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-medium text-foreground">{connector.displayName || connector.id}</p><p className="mt-1 text-xs text-muted-foreground">{connector.auth} · {connector.capabilityNames.length} capabilities · v{connector.version}</p></div><Button type="button" size="sm" variant={granted ? "outline" : "default"} disabled={granted || busy !== null} onClick={() => void grantConnector(connector)}>{granted ? "Granted" : busy === `connector:${connector.id}` ? "Granting…" : "Grant connector"}</Button></div>; })}</div> : null}</div>
          </>}
        </div>
      </details>
    </CardContent>
  </Card>;
}

function ExternalAgentHealth({ installationId }: { installationId: string }) {
  const [health, setHealth] = useState<{ status: string; activeCredentialCount: number; lastUsedAt: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      const response = await getExternalAgentHealth(installationId);
      setHealth(response.health);
      setCheckedAt(new Date().toISOString());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load external connection health");
    } finally {
      setChecking(false);
    }
  }, [installationId]);

  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  return <Card><CardContent className="space-y-4 p-6"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold text-foreground">External connection health</h2><p className="mt-1 text-sm text-muted-foreground">This runtime is operated outside KasiTek. Health reflects installation status and whether a usable transport credential exists; it does not claim that the remote runtime is reachable.</p></div><Button type="button" variant="outline" size="sm" disabled={checking} onClick={() => void refresh()}><RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${checking ? "animate-spin" : ""}`} />{checking ? "Checking…" : "Check now"}</Button></div>{error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : health ? <><div className="grid gap-3 sm:grid-cols-3"><div className="rounded-lg bg-secondary/50 p-3"><p className="text-xs text-muted-foreground">Platform readiness</p><p className="mt-1 font-medium capitalize text-foreground">{health.status.replaceAll("_", " ")}</p></div><div className="rounded-lg bg-secondary/50 p-3"><p className="text-xs text-muted-foreground">Active credentials</p><p className="mt-1 font-medium text-foreground">{health.activeCredentialCount}</p></div><div className="rounded-lg bg-secondary/50 p-3"><p className="text-xs text-muted-foreground">Last used</p><p className="mt-1 font-medium text-foreground">{health.lastUsedAt ? new Date(health.lastUsedAt).toLocaleString() : "Not used yet"}</p></div></div>{checkedAt ? <p className="text-xs text-muted-foreground">Checked {new Date(checkedAt).toLocaleTimeString()}</p> : null}</> : <p className="text-sm text-muted-foreground">Checking connection health…</p>}</CardContent></Card>;
}

function AgentConversationHistory({ agentId, installationId }: { agentId: string; installationId: string }) {
  const [conversations, setConversations] = useState<AgentConversation[]>([]);
  const [selected, setSelected] = useState<AgentConversation | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedId = useRef<string | null>(null);

  const loadConversation = useCallback(async (conversation: AgentConversation) => {
    selectedId.current = conversation.id;
    setSelected(conversation);
    setLoadingMessages(true);
    try {
      const response = await getPlatformConversation(conversation.id);
      setSelected(response.conversation);
      setMessages([...response.messages].sort((left, right) => Number(left.sequence_number) - Number(right.sequence_number)));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load conversation");
    } finally {
      setLoadingMessages(false);
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await listAgentConversations(installationId, { kind: "customer" });
      setConversations(response.conversations);
      setError(null);
      if (!selectedId.current && response.conversations[0]) {
        await loadConversation(response.conversations[0]);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load agent conversations");
    } finally {
      setLoading(false);
    }
  }, [installationId, loadConversation]);

  useEffect(() => { void refresh(); }, [refresh]);

  return <Card>
    <CardContent className="space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-foreground">Chat history</h2>
        <Button asChild type="button" variant="outline" size="sm"><Link href={`/agents/conversations?view=all&agentId=${encodeURIComponent(agentId)}&installationId=${encodeURIComponent(installationId)}`}>Open live queue</Link></Button>
      </div>
      {error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
      <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <div className="space-y-2 rounded-xl border border-border bg-secondary/20 p-2" aria-label="Agent conversations">
          {loading ? <p className="p-3 text-sm text-muted-foreground">Loading conversations…</p> : conversations.length ? conversations.map((conversation) => <button key={conversation.id} type="button" onClick={() => void loadConversation(conversation)} className={`w-full rounded-lg border px-3 py-3 text-left transition-colors ${selected?.id === conversation.id ? "border-primary/50 bg-primary/10" : "border-transparent hover:border-border hover:bg-background"}`}><div className="flex items-start justify-between gap-2"><span className="truncate text-sm font-medium text-foreground">{conversation.participant_display_name || conversation.title || "Customer conversation"}</span>{conversation.unread_count ? <Badge className="border-primary/30 bg-primary/10 text-primary">{conversation.unread_count}</Badge> : null}</div><p className="mt-1 truncate text-xs text-muted-foreground">{conversation.last_message_preview || "No messages yet"}</p><p className="mt-1 text-[11px] text-muted-foreground">{conversation.channel_type} · {conversation.message_count ?? 0} messages</p></button>) : <p className="p-3 text-sm text-muted-foreground">No customer conversations yet.</p>}
        </div>
        <div className="min-h-64 rounded-xl border border-border bg-background p-4">
          {selected ? <><div className="border-b border-border pb-3"><p className="font-medium text-foreground">{selected.participant_display_name || selected.title || "Customer conversation"}</p><p className="mt-1 text-xs text-muted-foreground">{selected.channel_type} · {selected.external_conversation_id || "agent platform"}</p></div>{loadingMessages ? <p className="mt-4 text-sm text-muted-foreground">Loading messages…</p> : messages.length ? <div className="mt-4 max-h-96 space-y-3 overflow-y-auto">{messages.map((message) => { const text = typeof message.content?.text === "string" ? message.content.text : ""; const hasMedia = agentMessageHasMedia(message); return <div key={message.id} className={`rounded-lg px-3 py-2 text-sm ${message.direction === "outbound" ? "mr-8 bg-secondary text-foreground" : "ml-8 bg-primary/10 text-foreground"}`}><p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">{message.direction}</p><AgentMessageMedia message={message} />{text ? <p>{text}</p> : !hasMedia ? <p>{message.message_type}</p> : null}</div>; })}</div> : <p className="mt-4 text-sm text-muted-foreground">No messages in this conversation.</p>}</> : <p className="text-sm text-muted-foreground">Select a conversation to view its messages.</p>}
        </div>
      </div>
    </CardContent>
  </Card>;
}

function ExternalAgentOperations({ installationId }: { installationId: string }) {
  const [operations, setOperations] = useState<AgentInstallationOperation[]>([]);
  const [summary, setSummary] = useState<AgentInstallationOperationSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await listAgentInstallationOperations(installationId, 50);
      setOperations(response.operations);
      setSummary(response.summary);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load external operations");
    } finally {
      setLoading(false);
    }
  }, [installationId]);

  useEffect(() => { void refresh(); }, [refresh]);

  return <Card>
    <CardContent className="space-y-4 p-6">
      <div><h2 className="text-lg font-semibold text-foreground">External operations</h2><p className="mt-1 text-sm text-muted-foreground">MCP and REST calls are tracked as operations and usage, not customer conversations.</p></div>
      {error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
      {summary ? <div className="grid gap-3 sm:grid-cols-4"><div className="rounded-lg bg-secondary/50 p-3"><p className="text-xs text-muted-foreground">Operations</p><p className="mt-1 text-xl font-semibold text-foreground">{summary.total}</p></div><div className="rounded-lg bg-secondary/50 p-3"><p className="text-xs text-muted-foreground">Tool calls</p><p className="mt-1 text-xl font-semibold text-foreground">{summary.toolInvocations}</p></div><div className="rounded-lg bg-secondary/50 p-3"><p className="text-xs text-muted-foreground">Model calls</p><p className="mt-1 text-xl font-semibold text-foreground">{summary.modelCalls}</p></div><div className="rounded-lg bg-secondary/50 p-3"><p className="text-xs text-muted-foreground">Estimated cost</p><p className="mt-1 text-xl font-semibold text-foreground">${summary.estimatedCostUsd}</p></div></div> : null}
      {loading ? <p className="text-sm text-muted-foreground">Loading operations…</p> : operations.length ? <div className="space-y-2">{operations.map((operation) => <div key={operation.id} className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between"><div><Link href={`/agents/activity/${encodeURIComponent(operation.id)}`} className="font-mono text-xs text-primary underline-offset-2 hover:underline">{operation.id}</Link><p className="mt-1 text-xs text-muted-foreground">{operation.transport ?? "unknown"} · {operation.tool_name ?? "capability"}{operation.created_at ? ` · ${new Date(operation.created_at).toLocaleString()}` : ""}</p></div><Badge className={operation.status === "completed" ? "border-status-success/30 bg-status-success-soft text-status-success" : operation.status === "failed" ? "border-destructive/30 bg-destructive/10 text-destructive" : "border-border bg-secondary text-muted-foreground"}>{operation.status}</Badge></div>)}</div> : <p className="text-sm text-muted-foreground">No external operations have been recorded for this installation.</p>}
    </CardContent>
  </Card>;
}

function InstallationRuns({ installationId }: { installationId: string }) {
  const [runs, setRuns] = useState<AgentInstallationRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await listAgentInstallationRuns(installationId, 50);
      setRuns(response.runs);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load agent runs");
    } finally {
      setLoading(false);
    }
  }, [installationId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const usage = runs.reduce((totals, run) => {
    const runUsage = run.output?.usage;
    const inputTokens = runUsage && typeof runUsage === "object" && typeof (runUsage as Record<string, unknown>).inputTokens === "number" ? Number((runUsage as Record<string, unknown>).inputTokens) : 0;
    const outputTokens = runUsage && typeof runUsage === "object" && typeof (runUsage as Record<string, unknown>).outputTokens === "number" ? Number((runUsage as Record<string, unknown>).outputTokens) : 0;
    return { inputTokens: totals.inputTokens + inputTokens, outputTokens: totals.outputTokens + outputTokens, completed: totals.completed + (run.status === "completed" ? 1 : 0), failed: totals.failed + (["failed", "expired"].includes(run.status) ? 1 : 0) };
  }, { inputTokens: 0, outputTokens: 0, completed: 0, failed: 0 });

  return <Card>
    <CardContent className="space-y-4 p-6">
      <div><h2 className="text-lg font-semibold text-foreground">Recent runs</h2><p className="mt-1 text-sm text-muted-foreground">Durable runs for this installation, including channel and external-agent activity.</p></div>
      {error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
      {!loading && runs.length ? <div className="grid gap-2 sm:grid-cols-4"><div className="rounded-lg bg-secondary/50 p-3"><p className="text-xs text-muted-foreground">Runs shown</p><p className="mt-1 text-xl font-semibold text-foreground">{runs.length}</p></div><div className="rounded-lg bg-secondary/50 p-3"><p className="text-xs text-muted-foreground">Completed</p><p className="mt-1 text-xl font-semibold text-foreground">{usage.completed}</p></div><div className="rounded-lg bg-secondary/50 p-3"><p className="text-xs text-muted-foreground">Failed/expired</p><p className="mt-1 text-xl font-semibold text-foreground">{usage.failed}</p></div><div className="rounded-lg bg-secondary/50 p-3"><p className="text-xs text-muted-foreground">Tokens (shown)</p><p className="mt-1 text-xl font-semibold text-foreground">{(usage.inputTokens + usage.outputTokens).toLocaleString()}</p></div></div> : null}
      {loading ? <p className="text-sm text-muted-foreground">Loading runs…</p> : runs.length ? <div className="space-y-2">{runs.map((run) => <div key={run.id} className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between"><div><Link href={`/agents/activity/${encodeURIComponent(run.id)}`} className="font-mono text-xs text-primary underline-offset-2 hover:underline">{run.id}</Link><p className="mt-1 text-xs text-muted-foreground">{run.trigger_type ?? "manual"}{run.created_at ? ` · ${new Date(run.created_at).toLocaleString()}` : ""}</p>{run.error?.message ? <p className="mt-1 text-xs text-destructive">{run.error.message}</p> : null}</div><div className="flex items-center gap-2"><Badge className={run.status === "completed" ? "border-status-success/30 bg-status-success-soft text-status-success" : run.status === "failed" ? "border-destructive/30 bg-destructive/10 text-destructive" : "border-border bg-secondary text-muted-foreground"}>{run.status}</Badge><Link href={`/agents/activity/${encodeURIComponent(run.id)}`} className="text-xs text-muted-foreground hover:text-foreground">Inspect</Link></div></div>)}</div> : <p className="text-sm text-muted-foreground">No runs have been recorded for this installation.</p>}
    </CardContent>
  </Card>;
}

function InstallationKnowledge({ agentId, installationId }: { agentId: string; installationId: string }) {
  const [sources, setSources] = useState<AgentKnowledgeSource[]>([]);
  const [memories, setMemories] = useState<AgentMemory[]>([]);
  const [articleText, setArticleText] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [knowledgeFile, setKnowledgeFile] = useState<File | null>(null);
  const [fileInputKey, setFileInputKey] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openSourceId, setOpenSourceId] = useState<string | null>(null);
  const [sourceDraft, setSourceDraft] = useState("");
  const [saveConfirmation, setSaveConfirmation] = useState<{ name: string; revision: number } | null>(null);
  const { confirm } = useConfirmationDialog();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [sourceResponse, memoryResponse] = await Promise.all([
        listAgentKnowledgeSources(agentId, installationId),
        listAgentMemory(agentId, installationId),
      ]);
      setSources(sourceResponse.sources);
      setMemories(memoryResponse.memories);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load knowledge and memory");
    } finally {
      setLoading(false);
    }
  }, [agentId, installationId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const processingWebsite = sources.find((source) => source.source_type === "url" && source.status === "processing" && typeof source.provenance.crawlId === "string" && source.provenance.crawler === "firecrawl");
  const processingWebsiteId = processingWebsite?.id;
  useEffect(() => {
    if (!processingWebsiteId) return;
    const timer = setInterval(() => {
      void getAgentWebsiteCrawl(processingWebsiteId).then(() => refresh()).catch(() => undefined);
    }, 4_000);
    return () => clearInterval(timer);
  }, [processingWebsiteId, refresh]);

  const openSource = async (source: AgentKnowledgeSource) => {
    if (busy) return;
    if (openSourceId === source.id) {
      setOpenSourceId(null);
      return;
    }
    setBusy(`open-source:${source.id}`);
    setError(null);
    try {
      const document = await getAgentKnowledgeSource(source.id);
      setOpenSourceId(source.id);
      setSourceDraft(document.text);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to open knowledge source");
    } finally {
      setBusy(null);
    }
  };

  const saveSource = async (source: AgentKnowledgeSource) => {
    if (source.source_type !== "manual" || !sourceDraft.trim() || busy) return;
    setBusy(`save-source:${source.id}`);
    setError(null);
    try {
      const result = await ingestAgentKnowledgeSourceText(source.id, sourceDraft.trim());
      await refresh();
      setOpenSourceId(null);
      setSaveConfirmation({ name: source.name, revision: result.revision });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save knowledge source");
    } finally {
      setBusy(null);
    }
  };

  const addArticle = async () => {
    if (!articleText.trim() || busy) return;
    setBusy("article");
    setError(null);
    try {
      const source = await createAgentKnowledgeSource({ agentId, installationId, name: "Information encyclopedia", sourceType: "manual" });
      await ingestAgentKnowledgeSourceText(source.id, articleText.trim());
      setArticleText("");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save encyclopedia information");
    } finally {
      setBusy(null);
    }
  };

  const addFile = async () => {
    if (!knowledgeFile || busy) return;
    setBusy("file");
    setError(null);
    try {
      const source = await createAgentKnowledgeSource({ agentId, installationId, name: "Information upload", sourceType: "upload" });
      await ingestAgentKnowledgeSourceFile(source.id, knowledgeFile);
      setKnowledgeFile(null);
      setFileInputKey((current) => current + 1);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to index the selected file");
    } finally {
      setBusy(null);
    }
  };

  const addWebsite = async () => {
    if (!websiteUrl.trim() || busy) return;
    setBusy("website");
    setError(null);
    try {
      await startAgentWebsiteCrawl({ agentId, installationId, name: "Website knowledge", url: websiteUrl.trim() });
      setWebsiteUrl("");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to start the website crawl");
    } finally {
      setBusy(null);
    }
  };

  const cancelWebsite = async (source: AgentKnowledgeSource) => {
    if (busy) return;
    setBusy(`cancel-website:${source.id}`);
    setError(null);
    try {
      await cancelAgentWebsiteCrawl(source.id);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to cancel the website crawl");
    } finally {
      setBusy(null);
    }
  };

  const removeSource = async (source: AgentKnowledgeSource) => {
    if (busy || !await confirm({ title: `Remove ${source.name}?`, description: "Its indexed chunks will no longer be retrieved.", confirmLabel: "Remove", variant: "destructive" })) return;
    setBusy(`source:${source.id}`);
    try {
      await deleteAgentKnowledgeSource(source.id, agentId, installationId);
      setSources((current) => current.filter((entry) => entry.id !== source.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to remove knowledge source");
    } finally {
      setBusy(null);
    }
  };

  const removeMemory = async (memory: AgentMemory) => {
    if (busy || !await confirm({ title: "Delete memory?", description: "This is recorded as a deletion request.", confirmLabel: "Delete", variant: "destructive" })) return;
    setBusy(`memory:${memory.id}`);
    try {
      await deleteAgentMemory(memory.id, agentId, installationId);
      setMemories((current) => current.filter((entry) => entry.id !== memory.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to delete memory");
    } finally {
      setBusy(null);
    }
  };

  const revalidate = async (memory: AgentMemory) => {
    if (busy) return;
    setBusy(`revalidate:${memory.id}`);
    try {
      const updated = await revalidateAgentMemory(memory.id, agentId, installationId, null);
      setMemories((current) => current.map((entry) => entry.id === memory.id ? updated : entry));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to revalidate memory");
    } finally {
      setBusy(null);
    }
  };

  const review = async (memory: AgentMemory, decision: "approve" | "reject") => {
    if (busy) return;
    setBusy(`review:${memory.id}:${decision}`);
    try {
      const updated = (await reviewAgentMemory(memory.id, agentId, decision, installationId)).memory;
      setMemories((current) => current.map((entry) => entry.id === memory.id ? updated : entry));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to review memory");
    } finally {
      setBusy(null);
    }
  };

  const openSourceRecord = sources.find((source) => source.id === openSourceId);

  return <>
    <Card>
    <CardContent className="space-y-5 p-6">
      <div><h2 className="text-lg font-semibold text-foreground">Information encyclopedia</h2><p className="mt-1 text-sm text-muted-foreground">Paste the facts, FAQs, policies, or service details this agent should know.</p></div>
      {error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
      <div className="rounded-xl border border-border bg-secondary/20 p-4">
        <div><p className="text-sm font-semibold text-foreground">Paste information</p><p className="mt-1 text-xs leading-5 text-muted-foreground">It will be split into searchable sections.</p></div>
        <div className="mt-3 space-y-2">
          <Textarea value={articleText} onChange={(event) => setArticleText(event.target.value)} rows={6} maxLength={200_000} placeholder="Paste the information your agent should use…" className="resize-y leading-6" />
          <div className="flex justify-end"><Button type="button" size="sm" disabled={busy !== null || !articleText.trim()} onClick={() => void addArticle()}>{busy === "article" ? "Indexing…" : "Save information"}</Button></div>
        </div>
      </div>
      <div className="flex flex-col gap-3 rounded-xl border border-border bg-secondary/10 p-4 sm:flex-row sm:items-center"><div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><Upload className="h-5 w-5" /></div><div className="min-w-0 flex-1"><p className="text-sm font-semibold text-foreground">Upload information</p><p className="mt-1 truncate text-xs text-muted-foreground">{knowledgeFile ? knowledgeFile.name : "TXT, Markdown, CSV, PDF, DOCX, or Excel · up to 20 MB"}</p></div><label className="cursor-pointer rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium text-foreground hover:border-primary/50"><span>Choose file</span><input key={fileInputKey} type="file" className="sr-only" accept=".txt,.text,.md,.markdown,.csv,.pdf,.docx,.xlsx,.xls,text/plain,text/markdown,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" onChange={(event) => { const file = event.target.files?.[0] ?? null; if (file && file.size > 20 * 1024 * 1024) { setError("Files must be 20 MB or smaller."); setKnowledgeFile(null); return; } setError(null); setKnowledgeFile(file); }} /></label><Button type="button" size="sm" disabled={busy !== null || !knowledgeFile} onClick={() => void addFile()}>{busy === "file" ? "Indexing…" : "Add file"}</Button></div>
      <div className="rounded-xl border border-border bg-secondary/10 p-4"><div className="flex items-start gap-3"><div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary"><Globe2 className="h-4 w-4" /></div><div><p className="text-sm font-semibold text-foreground">Website source</p><p className="mt-1 text-xs leading-5 text-muted-foreground">Crawl public pages and add their content and links to knowledge.</p></div></div><div className="mt-3 flex flex-col gap-2 sm:flex-row"><Input type="url" value={websiteUrl} onChange={(event) => setWebsiteUrl(event.target.value)} placeholder="https://example.com" className="h-10" /><Button type="button" size="sm" disabled={busy !== null || !websiteUrl.trim()} onClick={() => void addWebsite()}>{busy === "website" ? "Starting…" : "Crawl website"}</Button></div>{processingWebsite ? <p className="mt-2 text-xs text-primary">Crawling {processingWebsite.source_uri}…</p> : null}</div>
      {loading ? <p className="text-sm text-muted-foreground">Loading knowledge and memory…</p> : <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2"><p className="text-sm font-semibold text-foreground">Knowledge sources</p>{sources.length ? sources.map((source) => <div key={source.id} className="flex items-start justify-between gap-3 rounded-lg border border-border p-3"><div className="min-w-0"><p className="font-medium text-foreground">{source.name}</p><p className="mt-1 truncate text-xs text-muted-foreground">{source.source_uri || source.source_type} · revision {source.revision} · {source.status}</p></div><div className="flex shrink-0 gap-2">{source.status === "processing" && source.source_type === "url" ? <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => void cancelWebsite(source)}>{busy === `cancel-website:${source.id}` ? "Cancelling…" : "Cancel"}</Button> : <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => void openSource(source)}>{busy === `open-source:${source.id}` ? "Opening…" : source.source_type === "manual" ? "Edit" : "Open"}</Button>}<Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => void removeSource(source)}>{busy === `source:${source.id}` ? "Removing…" : "Remove"}</Button></div></div>) : <p className="text-sm text-muted-foreground">No knowledge sources are attached.</p>}</div>
        <div className="space-y-2"><p className="text-sm font-semibold text-foreground">Durable memories</p>{memories.length ? memories.slice(0, 20).map((memory) => <div key={memory.id} className="rounded-lg border border-border p-3"><p className="line-clamp-2 text-sm text-foreground">{memory.canonical_text}</p><div className="mt-2 flex flex-wrap items-center justify-between gap-2"><p className="text-[11px] text-muted-foreground">{memory.namespace} · {memory.memory_type} · {memory.status}{memory.expires_at ? ` · expires ${new Date(memory.expires_at).toLocaleDateString()}` : ""}</p><div className="flex flex-wrap justify-end gap-1">{memory.status === "review_pending" || memory.status === "quarantined" ? <><Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => void review(memory, "approve")}>{busy === `review:${memory.id}:approve` ? "…" : "Approve"}</Button><Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={() => void review(memory, "reject")}>{busy === `review:${memory.id}:reject` ? "…" : "Reject"}</Button></> : <Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={() => void revalidate(memory)}>{busy === `revalidate:${memory.id}` ? "…" : "Revalidate"}</Button>}<Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={() => void removeMemory(memory)}>Delete</Button></div></div></div>) : <p className="text-sm text-muted-foreground">No memories are recorded for this installation.</p>}</div>
      </div>}
    </CardContent>
    </Card>
    <Dialog open={Boolean(openSourceRecord)} onOpenChange={(open) => { if (!open) setOpenSourceId(null); }}>{openSourceRecord ? <DialogContent className="flex max-h-[calc(100svh-2rem)] max-w-5xl flex-col overflow-hidden p-0"><div className="border-b border-border px-6 py-5"><DialogHeader><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-primary">Knowledge source</p><DialogTitle className="truncate">{openSourceRecord.name}</DialogTitle><DialogDescription>Revision {openSourceRecord.revision} · {openSourceRecord.source_type}</DialogDescription></DialogHeader></div><div className="min-h-0 flex-1 overflow-y-auto p-6">{openSourceRecord.source_type === "manual" ? <Textarea value={sourceDraft} onChange={(event) => setSourceDraft(event.target.value)} rows={24} maxLength={200_000} className="min-h-[55svh] resize-y" aria-label={`Edit ${openSourceRecord.name}`} /> : <div className="min-h-[55svh] whitespace-pre-wrap rounded-xl border border-border bg-secondary/20 p-4 text-sm leading-6 text-foreground">{sourceDraft || "No extracted text is available for this source."}</div>}</div><DialogFooter className="items-center justify-between border-t border-border px-6 py-4 sm:justify-between"><p className="text-xs text-muted-foreground">{openSourceRecord.source_type === "manual" ? "Save creates a new searchable revision." : "This source is read-only here; replace it from the original file or URL."}</p><div className="flex gap-2"><Button type="button" variant="outline" onClick={() => setOpenSourceId(null)}>Cancel</Button>{openSourceRecord.source_type === "manual" ? <Button type="button" disabled={busy !== null || !sourceDraft.trim()} onClick={() => void saveSource(openSourceRecord)}>{busy === `save-source:${openSourceRecord.id}` ? "Saving…" : "Save changes"}</Button> : null}</div></DialogFooter></DialogContent> : null}</Dialog>
    <Dialog open={Boolean(saveConfirmation)} onOpenChange={(open) => { if (!open) setSaveConfirmation(null); }}>{saveConfirmation ? <DialogContent className="max-w-md"><DialogHeader><div className="flex h-12 w-12 items-center justify-center rounded-full bg-status-success-soft text-status-success"><CheckCircle2 className="h-6 w-6" aria-hidden="true" /></div><DialogTitle>Information saved</DialogTitle><DialogDescription><span className="font-medium text-foreground">{saveConfirmation.name}</span> is now available to the agent as searchable knowledge.</DialogDescription></DialogHeader><p className="text-xs text-muted-foreground">Revision {saveConfirmation.revision} created successfully.</p><DialogFooter><Button type="button" onClick={() => setSaveConfirmation(null)}>Done</Button></DialogFooter></DialogContent> : null}</Dialog>
  </>;
}

function InstallationSchedules({ installationId }: { installationId: string }) {
  const [schedules, setSchedules] = useState<AgentSchedule[]>([]);
  const [expression, setExpression] = useState("0 9 * * *");
  const [timezone, setTimezone] = useState("UTC");
  const [nextRunAt, setNextRunAt] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await listAgentInstallationSchedules(installationId);
      setSchedules(response.schedules);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load schedules");
    } finally {
      setLoading(false);
    }
  }, [installationId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const create = async () => {
    if (!expression.trim() || !timezone.trim() || busy) return;
    setBusy("create");
    setError(null);
    try {
      const schedule = await createAgentInstallationSchedule(installationId, { expression: expression.trim(), timezone: timezone.trim(), nextRunAt: nextRunAt ? new Date(nextRunAt).toISOString() : undefined, input: { source: "agent-detail" } });
      setSchedules((current) => [schedule, ...current]);
      setNextRunAt("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create schedule");
    } finally {
      setBusy(null);
    }
  };

  const setStatus = async (schedule: AgentSchedule) => {
    if (busy) return;
    const status = schedule.status === "active" ? "paused" : "active";
    setBusy(schedule.id);
    try {
      const updated = await setAgentScheduleStatus(schedule.id, status);
      setSchedules((current) => current.map((entry) => entry.id === schedule.id ? updated : entry));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to update schedule");
    } finally {
      setBusy(null);
    }
  };

  return <Card>
    <CardContent className="space-y-4 p-6">
      <div><h2 className="text-lg font-semibold text-foreground">Schedules</h2><p className="mt-1 text-sm text-muted-foreground">Create durable schedule triggers for this installation. The runtime owns dispatch and records each resulting run.</p></div>
      {error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
      <div className="grid gap-2 rounded-xl border border-border bg-secondary/20 p-4 sm:grid-cols-[1.2fr_0.7fr_1fr_auto] sm:items-end"><label className="text-xs font-medium text-foreground">Cron expression<Input value={expression} onChange={(event) => setExpression(event.target.value)} placeholder="0 9 * * *" className="mt-1" /></label><label className="text-xs font-medium text-foreground">Timezone<Input value={timezone} onChange={(event) => setTimezone(event.target.value)} placeholder="Africa/Johannesburg" className="mt-1" /></label><label className="text-xs font-medium text-foreground">First run (optional)<Input value={nextRunAt} onChange={(event) => setNextRunAt(event.target.value)} type="datetime-local" className="mt-1" /></label><Button type="button" size="sm" disabled={busy !== null || !expression.trim()} onClick={() => void create()}>{busy === "create" ? "Creating…" : "Add schedule"}</Button></div>
      {loading ? <p className="text-sm text-muted-foreground">Loading schedules…</p> : schedules.length ? <div className="space-y-2">{schedules.map((schedule) => <div key={schedule.id} className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-mono text-sm text-foreground">{schedule.expression}</p><p className="mt-1 text-xs text-muted-foreground">{schedule.timezone} · {schedule.next_run_at ? `next ${new Date(schedule.next_run_at).toLocaleString()}` : "runtime calculates next run"}</p></div><Button type="button" variant="outline" size="sm" disabled={busy !== null || schedule.status === "disabled"} onClick={() => void setStatus(schedule)}>{busy === schedule.id ? "Updating…" : schedule.status === "active" ? "Pause" : "Resume"}</Button></div>)}</div> : <p className="text-sm text-muted-foreground">No schedules configured.</p>}
    </CardContent>
  </Card>;
}

function integrationProviderLabel(provider: string) {
  switch (provider.toUpperCase()) {
    case "WHATSAPP":
      return "WhatsApp";
    case "FACEBOOK":
      return "Facebook Page";
    case "INSTAGRAM":
      return "Instagram";
    default:
      return provider.replaceAll("_", " ");
  }
}

function integrationIcon(provider: string): IconType {
  switch (provider.toUpperCase()) {
    case "WHATSAPP":
      return SiWhatsapp;
    case "FACEBOOK":
      return SiMessenger;
    case "INSTAGRAM":
      return SiInstagram;
    default:
      return SiModelcontextprotocol;
  }
}

function integrationIconColor(provider: string) {
  switch (provider.toUpperCase()) {
    case "WHATSAPP":
      return "text-[#25D366]";
    case "FACEBOOK":
      return "text-[#0084FF]";
    case "INSTAGRAM":
      return "text-[#E4405F]";
    default:
      return "text-primary";
  }
}

function IntegrationIcon({ provider, className }: { provider: string; className?: string }) {
  switch (provider.toUpperCase()) {
    case "WHATSAPP":
      return <SiWhatsapp className={className} />;
    case "FACEBOOK":
      return <SiMessenger className={className} />;
    case "INSTAGRAM":
      return <SiInstagram className={className} />;
    default:
      return <SiModelcontextprotocol className={className} />;
  }
}

function InstallationIntegrations({ agentId, installationId, personal, agentName, onWebsiteDeploymentStateChange }: { agentId: string; installationId: string; personal: boolean; agentName: string; onWebsiteDeploymentStateChange?: (configured: boolean) => void }) {
  const [workspaceConnections, setWorkspaceConnections] = useState<WorkspaceConnection[]>([]);
  const [agentConnections, setAgentConnections] = useState<AgentChannelConnection[]>([]);
  const [bindings, setBindings] = useState<AgentChannelBinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [websiteChatOpen, setWebsiteChatOpen] = useState(false);
  const [websiteDeployments, setWebsiteDeployments] = useState<AgentWebsiteDeployment[]>([]);
  const { confirm } = useConfirmationDialog();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [workspace, agent] = await Promise.all([
        listWorkspaceConnections(),
        listKasiAiChannels(installationId),
      ]);
      setWorkspaceConnections(workspace.connections);
      setAgentConnections(agent.connections);
      setBindings(agent.bindings);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load integrations");
    } finally {
      setLoading(false);
    }
  }, [installationId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const refreshWebsiteDeployments = useCallback(async () => {
    if (personal) {
      setWebsiteDeployments([]);
      return;
    }
    try {
      const result = await listAgentWebsiteDeployments(installationId);
      setWebsiteDeployments(result.deployments);
      onWebsiteDeploymentStateChange?.(result.deployments.some((deployment) => deployment.status !== "REVOKED"));
    } catch {
      // Keep the integration card usable if the deployment status request fails.
      setWebsiteDeployments([]);
    }
  }, [installationId, onWebsiteDeploymentStateChange, personal]);

  useEffect(() => { void refreshWebsiteDeployments(); }, [refreshWebsiteDeployments]);

  const openWebsiteChat = () => setWebsiteChatOpen(true);
  const [telegramSetupOpen, setTelegramSetupOpen] = useState(false);
  const [discordSetupOpen, setDiscordSetupOpen] = useState(false);
  const [whatsappSetupOpen, setWhatsappSetupOpen] = useState(false);
  const [whatsappSetupConnection, setWhatsappSetupConnection] = useState<WorkspaceConnection | null>(null);
  const [socialSetupOpen, setSocialSetupOpen] = useState(false);
  const [socialSetupConnection, setSocialSetupConnection] = useState<WorkspaceConnection | null>(null);
  const [socialSetupError, setSocialSetupError] = useState<string | null>(null);

  const agentChannelTypeFor = (connection: WorkspaceConnection) => {
    switch (connection.provider.toUpperCase()) {
      case "FACEBOOK": return "facebook";
      case "INSTAGRAM": return "instagram";
      default: return "whatsapp";
    }
  };

  const agentChannelFor = (connection: WorkspaceConnection) => agentConnections.find((entry) => (
    entry.channel_type === agentChannelTypeFor(connection) && entry.status === "active"
    && (entry.channel_key === connection.id || entry.metadata?.coreConnectionId === connection.id)
  ));

  const activeBindingFor = (channel: AgentChannelConnection | undefined) => channel
    ? bindings.some((binding) => binding.channel_type === "whatsapp" && binding.status === "active" && (!binding.channel_connection_id || binding.channel_connection_id === channel.id))
    : false;

  const allowedWhatsappPhonesFor = (channel: AgentChannelConnection | undefined) => {
    const access = channel?.metadata?.whatsappAccess;
    const phones = access && typeof access === "object" ? (access as Record<string, unknown>).allowedPhones : undefined;
    return Array.isArray(phones) ? phones.filter((value): value is string => typeof value === "string") : [];
  };

  const openWhatsAppSetup = (workspaceConnection: WorkspaceConnection) => {
    setWhatsappSetupConnection(workspaceConnection);
    setWhatsappSetupOpen(true);
  };

  const openSocialSetup = (workspaceConnection: WorkspaceConnection) => {
    setSocialSetupConnection(workspaceConnection);
    setSocialSetupError(null);
    setSocialSetupOpen(true);
  };

  const assignWhatsApp = async (connection: WorkspaceConnection) => {
    if (personal || busy || connection.status !== "CONNECTED") return;
    setBusy(connection.id);
    setSocialSetupError(null);
    setError(null);
    try {
      const channel = await createAgentChannelConnection(installationId, {
        channelType: "whatsapp",
        channelKey: connection.id,
        metadata: {
          configuredFrom: "agent-integrations",
          coreConnectionId: connection.id,
          provider: "WHATSAPP",
          routing: "public",
        },
      });
      setAgentConnections((current) => [channel, ...current.filter((entry) => entry.id !== channel.id)]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to assign WhatsApp to this agent");
    } finally {
      setBusy(null);
    }
  };

  const removeWhatsApp = async (connection: WorkspaceConnection, channel: AgentChannelConnection | undefined) => {
    if (!channel || busy || !await confirm({ title: personal ? `Disconnect ${connection.displayName}?` : `Stop routing ${connection.displayName}?`, description: personal ? "This disconnects the account from KasiAI." : "This stops routing the account to this agent.", confirmLabel: "Disconnect", variant: "destructive" })) return;
    setBusy(connection.id);
    setError(null);
    try {
      await revokeAgentChannelConnection(installationId, channel.id);
      setAgentConnections((current) => current.filter((entry) => entry.id !== channel.id));
      setBindings((current) => current.filter((binding) => binding.channel_connection_id !== channel.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to remove WhatsApp from this agent");
    } finally {
      setBusy(null);
    }
  };

  const assignSocial = async (connection: WorkspaceConnection) => {
    if (personal || busy || connection.status !== "CONNECTED") return;
    setBusy(connection.id);
    setError(null);
    try {
      const channel = await createAgentChannelConnection(installationId, {
        channelType: agentChannelTypeFor(connection),
        channelKey: connection.id,
        metadata: {
          configuredFrom: "agent-integrations",
          coreConnectionId: connection.id,
          provider: connection.provider.toUpperCase(),
          routing: "public",
        },
      });
      setAgentConnections((current) => [channel, ...current.filter((entry) => entry.id !== channel.id)]);
      setSocialSetupOpen(false);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : `Unable to assign ${integrationProviderLabel(connection.provider)} to this agent`;
      setSocialSetupError(message);
      setError(message);
    } finally {
      setBusy(null);
    }
  };

  const removeSocial = async (connection: WorkspaceConnection, channel: AgentChannelConnection | undefined) => {
    if (!channel || busy || !await confirm({ title: `Stop routing ${connection.displayName}?`, description: "This stops routing new messages to this agent.", confirmLabel: "Remove", variant: "destructive" })) return;
    setBusy(connection.id);
    setSocialSetupError(null);
    setError(null);
    try {
      await revokeAgentChannelConnection(installationId, channel.id);
      setAgentConnections((current) => current.filter((entry) => entry.id !== channel.id));
      setBindings((current) => current.filter((binding) => binding.channel_connection_id !== channel.id));
      setSocialSetupOpen(false);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : `Unable to remove ${integrationProviderLabel(connection.provider)} from this agent`;
      setSocialSetupError(message);
      setError(message);
    } finally {
      setBusy(null);
    }
  };

  const linkedConnections = workspaceConnections.filter((connection) => ["WHATSAPP", "FACEBOOK", "INSTAGRAM"].includes(connection.provider.toUpperCase()));
  const linkedGroups = ["WHATSAPP", "FACEBOOK", "INSTAGRAM"].map((provider) => ({
    provider,
    connections: linkedConnections.filter((connection) => connection.provider.toUpperCase() === provider),
  })).filter((group) => group.connections.length > 0);
  const websiteConfigured = websiteDeployments.some((deployment) => deployment.status !== "REVOKED");
  const websiteActive = websiteDeployments.some((deployment) => deployment.status === "ACTIVE");
  const websiteStatus = websiteActive ? "Active" : websiteConfigured ? "Configured" : "Configure";
  const telegramConnection = agentConnections.find((connection) => connection.channel_type === "telegram" && connection.status === "active");
  const discordConnection = agentConnections.find((connection) => connection.channel_type === "discord" && connection.status === "active");
  const openCatalogChannel = (integration: AgentIntegration) => {
    if (integration.channelType === "telegram") setTelegramSetupOpen(true);
    else if (integration.channelType === "discord") setDiscordSetupOpen(true);
    else if (integration.channelType === "whatsapp") {
      const workspaceConnection = linkedConnections.find((connection) => connection.status === "CONNECTED");
      if (personal && workspaceConnection) openWhatsAppSetup(workspaceConnection);
      else window.location.assign("/connections");
    }
  };

  return <div className="space-y-4">
    <Card>
      <CardContent className="space-y-4 p-6">
        <div><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Deployment</p><h2 className="mt-1 text-lg font-semibold text-foreground">Integrations</h2><p className="mt-1 text-sm text-muted-foreground">{personal ? "Connect this personal agent to private workspace channels." : "Assign workspace channels to this agent. Everyone who messages an assigned business number will reach this agent."}</p></div>
        {error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
        <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="text-sm font-semibold text-foreground">Connected accounts</h3><Link href="/connections" className="text-sm font-medium text-foreground underline-offset-4 hover:underline">Manage connections</Link></div>
        {loading ? <p className="text-sm text-muted-foreground">Loading…</p> : linkedGroups.length ? <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{linkedGroups.map((group) => {
          const Icon = integrationIcon(group.provider);
          const connectedCount = group.connections.filter((connection) => connection.status === "CONNECTED").length;
          return <div key={group.provider} className="rounded-xl border border-border p-4"><div className="flex items-start justify-between gap-3"><div className="flex items-center gap-3"><div className="rounded-lg border border-border bg-secondary p-2"><Icon className={`h-5 w-5 ${integrationIconColor(group.provider)}`} /></div><div><p className="font-medium text-foreground">{integrationProviderLabel(group.provider)}</p><p className="mt-0.5 text-xs text-muted-foreground">{connectedCount} connected {connectedCount === 1 ? "account" : "accounts"}</p></div></div><span className={`flex items-center gap-1.5 text-xs ${connectedCount ? "text-status-success" : "text-muted-foreground"}`}><span className={`h-1.5 w-1.5 rounded-full ${connectedCount ? "bg-status-success" : "bg-muted-foreground"}`} />{connectedCount ? "Active" : "Not connected"}</span></div><div className="mt-4 divide-y divide-border rounded-lg border border-border/70">{group.connections.map((connection) => {
            const channel = agentChannelFor(connection);
            const isWhatsApp = group.provider === "WHATSAPP";
            const isSocial = group.provider === "FACEBOOK" || group.provider === "INSTAGRAM";
            const paired = isWhatsApp && personal && (activeBindingFor(channel) || allowedWhatsappPhonesFor(channel).length > 0);
            const assigned = !personal && channel?.status === "active";
            const available = connection.status === "CONNECTED";
            return <div key={connection.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5"><div className="min-w-0"><p className="truncate text-sm text-foreground">{connection.displayName}</p>{connection.handle ? <p className="truncate text-xs text-muted-foreground">{connection.handle}</p> : null}<p className={`mt-0.5 text-[11px] ${available ? "text-status-success" : "text-status-warning"}`}>{available ? "Connected" : connection.status.replaceAll("_", " ").toLowerCase()}</p></div>{isWhatsApp && available ? personal ? paired ? <div className="flex items-center gap-2"><Button type="button" variant="outline" size="sm" className="h-7 shrink-0 px-2.5 text-xs" disabled={busy !== null} onClick={() => openWhatsAppSetup(connection)}>Manage</Button><Button type="button" variant="outline" size="sm" className="h-7 shrink-0 px-2.5 text-xs" disabled={busy !== null} onClick={() => void removeWhatsApp(connection, channel)}>{busy === connection.id ? "…" : "Release"}</Button></div> : <Button type="button" variant="outline" size="sm" className="h-7 shrink-0 px-2.5 text-xs" disabled={busy !== null} onClick={() => openWhatsAppSetup(connection)}>{channel ? "Configure" : "Use"}</Button> : assigned ? <div className="flex items-center gap-2"><span className="shrink-0 text-xs font-medium text-status-success">Assigned</span><Button type="button" variant="outline" size="sm" className="h-7 shrink-0 px-2.5 text-xs" disabled={busy !== null} onClick={() => void removeWhatsApp(connection, channel)}>{busy === connection.id ? "…" : "Remove"}</Button></div> : <Button type="button" variant="outline" size="sm" className="h-7 shrink-0 px-2.5 text-xs" disabled={busy !== null} onClick={() => void assignWhatsApp(connection)}>{busy === connection.id ? "…" : "Use for agent"}</Button> : isSocial ? personal ? <span className="shrink-0 text-xs text-muted-foreground">Customer agent only</span> : assigned ? <div className="flex items-center gap-2"><span className="shrink-0 text-xs font-medium text-status-success">Assigned</span><Button type="button" variant="outline" size="sm" className="h-7 shrink-0 px-2.5 text-xs" disabled={busy !== null} onClick={() => openSocialSetup(connection)}>Manage</Button><Button type="button" variant="outline" size="sm" className="h-7 shrink-0 px-2.5 text-xs" disabled={busy !== null} onClick={() => void removeSocial(connection, channel)}>{busy === connection.id ? "…" : "Remove"}</Button></div> : <Button type="button" variant="outline" size="sm" className="h-7 shrink-0 px-2.5 text-xs" disabled={busy !== null} onClick={() => openSocialSetup(connection)}>{available ? "Use" : "Check setup"}</Button> : <Link href="/connections" className="shrink-0 text-xs font-medium text-foreground underline-offset-4 hover:underline">Manage</Link>}</div>;
          })}</div></div>;
        })}</div> : <div className="rounded-lg border border-dashed border-border p-4"><p className="text-sm text-muted-foreground">No connected accounts yet.</p><Link href="/connections" className="mt-2 inline-flex text-sm font-medium text-foreground underline-offset-4 hover:underline">Open connections</Link></div>}
      </CardContent>
    </Card>
    <Card>
      <CardContent className="space-y-4 p-6"><div><h3 className="text-sm font-semibold text-foreground">Available integrations</h3><p className="mt-1 text-sm text-muted-foreground">More ways to deploy this agent.</p></div>{!personal ? <div role="button" tabIndex={0} onClick={openWebsiteChat} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openWebsiteChat(); } }} className="rounded-xl border border-border p-4 cursor-pointer transition-colors hover:border-primary/60 hover:bg-secondary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"><div className="flex items-start justify-between gap-3"><div className="rounded-lg border border-border bg-secondary p-2"><Globe2 className="h-5 w-5 text-[#06B6D4]" /></div><Badge className="border-border bg-secondary text-muted-foreground">{websiteStatus}</Badge></div><p className="mt-3 font-medium text-foreground">Website Chat</p><p className="mt-1 text-sm text-muted-foreground">Add this agent to any website.</p><span className="mt-3 inline-flex text-xs font-medium text-foreground">{websiteConfigured ? "Manage Website Chat" : "Configure Website Chat"}<span aria-hidden="true" className="ml-1">→</span></span></div> : null}<AgentToolIntegrations installationId={installationId} embedded refreshKey={agentConnections.map((connection) => `${connection.id}:${connection.status}`).join(",")} onChannelAction={openCatalogChannel} /></CardContent>
    </Card>
    <TelegramSetupDialog open={telegramSetupOpen} onOpenChange={setTelegramSetupOpen} installationId={installationId} personal={personal} existingConnection={telegramConnection} onConnected={() => void refresh()} onDisconnected={() => void refresh()} />
    <DiscordSetupDialog open={discordSetupOpen} onOpenChange={setDiscordSetupOpen} installationId={installationId} personal={personal} existingConnection={discordConnection} onConnected={() => void refresh()} onDisconnected={() => void refresh()} />
    {whatsappSetupConnection ? <WhatsAppAccessDialog open={whatsappSetupOpen} onOpenChange={setWhatsappSetupOpen} installationId={installationId} workspaceConnection={whatsappSetupConnection} existingConnection={agentChannelFor(whatsappSetupConnection)} onSaved={() => void refresh()} onDisconnected={() => void refresh()} /> : null}
    {socialSetupConnection ? <SocialAgentAccessDialog open={socialSetupOpen} onOpenChange={setSocialSetupOpen} personal={personal} workspaceConnection={socialSetupConnection} existingConnection={agentChannelFor(socialSetupConnection)} onAssign={() => void assignSocial(socialSetupConnection)} onRemove={() => void removeSocial(socialSetupConnection, agentChannelFor(socialSetupConnection))} busy={busy === socialSetupConnection.id} error={socialSetupError} /> : null}
    {!personal && websiteChatOpen ? <WebsiteChatDeployments agentId={agentId} installationId={installationId} agentName={agentName} onClose={() => { setWebsiteChatOpen(false); void refreshWebsiteDeployments(); }} /> : null}
  </div>;
}

function SocialAgentAccessDialog({ open, onOpenChange, personal, workspaceConnection, existingConnection, onAssign, onRemove, busy, error }: { open: boolean; onOpenChange: (open: boolean) => void; personal: boolean; workspaceConnection: WorkspaceConnection; existingConnection?: AgentChannelConnection; onAssign: () => void; onRemove: () => void; busy: boolean; error?: string | null }) {
  const provider = workspaceConnection.provider.toUpperCase();
  const providerLabel = integrationProviderLabel(provider);
  const connected = workspaceConnection.status === "CONNECTED";
  const credentialReady = ["ACTIVE", "CONNECTED", "VALID", "HEALTHY"].includes(workspaceConnection.credentialStatus.toUpperCase());
  const webhookReady = ["ACTIVE", "CONNECTED", "READY", "SUBSCRIBED"].includes(workspaceConnection.webhookStatus.toUpperCase());
  const assigned = existingConnection?.status === "active";

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-secondary"><IntegrationIcon provider={provider} className={`h-5 w-5 ${integrationIconColor(provider)}`} /></div>
        <DialogTitle>{providerLabel} access</DialogTitle>
        <DialogDescription>{workspaceConnection.displayName}{workspaceConnection.handle ? ` · ${workspaceConnection.handle}` : ""}</DialogDescription>
      </DialogHeader>
      <div className="mt-5 space-y-3">
        <div className="flex flex-wrap items-center gap-2"><Badge className={connected ? "border-status-success/30 bg-status-success/10 text-status-success" : "border-status-warning/30 bg-status-warning/10 text-status-warning"}>{connected ? "Workspace connected" : "Connection needs attention"}</Badge><Badge className={assigned ? "border-primary/30 bg-primary/10 text-primary" : "border-border bg-secondary text-muted-foreground"}>{assigned ? "Assigned to this agent" : "Not assigned"}</Badge></div>
        <div className="divide-y divide-border rounded-xl border border-border">
          <SocialAccessCheck label="Workspace connection" value={connected ? "Connected" : workspaceConnection.status.replaceAll("_", " ").toLowerCase()} tone={connected ? "success" : "warning"} />
          <SocialAccessCheck label="Credentials" value={credentialReady ? "Ready" : workspaceConnection.credentialStatus.replaceAll("_", " ").toLowerCase()} tone={credentialReady ? "success" : "warning"} />
          <SocialAccessCheck label="Message webhook" value={webhookReady ? "Ready" : workspaceConnection.webhookStatus.replaceAll("_", " ").toLowerCase() || "Pending"} tone={webhookReady ? "success" : "neutral"} />
        </div>
        {!connected ? <p className="rounded-lg bg-status-warning/10 px-3 py-2 text-sm text-status-warning">Reconnect this account in Connections before assigning it.</p> : null}
        {connected && !assigned ? <p className="text-sm text-muted-foreground">Text messages received by this {provider === "FACEBOOK" ? "Page" : "account"} will be routed to this agent.</p> : null}
        {assigned ? <p className="text-sm text-muted-foreground">This agent currently receives new text messages from this {provider === "FACEBOOK" ? "Page" : "account"}.</p> : null}
        {error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
      </div>
      <DialogFooter className="mt-6">
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
        {!connected ? <Button type="button" onClick={() => window.location.assign("/connections")}>Open connections</Button> : assigned ? <Button type="button" variant="destructive" disabled={busy} onClick={onRemove}>{busy ? "Removing…" : "Remove"}</Button> : personal ? <Button type="button" disabled>Customer agent only</Button> : <Button type="button" disabled={busy} onClick={onAssign}>{busy ? "Assigning…" : "Use for agent"}</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function SocialAccessCheck({ label, value, tone }: { label: string; value: string; tone: "success" | "warning" | "neutral" }) {
  const toneClass = tone === "success" ? "text-status-success" : tone === "warning" ? "text-status-warning" : "text-muted-foreground";
  return <div className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm"><span className="text-muted-foreground">{label}</span><span className={`capitalize ${toneClass}`}>{value}</span></div>;
}

const DEFAULT_WEBSITE_APPEARANCE: AgentWebsiteDeployment["appearance"] = {
  primaryColor: "#3730a3",
  launcherSize: 56,
  windowWidth: 390,
  windowHeight: 620,
  borderRadius: 16,
  launcherOffset: 16,
  showBranding: true,
};

function absoluteOrigin(value?: string | null) {
  try {
    const url = value ? new URL(value) : null;
    return url && (url.protocol === "http:" || url.protocol === "https:") ? url.origin : null;
  } catch {
    return null;
  }
}

function websiteEmbedCode(deployment: AgentWebsiteDeployment) {
  const embedSource = deployment.embedCode?.match(/\ssrc="([^"]+)"/)?.[1];
  if (deployment.embedCode && absoluteOrigin(embedSource)) return deployment.embedCode;

  const publicOrigin = absoluteOrigin(deployment.shareUrl);
  if (!publicOrigin) return null;
  return `<script async src="${publicOrigin}/api/widget/v1/loader.js" data-kasitek-deployment="${deployment.publicId}"></script>`;
}

function preserveWebsiteUrls(deployment: AgentWebsiteDeployment, previous?: AgentWebsiteDeployment) {
  return {
    ...deployment,
    embedCode: deployment.embedCode ?? previous?.embedCode,
    shareUrl: deployment.shareUrl ?? previous?.shareUrl,
  };
}

function websiteAppearance(deployment: AgentWebsiteDeployment) {
  return { ...DEFAULT_WEBSITE_APPEARANCE, ...(deployment.appearance || {}) };
}

function WebsiteChatDeployments({ agentId, installationId, agentName, onClose }: { agentId: string; installationId: string; agentName: string; onClose: () => void }) {
  const [deployments, setDeployments] = useState<AgentWebsiteDeployment[]>([]);
  const [origin, setOrigin] = useState("");
  const [selectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<AgentWebsiteDeployment | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [changingStatus, setChangingStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { confirm } = useConfirmationDialog();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const result = await listAgentWebsiteDeployments(installationId);
      setDeployments(result.deployments);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load Website Chat deployments");
    } finally {
      setLoading(false);
    }
  }, [installationId]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const createDeployment = async () => {
    if (!origin.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      const result = await createAgentWebsiteDeployment(installationId, {
        allowedOrigins: [origin.trim()],
        displayName: agentName,
        welcomeText: `Hi, I’m ${agentName}. How can I help?`,
      });
      setDeployments((current) => [{ ...result.deployment, embedCode: result.embedCode, shareUrl: result.shareUrl }, ...current]);
      setOrigin("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create Website Chat deployment");
    } finally {
      setCreating(false);
    }
  };

  const editDeployment = (deployment: AgentWebsiteDeployment) => {
    if (!deployment.id) return;
    window.location.assign(`/agents/${encodeURIComponent(agentId)}/appearance`);
  };

  const saveAppearance = async () => {
    if (!draft || saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await updateAgentWebsiteDeployment(installationId, draft.id, {
        displayName: draft.displayName || "",
        welcomeText: draft.welcomeText || "",
        launcherPosition: draft.launcherPosition,
        colorPreset: draft.colorPreset,
        appearance: draft.appearance,
      });
      setDeployments((current) => current.map((entry) => entry.id === draft.id ? preserveWebsiteUrls(result.deployment, entry) : entry));
      setDraft(preserveWebsiteUrls(result.deployment, draft));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save Website Chat appearance");
    } finally {
      setSaving(false);
    }
  };

  const changeStatus = async (deployment: AgentWebsiteDeployment, status: "ACTIVE" | "PAUSED" | "REVOKED") => {
    if (changingStatus || (status === "REVOKED" && !await confirm({ title: "Revoke Website Chat?", description: "Existing visitors will no longer be able to start a chat.", confirmLabel: "Revoke", variant: "destructive" }))) return;
    setChangingStatus(deployment.id);
    setError(null);
    try {
      const result = await setAgentWebsiteDeploymentStatus(installationId, deployment.id, status);
      setDeployments((current) => current.map((entry) => entry.id === deployment.id ? preserveWebsiteUrls(result.deployment, entry) : entry));
      if (draft?.id === deployment.id) setDraft(preserveWebsiteUrls(result.deployment, draft));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to update Website Chat status");
    } finally {
      setChangingStatus(null);
    }
  };

  const updateDraft = (changes: Partial<AgentWebsiteDeployment>) => setDraft((current) => current ? { ...current, ...changes } : current);
  const updateAppearance = (changes: Partial<AgentWebsiteDeployment["appearance"]>) => setDraft((current) => current ? { ...current, appearance: { ...websiteAppearance(current), ...changes } } : current);
  const preview = draft ? websiteAppearance(draft) : DEFAULT_WEBSITE_APPEARANCE;

  return <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
    <DialogContent className="flex max-h-[calc(100svh-2rem)] max-w-3xl flex-col overflow-hidden p-0">
      <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
        <DialogHeader><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Deployment</p><DialogTitle>Website Chat</DialogTitle></DialogHeader>
      </div>
      <div className="min-h-0 space-y-4 overflow-y-auto p-5 sm:p-6">
        {error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
        <div className="flex flex-col gap-2 sm:flex-row"><label className="sr-only" htmlFor="website-chat-origin">Website origin</label><Input id="website-chat-origin" value={origin} onChange={(event) => setOrigin(event.target.value)} placeholder="https://example.com" className="h-10 min-w-0 flex-1" /><Button type="button" disabled={!origin.trim() || creating} onClick={() => void createDeployment()}>{creating ? "Adding…" : "Add origin"}</Button></div>
        {loading ? <p className="text-sm text-muted-foreground">Loading…</p> : deployments.length ? <div className="space-y-3">{deployments.map((deployment) => {
          const embed = websiteEmbedCode(deployment);
          const shareUrl = deployment.shareUrl && absoluteOrigin(deployment.shareUrl) ? deployment.shareUrl : null;
          return <div key={deployment.id} className="rounded-xl border border-border p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0"><p className="font-medium text-foreground">{deployment.displayName || agentName}</p><p className="mt-1 truncate font-mono text-xs text-muted-foreground">{deployment.publicId}</p><p className="mt-2 text-xs text-muted-foreground">{deployment.allowedOrigins.join(", ")}</p></div>
              <div className="flex flex-wrap items-center gap-2"><Badge className="border-border bg-secondary text-muted-foreground">{deployment.status.toLowerCase()}</Badge><Button type="button" variant="outline" size="sm" onClick={() => editDeployment(deployment)}>Appearance</Button><Button type="button" variant="outline" size="sm" disabled={!embed} onClick={() => embed && void navigator.clipboard?.writeText(embed)}><Copy className="mr-1.5 h-3.5 w-3.5" />Copy embed</Button><Button type="button" variant="outline" size="sm" disabled={!shareUrl} onClick={() => shareUrl && void navigator.clipboard?.writeText(shareUrl)}>Copy share link</Button>{deployment.status === "ACTIVE" ? <Button type="button" variant="outline" size="sm" disabled={changingStatus === deployment.id} onClick={() => void changeStatus(deployment, "PAUSED")}>Pause</Button> : null}{deployment.status === "PAUSED" ? <Button type="button" variant="outline" size="sm" disabled={changingStatus === deployment.id} onClick={() => void changeStatus(deployment, "ACTIVE")}>Resume</Button> : null}{deployment.status !== "REVOKED" ? <Button type="button" variant="ghost" size="sm" disabled={changingStatus === deployment.id} onClick={() => void changeStatus(deployment, "REVOKED")}>Revoke</Button> : null}</div>
            </div>
            {selectedId === deployment.id && draft ? <div className="mt-4 grid gap-4 border-t border-border pt-4 lg:grid-cols-[1fr_220px]">
              <div className="space-y-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="text-xs font-medium text-muted-foreground">Title<Input value={draft.displayName || ""} onChange={(event) => updateDraft({ displayName: event.target.value })} className="mt-1 h-9" /></label>
                  <label className="text-xs font-medium text-muted-foreground">Launcher position
                    <Select value={draft.launcherPosition} onValueChange={(launcherPosition) => updateDraft({ launcherPosition: launcherPosition as AgentWebsiteDeployment["launcherPosition"] })}><SelectTrigger className="mt-1 h-9"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="bottom-right">Bottom right</SelectItem><SelectItem value="bottom-left">Bottom left</SelectItem></SelectContent></Select>
                  </label>
                </div>
                <label className="block text-xs font-medium text-muted-foreground">Welcome message<Textarea value={draft.welcomeText || ""} onChange={(event) => updateDraft({ welcomeText: event.target.value })} rows={2} className="mt-1 resize-y" /></label>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="text-xs font-medium text-muted-foreground">Theme
                    <Select value={draft.colorPreset} onValueChange={(colorPreset) => updateDraft({ colorPreset })}><SelectTrigger className="mt-1 h-9"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="indigo">Indigo</SelectItem><SelectItem value="violet">Violet</SelectItem><SelectItem value="emerald">Emerald</SelectItem><SelectItem value="blue">Blue</SelectItem><SelectItem value="slate">Slate</SelectItem></SelectContent></Select>
                  </label>
                  <label className="text-xs font-medium text-muted-foreground">Primary color<input type="color" value={preview.primaryColor} onChange={(event) => updateAppearance({ primaryColor: event.target.value })} className="mt-1 h-9 w-full rounded-md border border-input bg-background p-1" /></label>
                </div>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{([["launcherSize", "Launcher", 44, 96], ["windowWidth", "Width", 300, 600], ["windowHeight", "Height", 360, 800], ["borderRadius", "Radius", 0, 28]] as const).map(([field, label, min, max]) => <label key={field} className="text-xs font-medium text-muted-foreground">{label}<Input type="number" min={min} max={max} value={preview[field]} onChange={(event) => updateAppearance({ [field]: Number(event.target.value) })} className="mt-1 h-9 px-2" /></label>)}</div>
                <label className="flex items-center gap-2 text-sm text-foreground"><Checkbox checked={preview.showBranding} onCheckedChange={(showBranding) => updateAppearance({ showBranding: showBranding === true })} />Show KasiTek branding</label>
                <Button type="button" disabled={saving} onClick={() => void saveAppearance()}>{saving ? "Saving…" : "Save appearance"}</Button>
              </div>
              <div className="rounded-xl border border-border bg-secondary/30 p-3"><p className="mb-2 text-xs font-medium text-muted-foreground">Preview</p><div className="overflow-hidden border border-border bg-background shadow-sm" style={{ borderRadius: preview.borderRadius, width: "100%" }}><div className="px-3 py-2 text-sm font-semibold text-white" style={{ backgroundColor: preview.primaryColor }}>{draft.displayName || agentName}<span className="float-right">×</span></div><div className="min-h-28 space-y-2 p-3 text-xs"><div className="w-fit rounded-lg bg-secondary px-2 py-1">{draft.welcomeText || `Hi, I’m ${agentName}. How can I help?`}</div><div className="ml-auto w-fit rounded-lg px-2 py-1 text-white" style={{ backgroundColor: preview.primaryColor }}>What can you help with?</div></div><div className="border-t border-border p-2 text-center text-[10px] text-muted-foreground">{preview.showBranding ? "Powered by KasiTek" : ""}</div></div></div>
            </div> : null}
          </div>;
        })}</div> : <p className="text-sm text-muted-foreground">No origins added yet.</p>}
      </div>
    </DialogContent>
  </Dialog>;
}

function WhatsAppAccessDialog({ open, onOpenChange, installationId, workspaceConnection, existingConnection, onSaved, onDisconnected }: { open: boolean; onOpenChange: (open: boolean) => void; installationId: string; workspaceConnection: WorkspaceConnection; existingConnection?: AgentChannelConnection; onSaved?: () => void; onDisconnected?: () => void }) {
  const [allowedPhones, setAllowedPhones] = useState("");
  const [connection, setConnection] = useState<AgentChannelConnection | null>(existingConnection ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm } = useConfirmationDialog();

  useEffect(() => {
    if (!open) return;
    setConnection(existingConnection ?? null);
    const access = existingConnection?.metadata?.whatsappAccess;
    const configured = access && typeof access === "object" && Array.isArray((access as Record<string, unknown>).allowedPhones)
      ? ((access as Record<string, unknown>).allowedPhones as unknown[]).filter((value): value is string => typeof value === "string")
      : [];
    setAllowedPhones(configured.join(", "));
    setError(null);
  }, [existingConnection, open]);

  const normalizedAllowedPhones = () => [...new Set(allowedPhones.split(",").map((value) => value.trim().replace(/[\s().-]/g, "").replace(/^\+/, "").replace(/^00/, "")).filter((value) => /^\d{7,15}$/.test(value)))];

  const save = async () => {
    if (busy) return;
    const phones = normalizedAllowedPhones();
    if (!phones.length) {
      setError("Add at least one phone number in international format.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = connection
        ? await updateAgentChannelAllowedPhones(installationId, connection.id, phones)
        : await createAgentChannelConnection(installationId, {
          channelType: "whatsapp",
          channelKey: workspaceConnection.id,
          metadata: {
            configuredFrom: "agent-integrations",
            coreConnectionId: workspaceConnection.id,
            provider: "WHATSAPP",
            routing: "private",
            whatsappAccess: { allowedPhones: phones },
          },
        });
      setConnection(updated);
      setAllowedPhones(phones.join(", "));
      onSaved?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save WhatsApp access");
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!connection || busy || !await confirm({ title: "Release WhatsApp?", description: "This stops this personal agent from receiving messages from the allowed phones.", confirmLabel: "Release", variant: "destructive" })) return;
    setBusy(true);
    setError(null);
    try {
      await revokeAgentChannelConnection(installationId, connection.id);
      onDisconnected?.();
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to release WhatsApp");
    } finally {
      setBusy(false);
    }
  };

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="sm:max-w-md">
      <DialogHeader>
        <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl border border-[#25D366]/30 bg-[#25D366]/10"><SiWhatsapp className="h-5 w-5 text-[#25D366]" /></div>
        <DialogTitle>WhatsApp access</DialogTitle>
        <DialogDescription>{workspaceConnection.displayName}</DialogDescription>
      </DialogHeader>
      <div className="mt-5 space-y-4">
        <label className="text-sm font-medium text-foreground" htmlFor="whatsapp-allowed-phones">Allowed phone(s)<Input id="whatsapp-allowed-phones" value={allowedPhones} onChange={(event) => setAllowedPhones(event.target.value)} placeholder="27821234567" className="mt-2" /><span className="mt-1 block text-xs font-normal text-muted-foreground">Use international format without +. Separate multiple numbers with commas.</span></label>
        {error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
      </div>
      <DialogFooter className="mt-6"><Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>{connection ? <Button type="button" variant="destructive" disabled={busy} onClick={() => void disconnect()}>{busy ? "Releasing…" : "Release"}</Button> : null}<Button type="button" disabled={busy || !normalizedAllowedPhones().length} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</Button></DialogFooter>
    </DialogContent>
  </Dialog>;
}

function TelegramSetupDialog({ open, onOpenChange, installationId, personal, existingConnection, onConnected, onDisconnected }: { open: boolean; onOpenChange: (open: boolean) => void; installationId: string; personal: boolean; existingConnection?: AgentChannelConnection; onConnected?: () => void; onDisconnected?: () => void }) {
  const [botToken, setBotToken] = useState("");
  const [allowedUsers, setAllowedUsers] = useState("");
  const [connection, setConnection] = useState<AgentChannelConnection | null>(null);
  const [pairing, setPairing] = useState<{ token: string; expires_at: string; username?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [pairingLoading, setPairingLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm } = useConfirmationDialog();

  const reset = () => {
    setBotToken("");
    setAllowedUsers("");
    setConnection(null);
    setPairing(null);
    setBusy(false);
    setPairingLoading(false);
    setError(null);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) reset();
    onOpenChange(nextOpen);
  };

  const issuePairing = async (created: AgentChannelConnection) => {
    setPairingLoading(true);
    setError(null);
    try {
      const issued = await issueAgentChannelPairing(installationId, created.id);
      const telegram = created.metadata?.telegram;
      const username = telegram && typeof telegram === "object" && typeof (telegram as Record<string, unknown>).username === "string"
        ? telegram as Record<string, unknown>
        : undefined;
      setPairing({ ...issued, username: typeof username?.username === "string" ? username.username : undefined });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create the Telegram pairing link");
    } finally {
      setPairingLoading(false);
    }
  };

  useEffect(() => {
    if (!open || !existingConnection || connection) return;
    setConnection(existingConnection);
    const access = existingConnection.metadata?.telegramAccess;
    const configured = access && typeof access === "object" && Array.isArray((access as Record<string, unknown>).allowedUsers)
      ? ((access as Record<string, unknown>).allowedUsers as unknown[]).filter((value): value is string => typeof value === "string")
      : [];
    setAllowedUsers(configured.join(", "));
  }, [connection, existingConnection, open, personal]);

  const normalizedAllowedUsers = () => [...new Set(allowedUsers.split(",").map((value) => value.trim()).filter((value) => /^\d+$/.test(value)))];

  const saveAllowedUsers = async () => {
    if (!connection || busy) return;
    const users = normalizedAllowedUsers();
    if (!users.length) {
      setError("Add at least one Telegram user ID.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await updateAgentChannelAllowedUsers(installationId, connection.id, users);
      setConnection(updated);
      setAllowedUsers(users.join(", "));
      onConnected?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save Telegram allowed users");
    } finally {
      setBusy(false);
    }
  };

  const connect = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !botToken.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createAgentChannelConnection(installationId, {
        channelType: "telegram",
        credentialSecret: botToken.trim(),
        metadata: { configuredFrom: "telegram-setup-dialog", routing: personal ? "private" : "public", ...(personal ? { telegramAccess: { allowedUsers: normalizedAllowedUsers() } } : {}) },
      });
      setConnection(created);
      setBotToken("");
      onConnected?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to connect Telegram");
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!connection || busy || !await confirm({ title: "Disconnect Telegram?", description: "This removes the bot webhook and channel route.", confirmLabel: "Disconnect", variant: "destructive" })) return;
    setBusy(true);
    setError(null);
    try {
      await revokeAgentChannelConnection(installationId, connection.id);
      onDisconnected?.();
      handleOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to disconnect Telegram");
    } finally {
      setBusy(false);
    }
  };

  const botUsername = connection?.metadata?.telegram && typeof connection.metadata.telegram === "object" && typeof (connection.metadata.telegram as Record<string, unknown>).username === "string"
    ? (connection.metadata.telegram as Record<string, unknown>).username as string
    : undefined;
  return <Dialog open={open} onOpenChange={handleOpenChange}>
    <DialogContent className="sm:max-w-md">
      {!connection ? <form onSubmit={(event) => void connect(event)}>
        <DialogHeader>
          <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl border border-[#229ED9]/30 bg-[#229ED9]/10"><SiTelegram className="h-5 w-5 text-[#229ED9]" /></div>
          <DialogTitle>Connect Telegram</DialogTitle>
          <DialogDescription>{personal ? "Connect your Telegram bot and restrict it to your Telegram user ID." : "Connect a Telegram bot for customer conversations."}</DialogDescription>
        </DialogHeader>
        <div className="mt-5 space-y-4">
          <div className="rounded-lg border border-border bg-secondary/30 p-3 text-sm text-muted-foreground">Create or open your bot in <a className="font-medium text-foreground underline underline-offset-4" href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a>, then paste its token here.</div>
          <label className="text-sm font-medium text-foreground" htmlFor="telegram-bot-token">Bot token<Input id="telegram-bot-token" type="password" value={botToken} onChange={(event) => setBotToken(event.target.value)} placeholder="123456:ABC…" className="mt-2" autoComplete="off" autoFocus /></label>
          {personal ? <label className="text-sm font-medium text-foreground" htmlFor="telegram-allowed-users">Allowed user ID<Input id="telegram-allowed-users" value={allowedUsers} onChange={(event) => setAllowedUsers(event.target.value)} placeholder="123456789" className="mt-2" /><span className="mt-1 block text-xs font-normal text-muted-foreground">Use your numeric ID from @userinfobot. Separate multiple IDs with commas.</span></label> : null}
          <p className="text-xs text-muted-foreground">The token is encrypted and will not be shown again.</p>
          {error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
        </div>
        <DialogFooter className="mt-6">
          <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>Cancel</Button>
          <Button type="submit" disabled={busy || !botToken.trim() || (personal && !normalizedAllowedUsers().length)}>{busy ? "Connecting…" : "Connect Telegram"}</Button>
        </DialogFooter>
      </form> : <>
        <DialogHeader>
          <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl border border-status-success/30 bg-status-success-soft"><CheckCircle2 className="h-5 w-5 text-status-success" /></div>
          <DialogTitle>Telegram connected</DialogTitle>
          <DialogDescription>{botUsername ? `@${botUsername} is connected to this agent.` : "Your Telegram bot is connected to this agent."}</DialogDescription>
        </DialogHeader>
        {personal ? <div className="mt-5 space-y-3"><label className="text-sm font-medium text-foreground" htmlFor="telegram-existing-allowed-users">Allowed user IDs<Input id="telegram-existing-allowed-users" value={allowedUsers} onChange={(event) => setAllowedUsers(event.target.value)} placeholder="123456789" className="mt-2" /><span className="mt-1 block text-xs font-normal text-muted-foreground">Only these Telegram users can reach this personal agent.</span></label><div className="flex flex-wrap gap-2"><Button type="button" onClick={() => void saveAllowedUsers()} disabled={busy || !normalizedAllowedUsers().length}>{busy ? "Saving…" : "Save allowed users"}</Button>{!allowedUsers.trim() ? <Button type="button" variant="outline" onClick={() => void issuePairing(connection)} disabled={pairingLoading}>{pairingLoading ? "Preparing…" : "Generate pairing code"}</Button> : null}</div>{pairing ? <div className="rounded-lg border border-status-attention/40 bg-status-attention-soft p-3"><p className="text-sm font-medium text-foreground">Temporary pairing code</p><p className="mt-1 text-xs text-muted-foreground">Use this only as a fallback. Expires {new Date(pairing.expires_at).toLocaleString()}.</p><div className="mt-2"><TelegramPairingActions username={pairing.username} token={pairing.token} /></div></div> : null}</div> : <div className="mt-5 rounded-lg border border-status-success/30 bg-status-success-soft/40 p-3 text-sm text-muted-foreground">Customer messages sent to this bot will be routed to this agent.</div>}
        {error ? <p className="mt-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
        <DialogFooter className="mt-6"><Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>Close</Button><Button type="button" variant="destructive" disabled={busy} onClick={() => void disconnect()}>{busy ? "Disconnecting…" : "Disconnect"}</Button></DialogFooter>
      </>}
    </DialogContent>
  </Dialog>;
}

function DiscordSetupDialog({ open, onOpenChange, installationId, personal, existingConnection, onConnected, onDisconnected }: { open: boolean; onOpenChange: (open: boolean) => void; installationId: string; personal: boolean; existingConnection?: AgentChannelConnection; onConnected?: () => void; onDisconnected?: () => void }) {
  const [botToken, setBotToken] = useState("");
  const [allowedUsers, setAllowedUsers] = useState("");
  const [allowedChannels, setAllowedChannels] = useState("");
  const [requireMention, setRequireMention] = useState(true);
  const [connection, setConnection] = useState<AgentChannelConnection | null>(null);
  const [pairing, setPairing] = useState<{ token: string; expires_at: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm } = useConfirmationDialog();

  const reset = () => {
    setBotToken("");
    setAllowedUsers("");
    setAllowedChannels("");
    setRequireMention(true);
    setConnection(null);
    setPairing(null);
    setBusy(false);
    setError(null);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) reset();
    onOpenChange(nextOpen);
  };

  const issuePairing = async (created: AgentChannelConnection) => {
    try {
      setPairing(await issueAgentChannelPairing(installationId, created.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create Discord pairing code");
    }
  };

  useEffect(() => {
    if (!open || !existingConnection || connection) return;
    setConnection(existingConnection);
    if (personal) void issuePairing(existingConnection);
  }, [connection, existingConnection, open, personal]);

  const connect = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !botToken.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createAgentChannelConnection(installationId, {
        channelType: "discord",
        credentialSecret: botToken.trim(),
        metadata: {
          configuredFrom: "discord-setup-dialog",
          routing: personal ? "private" : "public",
          discordAccess: { allowedUsers: allowedUsers.trim(), allowedChannels: allowedChannels.trim(), requireMention },
        },
      });
      setConnection(created);
      setBotToken("");
      onConnected?.();
      if (personal) await issuePairing(created);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to connect Discord");
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!connection || busy || !await confirm({ title: "Disconnect Discord?", description: "This removes the bot route.", confirmLabel: "Disconnect", variant: "destructive" })) return;
    setBusy(true);
    setError(null);
    try {
      await revokeAgentChannelConnection(installationId, connection.id);
      onDisconnected?.();
      handleOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to disconnect Discord");
    } finally {
      setBusy(false);
    }
  };

  const discordMetadata = connection?.metadata?.discord && typeof connection.metadata.discord === "object" ? connection.metadata.discord as Record<string, unknown> : {};
  const botName = typeof discordMetadata.globalName === "string" ? discordMetadata.globalName : typeof discordMetadata.username === "string" ? discordMetadata.username : "Discord bot";
  return <Dialog open={open} onOpenChange={handleOpenChange}>
    <DialogContent className="sm:max-w-md">
      {!connection ? <form onSubmit={(event) => void connect(event)}>
        <DialogHeader>
          <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl border border-[#5865F2]/30 bg-[#5865F2]/10"><SiDiscord className="h-5 w-5 text-[#5865F2]" /></div>
          <DialogTitle>Connect Discord</DialogTitle>
          <DialogDescription>{personal ? "Connect a Discord bot, then pair your account." : "Connect a Discord bot for agent conversations."}</DialogDescription>
        </DialogHeader>
        <div className="mt-5 space-y-4">
          <label className="text-sm font-medium text-foreground" htmlFor="discord-bot-token">Bot token<Input id="discord-bot-token" type="password" value={botToken} onChange={(event) => setBotToken(event.target.value)} placeholder="Bot token" className="mt-2" autoComplete="off" autoFocus /></label>
          <div className="grid gap-3 sm:grid-cols-2"><label className="text-sm font-medium text-foreground">Allowed users<Input value={allowedUsers} onChange={(event) => setAllowedUsers(event.target.value)} placeholder="User IDs" className="mt-2" /></label><label className="text-sm font-medium text-foreground">Allowed server channels<Input value={allowedChannels} onChange={(event) => setAllowedChannels(event.target.value)} placeholder="Channel IDs" className="mt-2" /></label></div>
          <label className="flex items-center gap-2 text-sm text-foreground"><Checkbox checked={requireMention} onCheckedChange={(checked) => setRequireMention(checked === true)} />Require @mention in servers</label>
          <p className="text-xs text-muted-foreground">Empty channel IDs keeps server traffic closed. Enable Message Content Intent for the bot.</p>
          {error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
        </div>
        <DialogFooter className="mt-6"><Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>Cancel</Button><Button type="submit" disabled={busy || !botToken.trim()}>{busy ? "Connecting…" : "Connect Discord"}</Button></DialogFooter>
      </form> : <>
        <DialogHeader><div className="mb-2 flex h-10 w-10 items-center justify-center rounded-xl border border-status-success/30 bg-status-success-soft"><CheckCircle2 className="h-5 w-5 text-status-success" /></div><DialogTitle>Discord connected</DialogTitle><DialogDescription>{botName} is connected to this agent.</DialogDescription></DialogHeader>
        {personal ? pairing ? <div className="mt-5 space-y-2"><p className="text-sm font-medium text-foreground">Send this code in a Discord DM</p><code className="block overflow-x-auto rounded-lg border border-border bg-secondary p-3 text-xs text-foreground">{pairing.token}</code><p className="text-xs text-muted-foreground">Expires {new Date(pairing.expires_at).toLocaleString()}.</p></div> : <p className="mt-5 text-sm text-muted-foreground">Preparing pairing code…</p> : <div className="mt-5 rounded-lg border border-status-success/30 bg-status-success-soft/40 p-3 text-sm text-muted-foreground">Messages sent to this bot will be routed to this agent.</div>}
        {error ? <p className="mt-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
        <DialogFooter className="mt-6"><Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>Close</Button><Button type="button" variant="destructive" disabled={busy} onClick={() => void disconnect()}>{busy ? "Disconnecting…" : "Disconnect"}</Button></DialogFooter>
      </>}
    </DialogContent>
  </Dialog>;
}

function InstallationChannels({ installationId, personal }: { installationId: string; personal: boolean }) {
  const [connections, setConnections] = useState<AgentChannelConnection[]>([]);
  const [bindings, setBindings] = useState<AgentChannelBinding[]>([]);
  const [channelType, setChannelType] = useState("telegram");
  const [channelKey, setChannelKey] = useState("");
  const [credentialReference, setCredentialReference] = useState("");
  const [botToken, setBotToken] = useState("");
  const [pairing, setPairing] = useState<{ token: string; expires_at: string; username?: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { confirm } = useConfirmationDialog();
  const isTelegram = channelType === "telegram";
  const isDiscord = channelType === "discord";
  const isBotChannel = isTelegram || isDiscord;
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await listKasiAiChannels(installationId);
      setConnections(response.connections);
      setBindings(response.bindings);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load agent channels");
    } finally {
      setLoading(false);
    }
  }, [installationId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const preparePairing = async (connection: AgentChannelConnection) => {
    setPairing(null);
    setError(null);
    try {
      const issued = await issueAgentChannelPairing(installationId, connection.id);
      const telegram = connection.metadata?.telegram;
      const username = telegram && typeof telegram === "object" && typeof (telegram as Record<string, unknown>).username === "string"
        ? (telegram as Record<string, unknown>).username as string
        : undefined;
      setPairing({ ...issued, username });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create Telegram pairing");
    }
  };

  const createConnection = async () => {
    if (busy) return;
    if (isBotChannel ? !botToken.trim() && !credentialReference.trim() : !channelKey.trim()) return;
    setBusy("create");
    setError(null);
    try {
      const connection = await createAgentChannelConnection(installationId, {
        channelType,
        ...(channelKey.trim() ? { channelKey: channelKey.trim() } : {}),
        ...(credentialReference.trim() ? { credentialReference: credentialReference.trim() } : {}),
        ...(isBotChannel && botToken.trim() ? { credentialSecret: botToken.trim() } : {}),
        metadata: { configuredFrom: "agent-detail", routing: personal ? "private" : "public" },
      });
      setConnections((current) => [connection, ...current.filter((entry) => entry.id !== connection.id)]);
      setChannelKey("");
      setCredentialReference("");
      setBotToken("");
      if (personal && isTelegram) await preparePairing(connection);
      else setPairing(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to register channel connection");
    } finally {
      setBusy(null);
    }
  };

  const issuePairing = async (connection: AgentChannelConnection) => {
    if (busy) return;
    setBusy(`pair:${connection.id}`);
    try {
      await preparePairing(connection);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to issue pairing token");
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (binding: AgentChannelBinding) => {
    if (busy || !await confirm({ title: `Disconnect ${binding.external_identity}?`, confirmLabel: "Disconnect", variant: "destructive" })) return;
    setBusy(binding.id);
    try {
      await disconnectKasiAiChannel(binding.id);
      setBindings((current) => current.map((entry) => entry.id === binding.id ? { ...entry, status: "revoked" } : entry));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to disconnect channel");
    } finally {
      setBusy(null);
    }
  };

  const disconnectConnection = async (connection: AgentChannelConnection) => {
    if (busy || !await confirm({ title: connection.channel_type === "telegram" ? "Disconnect Telegram?" : "Disconnect channel?", description: connection.channel_type === "telegram" ? "This removes the bot webhook and channel route." : "This removes the channel route.", confirmLabel: "Disconnect", variant: "destructive" })) return;
    setBusy(`disconnect:${connection.id}`);
    setError(null);
    try {
      await revokeAgentChannelConnection(installationId, connection.id);
      setConnections((current) => current.filter((entry) => entry.id !== connection.id));
      setBindings((current) => current.filter((entry) => entry.channel_connection_id !== connection.id));
      setPairing(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to disconnect channel");
    } finally {
      setBusy(null);
    }
  };

  const telegramMetadata = (connection: AgentChannelConnection) => {
    const value = connection.metadata?.telegram;
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
  };

  return <Card>
    <CardContent className="space-y-4 p-6">
      <div><h2 className="text-lg font-semibold text-foreground">Connected channels</h2><p className="mt-1 text-sm text-muted-foreground">{isTelegram ? (personal ? "One paired Telegram identity." : "One bot for multiple customer conversations.") : "Connect a supported provider channel."}</p></div>
      {error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
      <div className="grid gap-3 rounded-xl border border-border bg-secondary/20 p-4 sm:grid-cols-[0.7fr_1fr_1fr_auto] sm:items-end">
        <label className="text-xs font-medium text-foreground">Channel type<Select value={channelType} onValueChange={(value) => { setChannelType(value); setBotToken(""); setChannelKey(""); setCredentialReference(""); }}><SelectTrigger className="mt-1"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="telegram">Telegram</SelectItem><SelectItem value="discord">Discord</SelectItem><SelectItem value="whatsapp">WhatsApp</SelectItem><SelectItem value="webhook">Webhook</SelectItem></SelectContent></Select></label>
        {isBotChannel ? <label className="text-xs font-medium text-foreground sm:col-span-2">{isTelegram ? "Bot token from @BotFather" : "Discord bot token"}<Input type="password" value={botToken} onChange={(event) => setBotToken(event.target.value)} placeholder={isTelegram ? "123456:ABC…" : "Bot token"} className="mt-1" autoComplete="off" /></label> : <><label className="text-xs font-medium text-foreground">Channel key<Input value={channelKey} onChange={(event) => setChannelKey(event.target.value)} placeholder="bot or provider key" className="mt-1" /></label><label className="text-xs font-medium text-foreground">Credential reference<Input value={credentialReference} onChange={(event) => setCredentialReference(event.target.value)} placeholder="vault reference" className="mt-1" /></label></>}
        <Button type="button" size="sm" disabled={busy !== null || (isBotChannel ? !botToken.trim() && !credentialReference.trim() : !channelKey.trim())} onClick={() => void createConnection()}>{busy === "create" ? "Connecting…" : isTelegram ? "Connect Telegram" : isDiscord ? "Connect Discord" : "Register channel"}</Button>
      </div>
      {isBotChannel ? <p className="text-xs text-muted-foreground">The token is encrypted and is not shown again.</p> : null}
      {personal && pairing ? <div className="rounded-xl border border-status-attention/40 bg-status-attention-soft p-4" role="alert"><p className="text-sm font-semibold text-status-attention">Pair this Telegram account</p><p className="mt-1 text-xs text-muted-foreground">Choose one of these options. Expires {new Date(pairing.expires_at).toLocaleString()}.</p><TelegramPairingActions username={pairing.username} token={pairing.token} /></div> : null}
      {loading ? <p className="text-sm text-muted-foreground">Loading channels…</p> : connections.length ? <div className="space-y-2">{connections.map((connection: AgentChannelConnection) => { const metadata = telegramMetadata(connection); const username = typeof metadata.username === "string" ? `@${metadata.username}` : `Bot ${metadata.botId ?? connection.channel_key}`; const webhook = connection.metadata?.webhook && typeof connection.metadata.webhook === "object" ? connection.metadata.webhook as Record<string, unknown> : {}; const label = connection.channel_type === "telegram" ? username : `${connection.channel_type} · ${connection.channel_key}`; return <div key={connection.id} className="rounded-lg border border-border p-3"><div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-medium capitalize text-foreground">{label}</p><p className="mt-1 text-xs text-muted-foreground">{connection.status}{connection.channel_type === "telegram" ? ` · webhook ${typeof webhook.status === "string" ? webhook.status : "pending"}` : ""}</p></div><div className="flex flex-wrap gap-2"><Badge className="border-border bg-secondary text-muted-foreground">{personal ? "personal" : "business"}</Badge>{personal ? <Button type="button" variant="outline" size="sm" disabled={busy !== null || connection.status !== "active"} onClick={() => void issuePairing(connection)}>{busy === `pair:${connection.id}` ? "Issuing…" : "Issue pairing"}</Button> : null}<Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => void disconnectConnection(connection)}>{busy === `disconnect:${connection.id}` ? "Disconnecting…" : "Disconnect"}</Button></div></div></div>; })}{personal ? bindings.map((binding: AgentChannelBinding) => <div key={binding.id} className="flex items-center justify-between gap-3 rounded-lg border border-border p-3"><div><p className="font-medium text-foreground">{binding.external_identity}</p><p className="mt-1 text-xs text-muted-foreground">{binding.channel_type} · {binding.status}</p></div>{binding.status === "active" ? <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => void disconnect(binding)}>{busy === binding.id ? "Disconnecting…" : "Disconnect"}</Button> : null}</div>) : null}</div> : <p className="text-sm text-muted-foreground">No channels connected.</p>}
    </CardContent>
  </Card>;
}
