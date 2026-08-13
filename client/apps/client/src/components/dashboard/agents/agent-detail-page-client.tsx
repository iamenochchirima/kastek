"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { Archive, ArrowLeft, CheckCircle2, Copy, History, KeyRound, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  archiveAgent,
  publishAgentVersion,
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
  type AgentInstallationCredential,
  grantAgentInstallationTool,
  listAgentInstallationCapabilities,
  type AgentCapability,
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
  const [tone, setTone] = useState(String(agent.installation_settings?.tone ?? "balanced"));
  const [responseDetail, setResponseDetail] = useState(String(agent.installation_settings?.responseDetail ?? "standard"));
  const [savingSettings, setSavingSettings] = useState(false);
  const protectedAgent = agent.protected;

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
      await updateAgentInstallationSettings(agent.installation_id, { tone: tone as "concise" | "balanced" | "detailed", responseDetail: responseDetail as "concise" | "standard" | "detailed" });
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save agent settings");
    } finally {
      setSavingSettings(false);
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
              {protectedAgent ? <Badge className="w-fit border-primary/20 bg-primary/10 text-primary">Protected system agent</Badge> : <Button type="button" variant="outline" disabled={busy === "archive"} onClick={() => void mutate("archive", () => archiveAgent(agent.id))}><Archive className="mr-2 h-4 w-4" />{busy === "archive" ? "Archiving…" : "Archive agent"}</Button>}
            </div>
            <div className="grid gap-3 text-sm sm:grid-cols-3">
              <div className="rounded-lg bg-secondary/50 p-3"><p className="text-xs text-muted-foreground">Slug</p><p className="mt-1 font-medium text-foreground">{agent.slug}</p></div>
              <div className="rounded-lg bg-secondary/50 p-3"><p className="text-xs text-muted-foreground">Installation</p><p className="mt-1 font-medium capitalize text-foreground">{agent.installation_status ?? "not installed"}</p></div>
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
            </div>
            <Button type="button" onClick={() => void saveSettings()} disabled={!agent.installation_id || savingSettings}>{savingSettings ? "Saving…" : "Save preferences"}</Button>
          </CardContent>
        </Card>

        {agent.installation_id ? <InstallationCredentials installationId={agent.installation_id} /> : null}

        {agent.installation_id ? <InstallationCapabilities installationId={agent.installation_id} /> : null}

        {agent.installation_id ? <AgentTestChat installationId={agent.installation_id} active={agent.installation_status === "active"} /> : null}

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

  return <Card>
    <CardContent className="space-y-4 p-6">
      <div className="flex items-start gap-3"><KeyRound className="mt-0.5 h-5 w-5 text-primary" /><div><h2 className="text-lg font-semibold text-foreground">External agent credentials</h2><p className="mt-1 text-sm text-muted-foreground">Create named credentials for Codex, Claude, n8n, or your own agent. Secrets are shown once and can be revoked independently.</p></div></div>
      <div className="grid gap-3 rounded-xl border border-border bg-secondary/20 p-4 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end">
        <label className="text-sm font-medium text-foreground">Credential name<input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Local Codex" className="mt-2 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" /></label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={apiWrite} onChange={(event) => setApiWrite(event.target.checked)} />API write</label>
        <label className="flex items-center gap-2 text-xs text-muted-foreground"><input type="checkbox" checked={mcpWrite} onChange={(event) => setMcpWrite(event.target.checked)} />MCP write</label>
        <Button type="button" onClick={() => void create()} disabled={creating || !label.trim()}>{creating ? "Creating…" : "Create credential"}</Button>
      </div>
      {secret ? <div className="rounded-xl border border-status-attention/40 bg-status-attention-soft p-4" role="alert"><p className="text-sm font-semibold text-status-attention">Copy this secret now. It will not be shown again.</p><div className="mt-2 flex gap-2"><code className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-background px-3 py-2 text-xs text-foreground">{secret}</code><Button type="button" variant="outline" size="sm" onClick={() => void navigator.clipboard?.writeText(secret)}><Copy className="mr-1.5 h-3.5 w-3.5" />Copy</Button></div></div> : null}
      {error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
      {loading ? <p className="text-sm text-muted-foreground">Loading credentials…</p> : credentials.length ? <div className="space-y-2">{credentials.map((credential) => <div key={credential.id} className="flex flex-col gap-3 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-medium text-foreground">{credential.label}</p><p className="mt-1 text-xs text-muted-foreground">{credential.status} · API {credential.api_scopes?.join(", ") ?? "api:read"} · MCP {credential.mcp_scopes.join(", ")}</p></div>{credential.status === "active" ? <Button type="button" variant="outline" size="sm" onClick={() => void revoke(credential)}><Trash2 className="mr-1.5 h-3.5 w-3.5" />Revoke</Button> : null}</div>)}</div> : <p className="text-sm text-muted-foreground">No external credentials yet.</p>}
    </CardContent>
  </Card>;
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
