import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/button";

type RequestDetails = { request: { clientName: string; clientId: string; redirectHost: string; scopes: string[] }; organizations: { id: string; name: string }[] };

export function McpConsent() {
  const [parameters] = useSearchParams();
  const requestId = parameters.get("request");
  const [details, setDetails] = useState<RequestDetails | null>(null);
  const [organization, setOrganization] = useState("");
  const [agents, setAgents] = useState<Array<{ id: string; name: string }> | null>(null);
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!requestId) { setError("This request is unavailable."); return; }
    const controller = new AbortController();
    void fetch(`/api/mcp/oauth/requests/${encodeURIComponent(requestId)}`, { credentials: "same-origin", signal: controller.signal })
      .then(async response => {
        if (response.status === 401) {
          window.location.assign(`/login?returnTo=${encodeURIComponent(window.location.pathname + window.location.search)}`);
          return;
        }
        if (!response.ok) throw new Error("This request is unavailable or has expired.");
        const value = await response.json() as RequestDetails;
        setDetails(value);
        if (value.organizations.length === 1) setOrganization(value.organizations[0]!.id);
      }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not load request."); });
    return () => controller.abort();
  }, [requestId]);

  const needsAgents = details?.request.scopes.includes("runs:start") ?? false;
  useEffect(() => {
    if (!organization || !needsAgents) return;
    const controller = new AbortController();
    setAgents(null); setSelectedAgents([]); setError("");
    void fetch(`/api/organizations/${encodeURIComponent(organization)}/agents`, { credentials: "same-origin", signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error("Could not load agents.");
        const value = await response.json() as { agents: Array<{ id: string; name: string }> };
        setAgents(value.agents);
      }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Could not load agents."); });
    return () => controller.abort();
  }, [organization, needsAgents]);

  async function decide(approved: boolean) {
    if (!requestId || busy || (approved && (!organization || (needsAgents && !selectedAgents.length)))) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/mcp/oauth/requests/${encodeURIComponent(requestId)}/decision`, {
        method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" },
        body: JSON.stringify({ approved, ...(approved ? { organizationId: organization, ...(needsAgents ? { agentIds: selectedAgents } : {}) } : {}) }),
      });
      if (!response.ok) throw new Error("Could not complete the request. Try again.");
      const value = await response.json() as { redirectUrl: string };
      window.location.assign(value.redirectUrl);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Could not complete the request."); setBusy(false); }
  }

  return <main className="dashboard-theme min-h-dvh bg-background px-6 py-16 text-foreground">
    <section className="mx-auto max-w-lg space-y-6 rounded-xl border border-border bg-card p-6">
      <h1 className="text-xl font-semibold">Connect to Agents</h1>
      {!details && !error && <p role="status">Loading request…</p>}
      {details && <>
        <p><strong>{details.request.clientName}</strong> requests access to your agents. <span className="text-muted-foreground">App name unverified</span></p>
        <dl className="space-y-2 text-sm">
          <div><dt className="text-muted-foreground">Callback host</dt><dd className="break-all">{details.request.redirectHost || "Unavailable"}</dd></div>
          <div><dt className="text-muted-foreground">Client ID</dt><dd className="break-all">{details.request.clientId || "Unavailable"}</dd></div>
        </dl>
        <label className="block space-y-2 text-sm">Organization
          <select className="w-full rounded-md border border-border bg-background p-2" value={organization} onChange={event => { setSelectedAgents([]); setOrganization(event.target.value); }} disabled={busy}>
            <option value="">Select organization</option>
            {details.organizations.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <div><h2 className="text-sm font-medium">Access requested</h2><ul className="mt-2 list-inside list-disc text-sm">{details.request.scopes.map(scope => <li key={scope}>{scope === "agents:read" ? "View agents and configuration" : scope === "agents:manage" ? "Create and manage agents" : scope === "runs:start" ? "Start agent runs" : scope === "runs:read" ? "View agent runs" : scope}</li>)}</ul></div>
        {needsAgents && organization ? <fieldset disabled={busy} className="space-y-2"><legend className="text-sm font-medium">Agents</legend>
          {!agents ? <p role="status" className="text-sm text-muted-foreground">Loading agents…</p> : agents.length ? agents.map(agent => <label key={agent.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={selectedAgents.includes(agent.id)} onChange={event => setSelectedAgents(current => event.target.checked ? [...current, agent.id] : current.filter(id => id !== agent.id))} />{agent.name}</label>) : <p className="text-sm text-muted-foreground">No agents available</p>}
        </fieldset> : null}
        <div className="flex gap-3"><Button onClick={() => void decide(true)} disabled={busy || !organization || !details.request.clientId || !details.request.redirectHost || (needsAgents && !selectedAgents.length)}>Connect</Button><Button variant="outline" onClick={() => void decide(false)} disabled={busy}>Cancel</Button></div>
      </>}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    </section>
  </main>;
}
