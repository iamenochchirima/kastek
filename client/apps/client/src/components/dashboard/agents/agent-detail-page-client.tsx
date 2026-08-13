"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Archive, ArrowLeft, CheckCircle2, Copy, History, KeyRound, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { AgentWorkflowEditor, type WorkflowGraphValue } from "./agent-workflow-editor";
import {
  archiveAgent,
  setAgentInstallationStatus,
  publishAgentVersion,
  createAgentVersion,
  rollbackAgentVersion,
  retireAgentVersion,
  updateAgentInstallationSettings,
  getPlatformConversation,
  resolvePlatformConversation,
  sendPlatformMessage,
  streamAgentRun,
  createAgentInstallationCredential,
  listAgentInstallationCredentials,
  revokeAgentInstallationCredential,
  rotateAgentInstallationCredential,
  type AgentInstallationCredential,
  grantAgentInstallationTool,
  listAgentInstallationCapabilities,
  type AgentCapability,
  listAgentInstallationGrants,
  grantAgentInstallationResource,
  listAgentConnectors,
  listAgentInstallationConnectors,
  grantAgentInstallationConnector,
  type AgentConnector,
  listAgentInstallationRuns,
  type AgentInstallationRun,
  listAgentInstallationSchedules,
  createAgentInstallationSchedule,
  setAgentScheduleStatus,
  type AgentSchedule,
  listAgentKnowledgeSources,
  createAgentKnowledgeSource,
  ingestAgentKnowledgeSourceUrl,
  deleteAgentKnowledgeSource,
  listAgentMemory,
  deleteAgentMemory,
  revalidateAgentMemory,
  type AgentKnowledgeSource,
  type AgentMemory,
  listKasiAiChannels,
  createAgentChannelConnection,
  issueAgentChannelPairing,
  disconnectKasiAiChannel,
  type AgentChannelConnection,
  type AgentChannelBinding,
  type AgentDefinition,
  type AgentVersion,
  type AgentMessage,
  type AgentConversation,
} from "@/lib/agent-platform";

function versionStatusClass(status: string) {
  if (status === "published") return "border-accent/30 bg-accent/10 text-accent";
  if (status === "draft") return "border-status-attention/30 bg-status-attention-soft text-status-attention";
  return "border-border bg-secondary text-muted-foreground";
}

