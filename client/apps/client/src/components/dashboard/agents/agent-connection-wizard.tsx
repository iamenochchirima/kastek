"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, CheckCircle2, Copy, KeyRound, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  createAgentInstallationCredential,
  listAgentInstallationCapabilities,
  listAgentInstallationGrants,
  listAgents,
  grantAgentInstallationResource,
  type AgentCapability,
  type AgentDefinition,
  type AgentInstallationGrants,
} from "@/lib/agent-platform";

function copy(text: string) {
  void navigator.clipboard?.writeText(text);
}

export function AgentConnectionWizard() {
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [agentId, setAgentId] = useState("");
  const [capabilities, setCapabilities] = useState<AgentCapability[]>([]);
  const [grants, setGrants] = useState<AgentInstallationGrants | null>(null);
  const [label, setLabel] = useState("External agent");
  const [mcpWrite, setMcpWrite] = useState(false);
  const [apiWrite, setApiWrite] = useState(false);
  const [resourceType, setResourceType] = useState("");
  const [resourceId, setResourceId] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = agents.find((agent) => agent.id === agentId);
  const installationId = selected?.installation_id ?? null;
  const availableCount = capabilities.filter((capability) => capability.availability === "available").length;
  const grantedCount = capabilities.filter((capability) => capability.availability === "not_granted").length;
  const unavailableCount = capabilities.length - availableCount - grantedCount;
  const mcpEndpoint = "https://agents.kasitek.co.za/mcp";
  const restEndpoint = "https://api.kasitek.co.za/v1";
  const curlExample = useMemo(() => `curl -X POST ${restEndpoint}/installations/${installationId ?? "<installation-id>"}/capabilities \\\n+  -H 'Authorization: Bearer <copy-once-secret>' \\\n+  -H 'Content-Type: application/json'`, [installationId]);

  useEffect(() => {
    void listAgents().then((response) => {
      const installed = response.agents.filter((agent) => agent.installation_id && agent.installation_status !== "disabled");
      setAgents(installed);
      setAgentId(installed[0]?.id ?? "");
    }).catch((cause) => setError(cause instanceof Error ? cause.message : "Unable to load installed agents")).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!installationId) {
      setCapabilities([]);
      setGrants(null);
      return;
    }
    setBusy(true);
    Promise.all([listAgentInstallationCapabilities(installationId), listAgentInstallationGrants(installationId)])
      .then(([capabilityResponse, grantResponse]) => { setCapabilities(capabilityResponse.capabilities); setGrants(grantResponse); setError(null); })
      .catch((cause) => setError(cause instanceof Error ? cause.message : "Unable to inspect installation access"))
      .finally(() => setBusy(false));
  }, [installationId]);

  const createCredential = async () => {
    if (!installationId || !label.trim() || busy) return;
    setBusy(true);
    setSecret(null);
    setError(null);
    try {
      const created = await createAgentInstallationCredential(installationId, {
        label: label.trim(),
        mcpScopes: ["mcp:read", ...(mcpWrite ? ["mcp:write" as const] : [])],
        apiScopes: ["api:read", ...(apiWrite ? ["api:write" as const] : [])],
      });
      setSecret(created.secret);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create credential");
    } finally {
      setBusy(false);
    }
  };

  const addResourceGrant = async () => {
    if (!installationId || !resourceType.trim() || !resourceId.trim() || busy) return;
    setBusy(true);
    try {
      await grantAgentInstallationResource(installationId, resourceType.trim(), resourceId.trim());
      const updated = await listAgentInstallationGrants(installationId);
      setGrants(updated);
      setResourceType("");
      setResourceId("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to add resource scope");
    } finally {
      setBusy(false);
    }
  };

  return <div className="min-h-screen p-6 lg:p-8"><div className="mx-auto max-w-4xl space-y-6"><Link href="/agents" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" />Back to agents</Link><header><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">External access</p><h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">Connect an external agent</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">Create a scoped installation credential for MCP or REST clients. The secret is displayed once; rotate or revoke credentials from the agent details page.</p></header>
    {error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
    {loading ? <Card><CardContent className="p-6 text-sm text-muted-foreground">Loading installed agents…</CardContent></Card> : !agents.length ? <Card><CardContent className="space-y-3 p-6"><p className="font-medium text-foreground">No active installation is available.</p><p className="text-sm text-muted-foreground">Create or install an agent before connecting an external client.</p><Button asChild><Link href="/agents/new">Create agent</Link></Button></CardContent></Card> : <>
      <Card><CardContent className="space-y-4 p-6"><div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 h-5 w-5 text-primary" /><div><h2 className="text-lg font-semibold text-foreground">1. Choose installation and inspect access</h2><p className="mt-1 text-sm text-muted-foreground">Capability availability reflects current installation grants and provider readiness.</p></div></div><select value={agentId} onChange={(event) => setAgentId(event.target.value)} className="block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm">{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {agent.installation_status}</option>)}</select>{busy && !capabilities.length ? <p className="text-sm text-muted-foreground">Inspecting capabilities…</p> : <><div className="grid gap-3 sm:grid-cols-3"><div className="rounded-lg bg-secondary/50 p-3"><p className="text-xs text-muted-foreground">Available</p><p className="mt-1 text-xl font-semibold text-accent">{availableCount}</p></div><div className="rounded-lg bg-secondary/50 p-3"><p className="text-xs text-muted-foreground">Not granted</p><p className="mt-1 text-xl font-semibold text-status-attention">{grantedCount}</p></div><div className="rounded-lg bg-secondary/50 p-3"><p className="text-xs text-muted-foreground">Unavailable</p><p className="mt-1 text-xl font-semibold text-muted-foreground">{unavailableCount}</p></div></div><div className="flex flex-wrap gap-1.5">{capabilities.map((capability) => <Badge key={`${capability.name}:${capability.version}`} title={[capability.permission?.label, capability.audit?.description].filter(Boolean).join(" — ")} className={capability.availability === "available" ? "border-accent/30 bg-accent/10 text-accent" : "border-border bg-secondary text-muted-foreground"}>{capability.name} · {capability.availability}</Badge>)}</div><p className="text-xs text-muted-foreground">Resource grants: {grants?.resources.length ?? 0} · Connector grants: {grants?.connectors.length ?? 0}. Add a resource scope below when the client must be limited to a known record.</p><div className="grid gap-2 sm:grid-cols-[0.8fr_1fr_auto]"><input value={resourceType} onChange={(event) => setResourceType(event.target.value)} placeholder="Resource type" className="rounded-lg border border-border bg-background px-3 py-2 text-sm" /><input value={resourceId} onChange={(event) => setResourceId(event.target.value)} placeholder="Resource id" className="rounded-lg border border-border bg-background px-3 py-2 text-sm" /><Button type="button" variant="outline" disabled={!resourceType.trim() || !resourceId.trim() || busy} onClick={() => void addResourceGrant()}>Add scope</Button></div></>}</CardContent></Card>
      <Card><CardContent className="space-y-4 p-6"><div className="flex items-start gap-3"><KeyRound className="mt-0.5 h-5 w-5 text-primary" /><div><h2 className="text-lg font-semibold text-foreground">2. Create copy-once credentials</h2><p className="mt-1 text-sm text-muted-foreground">MCP and REST scopes are independent. Start read-only and add write access only when the client and approval policy are ready.</p></div></div><div className="grid gap-3 sm:grid-cols-[1fr_auto_auto]"><input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="Credential label" className="rounded-lg border border-border bg-background px-3 py-2 text-sm" /><label className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs"><input type="checkbox" checked={mcpWrite} onChange={(event) => setMcpWrite(event.target.checked)} />MCP write</label><label className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-xs"><input type="checkbox" checked={apiWrite} onChange={(event) => setApiWrite(event.target.checked)} />REST write</label></div><Button type="button" disabled={!installationId || !label.trim() || busy} onClick={() => void createCredential()}>{busy ? "Creating…" : "Create credential"}</Button>{secret ? <div className="rounded-xl border border-status-attention/40 bg-status-attention-soft p-4" role="alert"><p className="flex items-center gap-2 text-sm font-semibold text-status-attention"><CheckCircle2 className="h-4 w-4" />Copy this secret now</p><p className="mt-1 text-xs text-muted-foreground">It will not be shown again after you leave this page.</p><div className="mt-3 flex gap-2"><code className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-background px-3 py-2 text-xs text-foreground">{secret}</code><Button type="button" variant="outline" size="sm" onClick={() => copy(secret)}><Copy className="mr-1.5 h-3.5 w-3.5" />Copy</Button></div></div> : null}</CardContent></Card>
      <Card><CardContent className="space-y-4 p-6"><div><h2 className="text-lg font-semibold text-foreground">3. Connect the client</h2><p className="mt-1 text-sm text-muted-foreground">Use the one-time secret as a bearer credential. The gateway and REST API re-check installation status, scopes, grants, and capability availability on every request.</p></div><div className="space-y-3"><div><p className="text-xs font-medium text-foreground">MCP endpoint</p><div className="mt-1 flex gap-2"><code className="min-w-0 flex-1 rounded-lg bg-secondary px-3 py-2 text-xs text-muted-foreground">{mcpEndpoint}</code><Button type="button" variant="outline" size="sm" onClick={() => copy(mcpEndpoint)}><Copy className="h-3.5 w-3.5" /></Button></div></div><div><p className="text-xs font-medium text-foreground">REST discovery example</p><div className="mt-1 flex gap-2"><pre className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-secondary px-3 py-2 text-xs text-muted-foreground">{curlExample}</pre><Button type="button" variant="outline" size="sm" onClick={() => copy(curlExample)}><Copy className="h-3.5 w-3.5" /></Button></div></div></div>{selected ? <Button asChild variant="outline"><Link href={`/agents/${encodeURIComponent(selected.id)}`}>Open installation controls</Link></Button> : null}</CardContent></Card>
    </>}</div></div>;
}
