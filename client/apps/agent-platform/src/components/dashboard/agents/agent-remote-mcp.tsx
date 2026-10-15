import { useCallback, useEffect, useState } from "react";
import { useRouteLoaderData } from "react-router-dom";
import type { Session } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import {
  listAgentMcpProviders, createAgentMcpProvider, discoverAgentMcpProvider,
  healthCheckAgentMcpProvider, publishAgentMcpProviderVersion, listAgentMcpProviderVersions,
  listAgentVersionMcpProviders, pinAgentMcpProviderVersion, unpinAgentMcpProviderVersion,
  getAgentInstallationReadiness, type AgentMcpProvider, type AgentMcpProviderVersion,
} from "@/lib/agent-platform";

export function AgentRemoteMcp({ installationId }: { installationId: string }) {
  const session = useRouteLoaderData("workspace") as Session;
  const canWrite = session.organizations?.find(org => org.id === session.activeOrganizationId)?.role !== "viewer";
  const [providers, setProviders] = useState<AgentMcpProvider[]>([]);
  const [versions, setVersions] = useState<Record<string, AgentMcpProviderVersion[]>>({});
  const [pins, setPins] = useState<AgentMcpProviderVersion[]>([]);
  const [versionId, setVersionId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [endpoint, setEndpoint] = useState("");
  const [credentialReference, setCredentialReference] = useState("");
  const [resultFields, setResultFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    const [listed, readiness] = await Promise.all([listAgentMcpProviders(), getAgentInstallationReadiness(installationId)]);
    const [pinned, revisions] = await Promise.all([
      listAgentVersionMcpProviders(readiness.versionId),
      Promise.all(listed.providers.map(async provider => [provider.id, (await listAgentMcpProviderVersions(provider.id)).versions] as const)),
    ]);
    setProviders(listed.providers); setVersionId(readiness.versionId); setPins(pinned.providers); setVersions(Object.fromEntries(revisions));
  }, [installationId]);
  useEffect(() => { void refresh().catch(error => setError(error instanceof Error ? error.message : "Unable to load remote tools.")); }, [refresh]);
  async function action(operation: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await operation(); await refresh(); }
    catch (error) { setError(error instanceof Error ? error.message : "Remote tool setup failed."); }
    finally { setBusy(false); }
  }
  return <Card><CardContent className="space-y-5 p-5">
    <div><h3 className="font-semibold">Remote MCP services</h3><p className="mt-1 text-sm text-muted-foreground">Discover a service's tools, review its version, then enable it for this agent's Playground. Each call requires approval. Website versions keep their existing pins.</p></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {canWrite && <form className="grid gap-3 sm:grid-cols-2" onSubmit={event => { event.preventDefault(); void action(async () => { await createAgentMcpProvider({ name: name.trim(), endpointUrl: endpoint.trim(), ...(credentialReference.trim() ? { credentialReference: credentialReference.trim() } : {}) }); setName(""); setEndpoint(""); setCredentialReference(""); }); }}>
      <label className="text-sm">Service name<Input className="mt-1" value={name} onChange={event => setName(event.target.value)} placeholder="Booking service" required maxLength={160} /></label>
      <label className="text-sm">MCP endpoint<Input className="mt-1" type="url" value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder="https://example.com/mcp" required /></label>
      <label className="text-sm">Saved credential reference <span className="text-muted-foreground">optional</span><Input className="mt-1" value={credentialReference} onChange={event => setCredentialReference(event.target.value)} placeholder="Saved server credential ID" /></label>
      <div className="flex items-end"><Button disabled={busy || !name.trim() || !endpoint.trim()}>Add service</Button></div>
    </form>}
    {!providers.length && !error ? <p className="text-sm text-muted-foreground">No remote services are configured in this workspace.</p> : null}
    {providers.map(provider => <article key={provider.id} className="space-y-3 rounded-lg border p-4">
      <div className="flex flex-wrap justify-between gap-3"><div><p className="font-medium">{provider.name}</p><p className="mt-1 break-all text-xs text-muted-foreground">{provider.endpoint_url}</p><p className="mt-1 text-xs text-muted-foreground">{provider.status} · {provider.health_status}{provider.health_failure_code ? ` · ${provider.health_failure_code}` : ""}</p></div>{canWrite && <div className="flex gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => void action(() => discoverAgentMcpProvider(provider.id))}>Discover tools</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => void action(() => healthCheckAgentMcpProvider(provider.id))}>Check health</Button></div>}</div>
      {(versions[provider.id] ?? []).map(version => { const enabled = pins.some(pin => pin.id === version.id); return <div key={version.id} className="rounded-md bg-muted/40 p-3"><div className="flex items-center justify-between gap-3"><p className="text-sm">Version {version.revision} · {version.status}{enabled ? " · Enabled in Playground" : ""}</p>{canWrite && <div className="flex gap-2">{version.status === "draft" && <Button size="sm" variant="outline" disabled={busy || provider.health_status !== "healthy"} onClick={() => void action(() => publishAgentMcpProviderVersion(provider.id, version.id, Object.fromEntries(version.tools.map(tool => [tool.name, (resultFields[`${version.id}:${tool.name}`] ?? "").split(",").map(field => field.trim()).filter(Boolean)]))))}>Approve version</Button>}{version.status === "published" && versionId && <Button size="sm" variant={enabled ? "outline" : "default"} disabled={busy || (!enabled && provider.health_status !== "healthy")} onClick={() => void action(() => enabled ? unpinAgentMcpProviderVersion(versionId, version.id) : pinAgentMcpProviderVersion(versionId, version.id))}>{enabled ? "Remove from Playground" : "Enable in Playground"}</Button>}</div>}</div><ul className="mt-2 space-y-1 text-xs text-muted-foreground">{version.tools.map(tool => <li key={tool.name}><span className="font-medium text-foreground">{tool.name}</span> · {tool.description || "No description supplied"}{version.status === "draft" && canWrite ? <label className="mt-2 block">Result fields the agent may use<Input aria-label={`Result fields for ${tool.name} version ${version.revision}`} disabled={busy} placeholder="reference, status" value={resultFields[`${version.id}:${tool.name}`] ?? ""} onChange={event => setResultFields(current => ({ ...current, [`${version.id}:${tool.name}`]: event.target.value }))} /><span>Comma-separated top-level fields. Only short text, numbers and flags are returned. Raw results stay redacted.</span></label> : <p className="mt-1">Agent result fields: {tool.reviewedResultFields?.join(", ") || "None"}</p>}</li>)}</ul></div>; })}
    </article>)}
  </CardContent></Card>;
}