export function AgentDetailPageClient({ agent, initialVersions }: { agent: AgentDefinition; initialVersions: AgentVersion[] }) {
  const router = useRouter();
  const [versions, setVersions] = useState(initialVersions);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  const [instructions, setInstructions] = useState(baseVersion?.instructions ?? "");
  const [modelProvider, setModelProvider] = useState(String(basePrimary.provider ?? baseConfiguration.provider ?? "openrouter"));
  const [model, setModel] = useState(String(basePrimary.model ?? baseConfiguration.model ?? "openai/gpt-oss-20b:free"));
  const [maxTokensPerRun, setMaxTokensPerRun] = useState(String(basePolicy.maxTokensPerRun ?? baseConfiguration.maxTotalTokens ?? 4096));
  const [creatingVersion, setCreatingVersion] = useState(false);
  const [workflow, setWorkflow] = useState<WorkflowGraphValue | null>(null);
  const [workflowValid, setWorkflowValid] = useState(true);
  const [workflowReady, setWorkflowReady] = useState(false);
  const protectedAgent = agent.protected;

  const handleWorkflowChange = useCallback((next: WorkflowGraphValue | null) => {
    setWorkflow(next);
    setWorkflowReady(true);
  }, []);

  const handleWorkflowValidity = useCallback((valid: boolean) => {
    setWorkflowValid(valid);
    setWorkflowReady(true);
  }, []);

  const runWorkflowTest = useCallback(async (message: string) => {
    if (!agent.installation_id) throw new Error("This agent has no installation to test.");
    if (installationStatus !== "active") throw new Error("Resume the installation before testing it.");
    return sendPlatformMessage(agent.installation_id, {
      message,
      idempotencyKey: crypto.randomUUID(),
      createNew: true,
      context: { route: window.location.pathname, pageTitle: `${agent.name} workflow test` },
    });
  }, [agent.installation_id, agent.name, installationStatus]);

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
      if (action === "archive") router.push("/agents");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Agent operation failed");
    } finally {
      setBusy(null);
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
    setCreatingVersion(true);
    setError(null);
    try {
      const parsedMaxTokens = Number(maxTokensPerRun);
      if (!Number.isSafeInteger(parsedMaxTokens) || parsedMaxTokens < 256 || parsedMaxTokens > 1_000_000) throw new Error("Max tokens per run must be between 256 and 1,000,000");
      const created = await createAgentVersion(agent.id, {
        instructions: instructions.trim(),
        configuration: { provider: modelProvider, model: model.trim(), maxIterations: 8, maxToolCalls: 8, maxTotalTokens: parsedMaxTokens, maxContextMessages: 30, maxContextTokens: 12_000, ...(workflow ? { workflow } : {}) },
        policy: { modelPolicy: { version: "hosted-agent-v1", primary: { provider: modelProvider, model: model.trim() }, fallback: [], allowUserFundedFallbackToKasiTek: false, maxTokensPerRun: parsedMaxTokens } },
      });
      setVersions((current) => [created, ...current]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create agent version");
    } finally {
      setCreatingVersion(false);
    }
  };

  return (
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1100px] space-y-6">
        <Link href="/agents" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" />Back to agents</Link>
        <Card>
          <CardContent className="space-y-5 p-6">
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
              <div className="flex items-start gap-3">
                <div className="grid h-11 w-11 place-items-center rounded-full bg-primary/10 text-primary">{protectedAgent ? <Sparkles className="h-5 w-5" /> : <History className="h-5 w-5" />}</div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Agent details</p>
                  <h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">{agent.name}</h1>
                  <p className="mt-1 text-sm leading-6 text-muted-foreground">{agent.description || "Installed Agent Platform agent"}</p>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">{agent.installation_id && installationStatus !== "disabled" ? <Button type="button" variant="outline" disabled={busy !== null} onClick={() => void toggleInstallation()}>{busy === "installation-status" ? "Updating…" : installationStatus === "active" ? "Pause installation" : "Resume installation"}</Button> : null}{protectedAgent ? <Badge className="w-fit border-primary/20 bg-primary/10 text-primary">Protected system agent</Badge> : <Button type="button" variant="outline" disabled={busy === "archive"} onClick={() => void mutate("archive", () => archiveAgent(agent.id))}><Archive className="mr-2 h-4 w-4" />{busy === "archive" ? "Archiving…" : "Archive agent"}</Button>}</div>
            </div>
            <div className="grid gap-3 text-sm sm:grid-cols-3">
              <div className="rounded-lg bg-secondary/50 p-3"><p className="text-xs text-muted-foreground">Slug</p><p className="mt-1 font-medium text-foreground">{agent.slug}</p></div>
              <div className="rounded-lg bg-secondary/50 p-3"><p className="text-xs text-muted-foreground">Installation</p><p className="mt-1 font-medium capitalize text-foreground">{installationStatus.replaceAll("_", " ")}</p></div>
              <div className="rounded-lg bg-secondary/50 p-3"><p className="text-xs text-muted-foreground">Current version</p><p className="mt-1 font-medium text-foreground">{agent.version_number ? `v${agent.version_number}` : "None published"}</p></div>
            </div>
            {protectedAgent ? <p className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-sm text-muted-foreground">KasiAi instructions, model policy, and version publishing are controlled by KasiTek releases. Workspace members can use and pause its installation, but cannot mutate the protected definition.</p> : null}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-4 p-6">
            <div><h2 className="text-lg font-semibold text-foreground">Workspace preferences</h2><p className="mt-1 text-sm text-muted-foreground">These settings affect this workspace installation only. Protected instructions and tool policy remain unchanged.</p></div>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="text-sm font-medium text-foreground">Response tone<select value={tone} onChange={(event) => setTone(event.target.value)} className="mt-2 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"><option value="concise">Concise</option><option value="balanced">Balanced</option><option value="detailed">Detailed</option></select></label>
              <label className="text-sm font-medium text-foreground">Response detail<select value={responseDetail} onChange={(event) => setResponseDetail(event.target.value)} className="mt-2 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"><option value="concise">Concise</option><option value="standard">Standard</option><option value="detailed">Detailed</option></select></label>
              <label className="text-sm font-medium text-foreground">Language<input value={language} onChange={(event) => setLanguage(event.target.value)} maxLength={20} placeholder="en" className="mt-2 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" /></label>
            </div>
            <label className="flex items-center gap-2 text-sm text-muted-foreground"><input type="checkbox" checked={notificationsEnabled} onChange={(event) => setNotificationsEnabled(event.target.checked)} />Send run and approval notifications for this installation</label><Button type="button" onClick={() => void saveSettings()} disabled={!agent.installation_id || savingSettings}>{savingSettings ? "Saving…" : "Save preferences"}</Button>
          </CardContent>
        </Card>

        {agent.installation_id ? <InstallationCredentials installationId={agent.installation_id} /> : null}

        {agent.installation_id ? <InstallationCapabilities installationId={agent.installation_id} /> : null}

        {agent.installation_id ? <InstallationAccessScope installationId={agent.installation_id} /> : null}

        {agent.installation_id ? <InstallationKnowledge agentId={agent.id} installationId={agent.installation_id} /> : null}

        {agent.installation_id ? <InstallationSchedules installationId={agent.installation_id} /> : null}

        {agent.installation_id ? <InstallationRuns installationId={agent.installation_id} /> : null}

        {agent.installation_id ? <InstallationChannels installationId={agent.installation_id} /> : null}

        {agent.installation_id ? <AgentTestChat installationId={agent.installation_id} active={agent.installation_status === "active"} /> : null}

        {!protectedAgent ? <AgentWorkflowEditor configuration={baseConfiguration} onChange={handleWorkflowChange} onValidityChange={handleWorkflowValidity} onTestRun={agent.installation_id && installationStatus === "active" ? runWorkflowTest : undefined} /> : null}

        {!protectedAgent ? <Card><CardContent className="space-y-4 p-6"><div><h2 className="text-lg font-semibold text-foreground">Create a draft version</h2><p className="mt-1 text-sm text-muted-foreground">Drafts are immutable after creation. Publish the new version from the version history once you are ready.</p></div><div className="rounded-xl border border-border bg-secondary/20 p-4"><h3 className="text-sm font-semibold text-foreground">Model policy</h3><div className="mt-3 grid gap-3 sm:grid-cols-[0.65fr_1.35fr_0.7fr]"><label className="text-xs font-medium text-foreground">Provider<select value={modelProvider} onChange={(event) => setModelProvider(event.target.value)} className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"><option value="openrouter">OpenRouter</option><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="gemini">Gemini</option></select></label><label className="text-xs font-medium text-foreground">Model<input value={model} onChange={(event) => setModel(event.target.value)} className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" /></label><label className="text-xs font-medium text-foreground">Max tokens<input value={maxTokensPerRun} onChange={(event) => setMaxTokensPerRun(event.target.value)} inputMode="numeric" className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" /></label></div></div><textarea value={instructions} onChange={(event) => setInstructions(event.target.value)} rows={8} maxLength={200000} className="block w-full resize-y rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm leading-6" aria-label="Agent instructions" /><div className="flex items-center justify-between gap-3"><p className="text-xs text-muted-foreground">The draft will include the current workflow graph and model policy.</p><Button type="button" disabled={creatingVersion || !instructions.trim() || !model.trim() || !workflowReady || !workflowValid || !workflow} onClick={() => void createVersion()}>{creatingVersion ? "Creating draft…" : "Create draft version"}</Button></div></CardContent></Card> : null}

        <section className="space-y-3" aria-labelledby="agent-versions-title">
          <div><h2 id="agent-versions-title" className="text-lg font-semibold text-foreground">Version history</h2><p className="text-sm text-muted-foreground">Published versions are immutable. Drafts can be published; retired versions can be rolled back.</p></div>
          {error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
          {!versions.length ? <Card><CardContent className="p-6 text-sm text-muted-foreground">No versions are available for this agent.</CardContent></Card> : versions.map((version) => (
            <Card key={version.id}><CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
              <div><div className="flex items-center gap-2"><h3 className="font-semibold text-foreground">Version {version.version_number}</h3><Badge className={versionStatusClass(version.status)}>{version.status}</Badge>{version.status === "published" ? <CheckCircle2 className="h-4 w-4 text-accent" aria-label="Published" /> : null}</div><p className="mt-1 text-xs text-muted-foreground">Created {new Date(version.created_at).toLocaleString()}{version.published_at ? ` · Published ${new Date(version.published_at).toLocaleString()}` : ""}</p></div>
              {!protectedAgent ? <div className="flex flex-wrap gap-2">
                {version.status === "draft" ? <Button type="button" size="sm" disabled={busy !== null} onClick={() => void mutate(`publish:${version.id}`, () => publishAgentVersion(agent.id, version.id))}>Publish</Button> : null}
                {version.status === "retired" ? <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => void mutate(`rollback:${version.id}`, () => rollbackAgentVersion(agent.id, version.id))}><RotateCcw className="mr-1.5 h-3.5 w-3.5" />Rollback</Button> : null}
                {version.status === "published" ? <Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => void mutate(`retire:${version.id}`, () => retireAgentVersion(agent.id, version.id))}>Retire</Button> : null}
              </div> : null}
            </CardContent></Card>
          ))}
        </section>
      </div>
    </div>
  );
}

