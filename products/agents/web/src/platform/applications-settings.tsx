import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useConfirmationDialog } from "@/components/ui/confirmation-provider";
import { api, message, organizationPath, type Agent } from "./api";
import { ErrorMessage } from "./shell";

type Credential = { id: string; scopes: string[]; createdAt: string; revokedAt: string | null };
type Application = { id: string; name: string; agentIds: string[]; revokedAt: string | null; credentials: Credential[] };
const permissions = [
  { value: "agents:read", label: "View agents" },
  { value: "runs:start", label: "Start runs" },
  { value: "runs:read", label: "View runs" },
  { value: "runs:control", label: "Control runs" },
] as const;

export function ApplicationsSettings({ organizationId }: { organizationId: string }) {
  const base = organizationPath(organizationId);
  const { confirm } = useConfirmationDialog();
  const [applications, setApplications] = useState<Application[] | null>(null);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [open, setOpen] = useState(false), [name, setName] = useState(""), [selected, setSelected] = useState<string[]>([]);
  const [keyFor, setKeyFor] = useState<Application | null>(null), [scopes, setScopes] = useState<string[]>(["agents:read"]);
  const [secret, setSecret] = useState<string | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let live = true;
    Promise.all([api<{ applications: Application[] }>(`${base}/applications`), api<{ agents: Agent[] }>(`${base}/agents`)])
      .then(([list, available]) => { if (live) { setApplications(list.applications); setAgents(available.agents); setError(""); } })
      .catch(reason => { if (live) setError(message(reason)); });
    return () => { live = false; };
  }, [base, generation]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy || !name.trim() || !selected.length || !scopes.length) return;
    setBusy(true); setError("");
    try {
      const result = await api<{ credential: { secret: string } }>(`${base}/applications`, { name: name.trim(), agentIds: selected, scopes });
      setOpen(false); setName(""); setSelected([]); setScopes(["agents:read"]); setSecret(result.credential.secret); setGeneration(value => value + 1);
    } catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  }
  async function issue(application: Application) {
    setBusy(true); setError("");
    try {
      const result = await api<{ credential: { secret: string } }>(`${base}/applications/${application.id}/credentials`, { scopes });
      setKeyFor(null); setScopes(["agents:read"]); setSecret(result.credential.secret); setGeneration(value => value + 1);
    } catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  }
  async function revoke(path: string, title: string) {
    if (!await confirm({ title, description: "Access will stop.", confirmLabel: "Revoke", variant: "destructive" })) return;
    setBusy(true); setError("");
    try { await api(path, {}); toast.success("Access revoked"); setGeneration(value => value + 1); }
    catch (reason) { setError(message(reason)); } finally { setBusy(false); }
  }

  return <section className="space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-base font-semibold">Applications</h2><Button size="sm" onClick={() => { setError(""); setOpen(true); }}>Create application</Button></div>
    <ErrorMessage value={open ? "" : error} />
    {!applications && !error ? <div role="status" aria-label="Loading applications" className="h-20 animate-pulse rounded-md bg-muted" /> : null}
    {applications?.length === 0 ? <p className="text-sm text-muted-foreground">No applications yet</p> : null}
    <div className="divide-y divide-border">{applications?.map(application => <article key={application.id} className="space-y-3 py-4 first:pt-0">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="font-medium">{application.name}</h3><p className="text-sm text-muted-foreground">{application.revokedAt ? "Revoked" : `${application.agentIds.length} agents`}</p></div>
        {!application.revokedAt ? <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => { setError(""); setScopes(["agents:read"]); setKeyFor(application); }}>New key</Button><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void revoke(`${base}/applications/${application.id}/revoke`, `Revoke ${application.name}?`)}>Revoke</Button></div> : null}</div>
      {application.credentials.filter(credential => !credential.revokedAt && !application.revokedAt).map((credential, index) => <div key={credential.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"><span>Key {index + 1} · {new Date(credential.createdAt).toLocaleString()}</span><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void revoke(`${base}/applications/${application.id}/credentials/${credential.id}/revoke`, `Revoke key ${index + 1}?`)}>Revoke</Button></div>)}
    </article>)}</div>
    <Dialog open={open} onOpenChange={value => { if (!busy) { setOpen(value); setError(""); } }}><DialogContent showCloseButton={!busy}><DialogHeader><DialogTitle>Create application</DialogTitle><DialogDescription>Select agents and key permissions.</DialogDescription></DialogHeader>
      <form className="space-y-4" onSubmit={event => void create(event)}><label className="block space-y-2 text-sm">Name<Input autoFocus required maxLength={120} value={name} onChange={event => setName(event.target.value)} /></label><fieldset className="max-h-56 space-y-2 overflow-y-auto"><legend className="text-sm font-medium">Agents</legend>{agents.length ? agents.map(agent => <label key={agent.id} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={selected.includes(agent.id)} onChange={event => setSelected(current => event.target.checked ? [...current, agent.id] : current.filter(id => id !== agent.id))} />{agent.name}</label>) : <p className="text-sm text-muted-foreground">No agents available</p>}</fieldset><fieldset className="space-y-2"><legend className="text-sm font-medium">Permissions</legend>{permissions.map(permission => <label key={permission.value} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={scopes.includes(permission.value)} onChange={event => setScopes(current => event.target.checked ? [...current, permission.value] : current.filter(scope => scope !== permission.value))} />{permission.label}</label>)}</fieldset><ErrorMessage value={error} /><DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" disabled={busy || !name.trim() || !selected.length || !scopes.length}>{busy ? "Creating…" : "Create"}</Button></DialogFooter></form>
    </DialogContent></Dialog>
    <Dialog open={keyFor !== null} onOpenChange={value => { if (!value && !busy) setKeyFor(null); }}><DialogContent><DialogHeader><DialogTitle>New key</DialogTitle><DialogDescription>Select key permissions.</DialogDescription></DialogHeader><fieldset className="space-y-2"><legend className="text-sm font-medium">Permissions</legend>{permissions.map(permission => <label key={permission.value} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={scopes.includes(permission.value)} onChange={event => setScopes(current => event.target.checked ? [...current, permission.value] : current.filter(scope => scope !== permission.value))} />{permission.label}</label>)}</fieldset><ErrorMessage value={error} /><DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => setKeyFor(null)}>Cancel</Button><Button type="button" disabled={busy || !scopes.length} onClick={() => { if (keyFor) void issue(keyFor); }}>{busy ? "Creating…" : "Create key"}</Button></DialogFooter></DialogContent></Dialog>
    <Dialog open={secret !== null} onOpenChange={value => { if (!value) setSecret(null); }}><DialogContent><DialogHeader><DialogTitle>Application key</DialogTitle><DialogDescription>Copy this key now. It will not be shown again.</DialogDescription></DialogHeader><Input aria-label="Application key" readOnly value={secret ?? ""} /><DialogFooter><Button type="button" variant="outline" onClick={() => { if (secret) void navigator.clipboard.writeText(secret).then(() => toast.success("Key copied")).catch(() => toast.error("Could not copy key")); }}>Copy key</Button><Button type="button" onClick={() => setSecret(null)}>Done</Button></DialogFooter></DialogContent></Dialog>
  </section>;
}
