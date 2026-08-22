"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, CheckCircle2, Copy, KeyRound, Plug, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { createExternalAgentConnection, getExternalAgentAccessCatalog, type AgentCapability, type ExternalAgentAccessCatalog, type ExternalAgentConnection } from "@/lib/agent-platform";

function copy(text: string) {
  void navigator.clipboard?.writeText(text);
}

function splitLines(value: string): string[] {
  return [...new Set(value.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
}

export function AgentConnectionWizard({ client, mcpEndpoint: configuredMcpEndpoint }: { client?: string; mcpEndpoint?: string }) {
  const [name, setName] = useState("");
  const [audience, setAudience] = useState<"personal" | "customer_service">("personal");
  const [runtime, setRuntime] = useState(client === "claude" || client === "claude-code" ? "claude" : client === "chatgpt" ? "custom" : "custom");
  const protocols: Array<"mcp" | "rest"> = ["mcp"];
  const [capabilities, setCapabilities] = useState("");
  const [resources, setResources] = useState("");
  const [connectors, setConnectors] = useState("");
  const [credentialLabel, setCredentialLabel] = useState(client ? `${client} connection` : "External agent");
  const [connection, setConnection] = useState<ExternalAgentConnection | null>(null);
  const [catalog, setCatalog] = useState<ExternalAgentAccessCatalog | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const installationId = connection?.installation.id ?? null;
  const mcpEndpoint = configuredMcpEndpoint?.trim() || process.env.NEXT_PUBLIC_KASITEK_MCP_URL?.trim() || "https://agents.kasitek.co.za/mcp";
  const restEndpoint = process.env.NEXT_PUBLIC_KASITEK_REST_URL?.trim() || "https://api.kasitek.co.za/v1";
  const curlExample = useMemo(() => `# Exchange the copy-once secret for a short-lived REST token\ncurl -sS ${restEndpoint}/installation-tokens/exchange \\
  -H 'Content-Type: application/json' \\
  -d '{"secret":"<copy-once-secret>","audience":"kasitek-public-api"}'\n\n# Use the returned accessToken for discovery\ncurl -sS ${restEndpoint}/installations/${installationId ?? "<installation-id>"}/tools \\
  -H 'Authorization: Bearer <access-token>'`, [installationId, restEndpoint]);

  useEffect(() => {
    let cancelled = false;
    void getExternalAgentAccessCatalog().then((value) => {
      if (!cancelled) {
        setCatalog(value);
        setCatalogError(null);
      }
    }).catch((cause) => {
      if (!cancelled) setCatalogError(cause instanceof Error ? cause.message : "Unable to load the live capability catalog");
    });
    return () => { cancelled = true; };
  }, []);

  const toggleCapability = (capability: AgentCapability) => {
    if (!capability.available) return;
    const selected = new Set(splitLines(capabilities));
    if (selected.has(capability.name)) selected.delete(capability.name);
    else selected.add(capability.name);
    setCapabilities([...selected].join("\n"));
  };

  const selectedCapabilityNames = splitLines(capabilities);
  const invalidSelectedCapability = catalog === null || selectedCapabilityNames.some((name) => !catalog.capabilities.some((capability) => capability.name === name && capability.available));

  const createConnection = async () => {
    if (!name.trim() || !credentialLabel.trim() || !protocols.length || invalidSelectedCapability || busy) return;
    setBusy(true);
    setError(null);
    setConnection(null);
    try {
      const created = await createExternalAgentConnection({
        name: name.trim(),
        agentAudience: audience,
        runtime,
        protocols,
        capabilities: splitLines(capabilities),
        resources: splitLines(resources).map((resource) => {
          const separator = resource.indexOf(":");
          return separator > 0
            ? { resourceType: resource.slice(0, separator).trim(), resourceId: resource.slice(separator + 1).trim() }
            : { resourceType: "record", resourceId: resource };
        }),
        connectors: splitLines(connectors),
        credentialLabel: credentialLabel.trim(),
        idempotencyKey: crypto.randomUUID(),
      });
      setConnection(created);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to create external agent connection");
    } finally {
      setBusy(false);
    }
  };

  return <div className="min-h-[100dvh] p-4 sm:p-6 lg:p-8"><div className="mx-auto max-w-4xl space-y-6"><Link href="/agents" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" />Back to agents</Link><header><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">External access</p><h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">Connect an external agent</h1><p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">Create a dedicated external-connected installation for a runtime you operate elsewhere. KasiAi and hosted user agents are not selected or modified in this flow.</p></header>
    {error ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{error}</p> : null}
    {!connection ? <>
      <Card><CardContent className="space-y-4 p-6"><div className="flex items-start gap-3"><Plug className="mt-0.5 h-5 w-5 text-primary" /><div><h2 className="text-lg font-semibold text-foreground">1. Describe the external runtime</h2><p className="mt-1 text-sm text-muted-foreground">This creates a dedicated MCP connection. Read and write access follows the capabilities granted below; higher-risk actions may still require approval.</p></div></div><div className="grid gap-4 sm:grid-cols-2"><label className="text-sm font-medium text-foreground">Agent name<Input value={name} onChange={(event) => setName(event.target.value)} maxLength={160} placeholder="My operations agent" className="mt-2" /></label><label className="text-sm font-medium text-foreground">Runtime<Select value={runtime} onValueChange={setRuntime}><SelectTrigger className="mt-2"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="custom">Custom runtime</SelectItem><SelectItem value="codex">Codex</SelectItem><SelectItem value="claude">Claude</SelectItem><SelectItem value="n8n">n8n</SelectItem></SelectContent></Select></label></div><fieldset><legend className="text-sm font-medium text-foreground">Audience</legend><div className="mt-2 grid gap-2 sm:grid-cols-2"><button type="button" onClick={() => setAudience("personal")} className={`flex items-start gap-3 rounded-lg border p-3 text-left ${audience === "personal" ? "border-primary bg-primary/10" : "border-border bg-secondary/20"}`}><UserRound className="mt-0.5 h-4 w-4 shrink-0 text-primary" /><span><span className="block text-sm font-medium text-foreground">Personal</span><span className="mt-1 block text-xs text-muted-foreground">Private runtime and test access.</span></span></button><button type="button" onClick={() => setAudience("customer_service")} className={`flex items-start gap-3 rounded-lg border p-3 text-left ${audience === "customer_service" ? "border-primary bg-primary/10" : "border-border bg-secondary/20"}`}><Plug className="mt-0.5 h-4 w-4 shrink-0 text-primary" /><span><span className="block text-sm font-medium text-foreground">Customer service</span><span className="mt-1 block text-xs text-muted-foreground">Customer-facing runtime; handoff requires a supported adapter.</span></span></button></div></fieldset></CardContent></Card>
      <Card><CardContent className="space-y-4 p-6"><div><h2 className="text-lg font-semibold text-foreground">2. Review initial service access</h2><p className="mt-1 text-sm text-muted-foreground">Choose from the live capability catalog. Subscription, provider readiness, feature policy, grants, and approval requirements are rechecked when the client connects.</p></div>{catalogError ? <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">{catalogError}</p> : catalog ? <div className="grid gap-2 sm:grid-cols-2">{catalog.capabilities.map((capability) => <button key={capability.name} type="button" disabled={!capability.available} onClick={() => toggleCapability(capability)} className={`rounded-lg border p-3 text-left ${selectedCapabilityNames.includes(capability.name) ? "border-primary bg-primary/10" : "border-border bg-secondary/20"} disabled:cursor-not-allowed disabled:opacity-50`}><span className="flex items-center justify-between gap-2"><span className="font-mono text-xs text-foreground">{capability.name}</span><span className="text-[10px] font-medium text-muted-foreground">{capability.available ? capability.reasonCode === "approval_required" ? "Approval" : "Available" : (capability.reasonCode ?? "Unavailable").replaceAll("_", " ")}</span></span><span className="mt-1 block text-xs text-muted-foreground">{capability.description}</span><span className="mt-1 block text-[10px] text-muted-foreground">Subscription: {capability.subscription ?? "unknown"} · provider: {capability.providerReadiness ?? "unknown"}</span></button>)}</div> : <p className="text-sm text-muted-foreground">Loading the live service catalog…</p>}<label className="text-sm font-medium text-foreground">Selected capabilities<Textarea value={capabilities} onChange={(event) => setCapabilities(event.target.value)} rows={2} placeholder="Select services above or enter exact registered names" className="mt-2 resize-y font-mono text-xs" /></label>{invalidSelectedCapability ? <p className="text-xs text-status-attention">Select only capabilities that are currently available in the live catalog.</p> : null}<div className="grid gap-4 sm:grid-cols-2"><label className="text-sm font-medium text-foreground">Resource scopes<small className="mt-1 block font-normal text-muted-foreground">Use type:id, for example workspace:workspace-1</small><Textarea value={resources} onChange={(event) => setResources(event.target.value)} rows={3} placeholder="workspace:workspace-1" className="mt-2 resize-y font-mono text-xs" /></label><label className="text-sm font-medium text-foreground">Connector subscriptions<Textarea value={connectors} onChange={(event) => setConnectors(event.target.value)} rows={3} placeholder="telegram.messaging" className="mt-2 resize-y font-mono text-xs" /></label></div></CardContent></Card>
      <Card><CardContent className="space-y-4 p-6"><div className="flex items-start gap-3"><KeyRound className="mt-0.5 h-5 w-5 text-primary" /><div><h2 className="text-lg font-semibold text-foreground">3. Create the credential</h2><p className="mt-1 text-sm text-muted-foreground">Read and write actions are available wherever this agent has access. Higher-risk actions may still require approval.</p></div></div><div className="grid gap-3 sm:grid-cols-[1fr_auto]"><Input value={credentialLabel} onChange={(event) => setCredentialLabel(event.target.value)} placeholder="Credential label" /></div><Button type="button" disabled={!name.trim() || !credentialLabel.trim() || !protocols.length || invalidSelectedCapability || busy} onClick={() => void createConnection()}>{busy ? "Creating…" : "Create external connection"}</Button></CardContent></Card>
    </> : <>
      <Card><CardContent className="space-y-4 p-6"><div className="flex items-start gap-3"><CheckCircle2 className="mt-0.5 h-5 w-5 text-status-success" /><div><h2 className="text-lg font-semibold text-foreground">External connection created</h2><p className="mt-1 text-sm text-muted-foreground">This secret is shown once. Copy it before leaving this page; rotate or revoke it from the external installation details.</p></div></div><div className="rounded-xl border border-status-attention/40 bg-status-attention-soft p-4" role="alert"><p className="text-sm font-semibold text-status-attention">Copy this secret now</p><div className="mt-3 flex gap-2"><code className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-background px-3 py-2 text-xs text-foreground">{connection.secret}</code><Button type="button" variant="outline" size="sm" onClick={() => copy(connection.secret)}><Copy className="mr-1.5 h-3.5 w-3.5" />Copy</Button></div></div><div className="grid gap-3 text-sm sm:grid-cols-2"><div className="rounded-lg bg-secondary/50 p-3"><p className="text-xs text-muted-foreground">External installation</p><p className="mt-1 break-all font-mono text-xs text-foreground">{connection.installation.id}</p></div><div className="rounded-lg bg-secondary/50 p-3"><p className="text-xs text-muted-foreground">Runtime</p><p className="mt-1 font-medium capitalize text-foreground">{runtime}</p></div></div></CardContent></Card>
      <Card><CardContent className="space-y-4 p-6"><div><h2 className="text-lg font-semibold text-foreground">Connect the client</h2><p className="mt-1 text-sm text-muted-foreground">Exchange the copy-once secret once for a short-lived audience-bound token. The gateway re-checks installation status, capability grants, and resource scopes on every request.</p></div>{protocols.includes("mcp") ? <div><p className="text-xs font-medium text-foreground">MCP endpoint</p><div className="mt-1 flex gap-2"><code className="min-w-0 flex-1 rounded-lg bg-secondary px-3 py-2 text-xs text-muted-foreground">{mcpEndpoint}</code><Button type="button" variant="outline" size="sm" onClick={() => copy(mcpEndpoint)}><Copy className="h-3.5 w-3.5" /></Button></div></div> : null}{protocols.includes("rest") ? <div><p className="text-xs font-medium text-foreground">REST token exchange and discovery</p><div className="mt-1 flex gap-2"><pre className="min-w-0 flex-1 overflow-x-auto rounded-lg bg-secondary px-3 py-2 text-xs text-muted-foreground">{curlExample}</pre><Button type="button" variant="outline" size="sm" onClick={() => copy(curlExample)}><Copy className="h-3.5 w-3.5" /></Button></div></div> : null}<Button asChild variant="outline"><Link href={`/agents/${encodeURIComponent(connection.agent.id)}`}>Open external installation details</Link></Button></CardContent></Card>
    </>}</div></div>;
}