function InstallationCredentials({ installationId }: { installationId: string }) {
  const [credentials, setCredentials] = useState<AgentInstallationCredential[]>([]);
  const [label, setLabel] = useState("");
  const [mcpWrite, setMcpWrite] = useState(false);
  const [apiWrite, setApiWrite] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [rotating, setRotating] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        mcpScopes: ["mcp:read", ...(mcpWrite ? ["mcp:write" as const] : [])],
        apiScopes: ["api:read", ...(apiWrite ? ["api:write" as const] : [])],
      });
      setCredentials((current) => [created.credential, ...current]);
      setLabel("");
      setSecret(created.secret);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create credential");
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (credential: AgentInstallationCredential) => {
    if (!window.confirm(`Revoke ${credential.label}? Existing tokens will stop working.`)) return;
    try {
      await revokeAgentInstallationCredential(installationId, credential.id);
      setCredentials((current) => current.map((entry) => entry.id === credential.id ? { ...entry, status: "revoked" } : entry));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to revoke credential");
    }
  };

  const rotate = async (credential: AgentInstallationCredential) => {
    if (rotating || !window.confirm(`Rotate ${credential.label}? Existing tokens will stop working immediately.`)) return;
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
      <div className="grid gap-3 rounded-xl border border-border bg-secondary/20 p-4 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end">
        <label className="text-sm font-medium text-foreground">Credential name<input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Local Codex" className="mt-2 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" /></label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={apiWrite} onChange={(event) => setApiWrite(event.target.checked)} />API write</label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={mcpWrite} onChange={(event) => setMcpWrite(event.target.checked)} />MCP write</label>
        <Button type="button" onClick={() => void create()} disabled={creating || !label.trim()}>{creating ? "Creating…" : "Create credential"}</Button>
      </div>
      {secret ? <div className="rounded-xl border border-status-attention/40 bg-status-attention-soft p-4" role="alert"><p className="text-sm font-semibold text-status-attention">Copy this secret now. It will not be shown again.</p><div className="mt-2 flex gap-2"><code className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-background px-3 py-2 text-xs text-foreground">{secret}</code><Button type="button" variant="outline" size="sm" onClick={() => void navigator.clipboard?.writeText(secret)}><Copy className="mr-1.5 h-3.5 w-3.5" />Copy</Button></div><ExternalConnectionSetup secret={secret} /></div> : null}
      {error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
      {loading ? <p className="text-sm text-muted-foreground">Loading credentials…</p> : credentials.length ? <div className="space-y-2">{credentials.map((credential) => <div key={credential.id} className="flex flex-col gap-3 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-medium text-foreground">{credential.label}</p><p className="mt-1 text-xs text-muted-foreground">{credential.status} · API {credential.api_scopes?.join(", ") ?? "api:read"} · MCP {credential.mcp_scopes.join(", ")}</p></div>{credential.status === "active" ? <div className="flex gap-2"><Button type="button" variant="outline" size="sm" disabled={rotating !== null} onClick={() => void rotate(credential)}>{rotating === credential.id ? "Rotating…" : "Rotate"}</Button><Button type="button" variant="outline" size="sm" disabled={rotating !== null} onClick={() => void revoke(credential)}><Trash2 className="mr-1.5 h-3.5 w-3.5" />Revoke</Button></div> : null}</div>)}</div> : <p className="text-sm text-muted-foreground">No external credentials yet.</p>}
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

function InstallationCapabilities({ installationId }: { installationId: string }) {
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

  const grant = async (capability: AgentCapability) => {
    if (busy || capability.availability === "available") return;
    setBusy(capability.name);
    setError(null);
    try {
      await grantAgentInstallationTool(installationId, capability.name);
      setCapabilities((current) => current.map((entry) => entry.name === capability.name ? { ...entry, availability: "available" } : entry));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to grant capability");
    } finally {
      setBusy(null);
    }
  };

  return <Card>
    <CardContent className="space-y-4 p-6">
      <div><h2 className="text-lg font-semibold text-foreground">Capabilities</h2><p className="mt-1 text-sm text-muted-foreground">These are the platform tools this installation may expose to KasiAi or external agents. Grants are enforced again at invocation time.</p></div>
      {error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
      {loading ? <p className="text-sm text-muted-foreground">Loading capabilities…</p> : capabilities.length ? <div className="space-y-2">{capabilities.map((capability) => <div key={capability.name} className="flex flex-col gap-3 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-medium text-foreground">{capability.name}</p><p className="mt-1 text-xs text-muted-foreground">{capability.description} · {capability.riskClass}{capability.requiresApproval ? " · approval required" : ""}</p></div><Button type="button" size="sm" variant={capability.availability === "available" ? "outline" : "default"} disabled={capability.availability === "available" || busy !== null} onClick={() => void grant(capability)}>{capability.availability === "available" ? "Granted" : busy === capability.name ? "Granting…" : "Grant"}</Button></div>)}</div> : <p className="text-sm text-muted-foreground">No capabilities are registered for this installation.</p>}
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
    <CardContent className="space-y-4 p-6">
      <div><h2 className="text-lg font-semibold text-foreground">Access scope</h2><p className="mt-1 text-sm text-muted-foreground">Limit this installation to explicit product resources and approved connectors. These grants are checked again when a capability runs.</p></div>
      {error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
      {loading ? <p className="text-sm text-muted-foreground">Loading access scope…</p> : <>
        <div className="rounded-xl border border-border bg-secondary/20 p-4"><p className="text-sm font-semibold text-foreground">Resource grants</p><div className="mt-3 grid gap-2 sm:grid-cols-[0.8fr_1.2fr_auto]"><input value={resourceType} onChange={(event) => setResourceType(event.target.value)} placeholder="Resource type (e.g. content_post)" className="rounded-lg border border-border bg-background px-3 py-2 text-sm" /><input value={resourceId} onChange={(event) => setResourceId(event.target.value)} placeholder="Resource ID" className="rounded-lg border border-border bg-background px-3 py-2 text-sm" /><Button type="button" size="sm" disabled={busy !== null || !resourceType.trim() || !resourceId.trim()} onClick={() => void addResource()}>{busy === "resource" ? "Granting…" : "Grant resource"}</Button></div>{resources.length ? <div className="mt-3 flex flex-wrap gap-2">{resources.map((resource) => <span key={`${resource.resourceType}:${resource.resourceId}`} className="rounded-full border border-border bg-background px-2.5 py-1 text-xs text-foreground">{resource.resourceType}: {resource.resourceId}</span>)}</div> : <p className="mt-3 text-xs text-muted-foreground">No resource-specific grants. Capability-level policy still applies.</p>}</div>
        <div className="rounded-xl border border-border bg-secondary/20 p-4"><p className="text-sm font-semibold text-foreground">Connector grants</p>{connectors.length ? <div className="mt-3 flex flex-wrap gap-2">{connectors.map((connector) => <span key={connector.id} className="rounded-full border border-accent/30 bg-accent/10 px-2.5 py-1 text-xs text-accent">{connector.displayName || connector.id}</span>)}</div> : <p className="mt-3 text-xs text-muted-foreground">No connectors are granted to this installation.</p>}{availableConnectors.length ? <div className="mt-4 space-y-2">{availableConnectors.map((connector) => { const granted = connectors.some((entry) => entry.id === connector.id); return <div key={connector.id} className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-medium text-foreground">{connector.displayName || connector.id}</p><p className="mt-1 text-xs text-muted-foreground">{connector.auth} · {connector.capabilityNames.length} capabilities · v{connector.version}</p></div><Button type="button" size="sm" variant={granted ? "outline" : "default"} disabled={granted || busy !== null} onClick={() => void grantConnector(connector)}>{granted ? "Granted" : busy === `connector:${connector.id}` ? "Granting…" : "Grant connector"}</Button></div>; })}</div> : null}</div>
      </>}
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
      {loading ? <p className="text-sm text-muted-foreground">Loading runs…</p> : runs.length ? <div className="space-y-2">{runs.map((run) => <div key={run.id} className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between"><div><Link href={`/agents/activity/${encodeURIComponent(run.id)}`} className="font-mono text-xs text-primary underline-offset-2 hover:underline">{run.id}</Link><p className="mt-1 text-xs text-muted-foreground">{run.trigger_type ?? "manual"}{run.created_at ? ` · ${new Date(run.created_at).toLocaleString()}` : ""}</p>{run.error?.message ? <p className="mt-1 text-xs text-destructive">{run.error.message}</p> : null}</div><div className="flex items-center gap-2"><Badge className={run.status === "completed" ? "border-accent/30 bg-accent/10 text-accent" : run.status === "failed" ? "border-destructive/30 bg-destructive/10 text-destructive" : "border-border bg-secondary text-muted-foreground"}>{run.status}</Badge><Link href={`/agents/activity/${encodeURIComponent(run.id)}`} className="text-xs text-muted-foreground hover:text-foreground">Inspect</Link></div></div>)}</div> : <p className="text-sm text-muted-foreground">No runs have been recorded for this installation.</p>}
    </CardContent>
  </Card>;
}

function InstallationKnowledge({ agentId, installationId }: { agentId: string; installationId: string }) {
  const [sources, setSources] = useState<AgentKnowledgeSource[]>([]);
  const [memories, setMemories] = useState<AgentMemory[]>([]);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  const addSource = async () => {
    if (!name.trim() || !url.trim() || busy) return;
    setBusy("source");
    setError(null);
    try {
      const source = await createAgentKnowledgeSource({ agentId, installationId, name: name.trim(), sourceType: "url", sourceUri: url.trim() });
      await ingestAgentKnowledgeSourceUrl(source.id, url.trim());
      setSources((current) => [source, ...current]);
      setName("");
      setUrl("");
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to ingest knowledge source");
    } finally {
      setBusy(null);
    }
  };

  const removeSource = async (source: AgentKnowledgeSource) => {
    if (busy || !window.confirm(`Remove ${source.name}? Its indexed chunks will no longer be retrieved.`)) return;
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
    if (busy || !window.confirm("Delete this memory? This is recorded as a deletion request.")) return;
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

  return <Card>
    <CardContent className="space-y-5 p-6">
      <div><h2 className="text-lg font-semibold text-foreground">Knowledge and memory</h2><p className="mt-1 text-sm text-muted-foreground">Attach approved URLs to this agent and review durable memories in this installation scope. Retrieved content stays organization-scoped.</p></div>
      {error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
      <div className="rounded-xl border border-border bg-secondary/20 p-4">
        <p className="text-sm font-semibold text-foreground">Add a URL source</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-[0.8fr_1.2fr_auto]">
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Source name" className="rounded-lg border border-border bg-background px-3 py-2 text-sm" />
          <input value={url} onChange={(event) => setUrl(event.target.value)} type="url" placeholder="https://example.com/help" className="rounded-lg border border-border bg-background px-3 py-2 text-sm" />
          <Button type="button" size="sm" disabled={busy !== null || !name.trim() || !url.trim()} onClick={() => void addSource()}>{busy === "source" ? "Indexing…" : "Add and index"}</Button>
        </div>
      </div>
      {loading ? <p className="text-sm text-muted-foreground">Loading knowledge and memory…</p> : <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2"><p className="text-sm font-semibold text-foreground">Knowledge sources</p>{sources.length ? sources.map((source) => <div key={source.id} className="flex items-start justify-between gap-3 rounded-lg border border-border p-3"><div className="min-w-0"><p className="font-medium text-foreground">{source.name}</p><p className="mt-1 truncate text-xs text-muted-foreground">{source.source_uri || source.source_type} · revision {source.revision} · {source.status}</p></div><Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => void removeSource(source)}>{busy === `source:${source.id}` ? "Removing…" : "Remove"}</Button></div>) : <p className="text-sm text-muted-foreground">No knowledge sources are attached.</p>}</div>
        <div className="space-y-2"><p className="text-sm font-semibold text-foreground">Durable memories</p>{memories.length ? memories.slice(0, 20).map((memory) => <div key={memory.id} className="rounded-lg border border-border p-3"><p className="line-clamp-2 text-sm text-foreground">{memory.canonical_text}</p><div className="mt-2 flex items-center justify-between gap-2"><p className="text-[11px] text-muted-foreground">{memory.namespace} · {memory.memory_type} · {memory.status}{memory.expires_at ? ` · expires ${new Date(memory.expires_at).toLocaleDateString()}` : ""}</p><div className="flex gap-1"><Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={() => void revalidate(memory)}>{busy === `revalidate:${memory.id}` ? "…" : "Revalidate"}</Button><Button type="button" variant="ghost" size="sm" disabled={busy !== null} onClick={() => void removeMemory(memory)}>Delete</Button></div></div></div>) : <p className="text-sm text-muted-foreground">No memories are recorded for this installation.</p>}</div>
      </div>}
    </CardContent>
  </Card>;
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
      <div className="grid gap-2 rounded-xl border border-border bg-secondary/20 p-4 sm:grid-cols-[1.2fr_0.7fr_1fr_auto] sm:items-end"><label className="text-xs font-medium text-foreground">Cron expression<input value={expression} onChange={(event) => setExpression(event.target.value)} placeholder="0 9 * * *" className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" /></label><label className="text-xs font-medium text-foreground">Timezone<input value={timezone} onChange={(event) => setTimezone(event.target.value)} placeholder="Africa/Johannesburg" className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" /></label><label className="text-xs font-medium text-foreground">First run (optional)<input value={nextRunAt} onChange={(event) => setNextRunAt(event.target.value)} type="datetime-local" className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" /></label><Button type="button" size="sm" disabled={busy !== null || !expression.trim()} onClick={() => void create()}>{busy === "create" ? "Creating…" : "Add schedule"}</Button></div>
      {loading ? <p className="text-sm text-muted-foreground">Loading schedules…</p> : schedules.length ? <div className="space-y-2">{schedules.map((schedule) => <div key={schedule.id} className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-mono text-sm text-foreground">{schedule.expression}</p><p className="mt-1 text-xs text-muted-foreground">{schedule.timezone} · {schedule.next_run_at ? `next ${new Date(schedule.next_run_at).toLocaleString()}` : "runtime calculates next run"}</p></div><Button type="button" variant="outline" size="sm" disabled={busy !== null || schedule.status === "disabled"} onClick={() => void setStatus(schedule)}>{busy === schedule.id ? "Updating…" : schedule.status === "active" ? "Pause" : "Resume"}</Button></div>)}</div> : <p className="text-sm text-muted-foreground">No schedules configured.</p>}
    </CardContent>
  </Card>;
}

function InstallationChannels({ installationId }: { installationId: string }) {
  const [connections, setConnections] = useState<AgentChannelConnection[]>([]);
  const [bindings, setBindings] = useState<AgentChannelBinding[]>([]);
  const [channelType, setChannelType] = useState("telegram");
  const [channelKey, setChannelKey] = useState("");
  const [credentialReference, setCredentialReference] = useState("");
  const [pairing, setPairing] = useState<{ token: string; expires_at: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const createConnection = async () => {
    if (!channelKey.trim() || busy) return;
    setBusy("create");
    setError(null);
    try {
      const connection = await createAgentChannelConnection(installationId, {
        channelType,
        channelKey: channelKey.trim(),
        ...(credentialReference.trim() ? { credentialReference: credentialReference.trim() } : {}),
        metadata: { configuredFrom: "agent-detail" },
      });
      setConnections((current) => [connection, ...current.filter((entry) => entry.id !== connection.id)]);
      setChannelKey("");
      setCredentialReference("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to register channel connection");
    } finally {
      setBusy(null);
    }
  };

  const issuePairing = async (connection: AgentChannelConnection) => {
    if (busy) return;
    setBusy(`pair:${connection.id}`);
    setPairing(null);
    setError(null);
    try {
      setPairing(await issueAgentChannelPairing(installationId, connection.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to issue pairing token");
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (binding: AgentChannelBinding) => {
    if (busy || !window.confirm(`Disconnect ${binding.external_identity}?`)) return;
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

  return <Card>
    <CardContent className="space-y-4 p-6">
      <div><h2 className="text-lg font-semibold text-foreground">Connected channels</h2><p className="mt-1 text-sm text-muted-foreground">Register a provider connection for this installation, then pair an external identity. Only opaque credential references are accepted here; provider secrets stay in the connection vault.</p></div>
      {error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
      <div className="grid gap-2 rounded-xl border border-border bg-secondary/20 p-4 sm:grid-cols-[0.7fr_1fr_1fr_auto] sm:items-end"><label className="text-xs font-medium text-foreground">Channel type<select value={channelType} onChange={(event) => setChannelType(event.target.value)} className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"><option value="telegram">Telegram</option><option value="discord">Discord</option><option value="whatsapp">WhatsApp</option><option value="webhook">Webhook</option></select></label><label className="text-xs font-medium text-foreground">Channel key<input value={channelKey} onChange={(event) => setChannelKey(event.target.value)} placeholder="bot or provider connection key" className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" /></label><label className="text-xs font-medium text-foreground">Credential reference (optional)<input value={credentialReference} onChange={(event) => setCredentialReference(event.target.value)} placeholder="vault://connections/…" className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" /></label><Button type="button" size="sm" disabled={busy !== null || !channelKey.trim()} onClick={() => void createConnection()}>{busy === "create" ? "Registering…" : "Register channel"}</Button></div>
      {pairing ? <div className="rounded-xl border border-status-attention/40 bg-status-attention-soft p-4" role="alert"><p className="text-sm font-semibold text-status-attention">One-time pairing token</p><p className="mt-1 text-xs text-muted-foreground">Share this token with the external identity. It expires {new Date(pairing.expires_at).toLocaleString()} and will not be shown again.</p><div className="mt-2 flex gap-2"><code className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-background px-3 py-2 text-xs text-foreground">{pairing.token}</code><Button type="button" variant="outline" size="sm" onClick={() => void navigator.clipboard?.writeText(pairing.token)}>Copy</Button></div></div> : null}
      {loading ? <p className="text-sm text-muted-foreground">Loading channels…</p> : connections.length || bindings.length ? <div className="space-y-2">{connections.map((connection: AgentChannelConnection) => <div key={connection.id} className="rounded-lg border border-border p-3"><div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-medium capitalize text-foreground">{connection.channel_type}</p><p className="mt-1 text-xs text-muted-foreground">{connection.channel_key} · {connection.status}</p></div><div className="flex gap-2"><Badge className="border-border bg-secondary text-muted-foreground">connection</Badge><Button type="button" variant="outline" size="sm" disabled={busy !== null || connection.status !== "active"} onClick={() => void issuePairing(connection)}>{busy === `pair:${connection.id}` ? "Issuing…" : "Issue pairing"}</Button></div></div></div>)}{bindings.map((binding: AgentChannelBinding) => <div key={binding.id} className="flex items-center justify-between gap-3 rounded-lg border border-border p-3"><div><p className="font-medium text-foreground">{binding.external_identity}</p><p className="mt-1 text-xs text-muted-foreground">{binding.channel_type} · {binding.status}</p></div>{binding.status === "active" ? <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => void disconnect(binding)}>{busy === binding.id ? "Disconnecting…" : "Disconnect"}</Button> : null}</div>)}</div> : <p className="text-sm text-muted-foreground">No channels are connected to this installation.</p>}
    </CardContent>
  </Card>;
}

function AgentTestChat({ installationId, active }: { installationId: string; active: boolean }) {
  const [conversation, setConversation] = useState<AgentConversation | null>(null);
  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (conversationId?: string) => {
    const response = conversationId ? await getPlatformConversation(conversationId) : await resolvePlatformConversation(installationId);
    setConversation(response.conversation);
    setMessages([...response.messages].sort((left, right) => Number(left.sequence_number) - Number(right.sequence_number)));
  }, [installationId]);

  useEffect(() => {
    void refresh().catch((cause) => setError(cause instanceof Error ? cause.message : "Unable to open test chat")).finally(() => setLoading(false));
  }, [refresh]);

  const send = async () => {
    const message = draft.trim();
    if (!message || sending || !active) return;
    setDraft("");
    setSending(true);
    setError(null);
    try {
      if (!conversation) throw new Error("Conversation is not ready");
      const accepted = await sendPlatformMessage(installationId, { message, idempotencyKey: crypto.randomUUID(), conversationId: conversation.id, context: { route: window.location.pathname, pageTitle: document.title } });
      await streamAgentRun(accepted.runId, () => undefined, new AbortController().signal);
      await refresh(accepted.conversation.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Agent test failed");
    } finally {
      setSending(false);
    }
  };

  return <Card><CardContent className="space-y-4 p-6">
    <div><h2 className="text-lg font-semibold text-foreground">Test agent</h2><p className="mt-1 text-sm text-muted-foreground">Send a real platform message through this installation. Runs and replies remain in durable history.</p></div>
    {!active ? <p className="rounded-lg bg-status-attention-soft px-3 py-2 text-sm text-status-attention">This installation is not active. Resume it before testing.</p> : null}
    <div className="max-h-72 space-y-2 overflow-y-auto rounded-xl border border-border bg-secondary/20 p-3" aria-live="polite">
      {loading ? <p className="text-sm text-muted-foreground">Loading conversation…</p> : messages.length ? messages.map((message) => <div key={message.id} className={`rounded-lg px-3 py-2 text-sm ${message.direction === "outbound" ? "mr-8 bg-card text-foreground" : "ml-8 bg-primary/10 text-foreground"}`}><span className="mr-2 text-[10px] uppercase text-muted-foreground">{message.direction}</span>{typeof message.content?.text === "string" ? message.content.text : ""}</div>) : <p className="text-sm text-muted-foreground">No messages yet. Ask the agent a question.</p>}
    </div>
    {error ? <p className="text-sm text-destructive" role="alert">{error}</p> : null}
    <div className="flex gap-2"><input value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} disabled={!active || sending} placeholder="Test this agent…" className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm" /><Button type="button" onClick={() => void send()} disabled={!active || sending || !draft.trim()}>{sending ? "Running…" : "Send"}</Button></div>
  </CardContent></Card>;
}
