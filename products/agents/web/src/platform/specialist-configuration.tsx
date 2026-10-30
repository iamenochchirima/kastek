import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, message, organizationPath, type Agent, type Configuration, type DelegationBinding } from "./api";
import { ErrorMessage } from "./shell";

type Specialist = { agentId: string; name: string; description: string; versionId: string; versionNumber: number; ready: boolean; reasons: string[]; sourceRevisionIds: string[]; tools: DelegationBinding["tools"]; connectedToolBindingIds: string[] };
export function SpecialistConfiguration({ organizationId, agentId, draftRevision, configuration, onChange }: { organizationId: string; agentId: string; draftRevision: number; configuration: Configuration; onChange: (configuration: Configuration) => void }) {
  const [specialists, setSpecialists] = useState<Specialist[] | null>(null);
  const [error, setError] = useState("");
  const [generation, setGeneration] = useState(0);
  const [creating, setCreating] = useState(false);
  const delegation = configuration.capabilities.delegation;
  const bindings = delegation.enabled ? delegation.bindings : [];
  useEffect(() => {
    let live = true;
    api<{ specialists: Specialist[] }>(`${organizationPath(organizationId)}/agents/${encodeURIComponent(agentId)}/specialists`).then(result => { if (live) { setSpecialists(result.specialists); setError(""); } }).catch(e => { if (live) setError(message(e)); });
    return () => { live = false; };
  }, [organizationId, agentId, draftRevision, generation]);
  function change(next: DelegationBinding[]) {
    const tools = (configuration.tools ?? []).filter(tool => tool !== "agents.delegate");
    onChange({ ...configuration, tools: next.length ? [...tools, "agents.delegate"] : tools, capabilities: { ...configuration.capabilities, delegation: next.length ? { enabled: true, bindings: next, maxChildren: 2, maxDepth: 1 } : { enabled: false } } });
  }
  function select(specialist: Specialist) {
    if (bindings.some(binding => binding.versionId === specialist.versionId)) change(bindings.filter(binding => binding.versionId !== specialist.versionId));
    else if (bindings.length < 2) change([...bindings, { id: `specialist_${specialist.agentId.replaceAll("-", "")}`, versionId: specialist.versionId, versionNumber: specialist.versionNumber, label: specialist.name, description: specialist.description, sourceRevisionIds: specialist.sourceRevisionIds.filter(id => configuration.sourceRevisionIds?.includes(id)), connectedToolBindingIds: specialist.connectedToolBindingIds, tools: specialist.tools, maxTokens: 8000, maxActiveMs: 120000 }]);
  }
  return <section className="agent-config-panel space-y-4" aria-label="Specialists">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2>Specialists</h2><Button type="button" size="sm" variant="outline" onClick={() => setCreating(true)}>Create specialist</Button></div>
    <p className="text-sm text-muted-foreground">Up to two pinned specialists. Save changes to apply selection.</p>
    <ErrorMessage value={error} />
    {error ? <Button type="button" variant="outline" onClick={() => setGeneration(value => value + 1)}>Retry specialists</Button> : !specialists ? <div role="status" className="h-16 animate-pulse rounded bg-muted" aria-label="Loading specialists" /> : <>
      {bindings.map(binding => {
        const selected = specialists.find(specialist => specialist.versionId === binding.versionId);
        return <div key={binding.id} className="space-y-2 rounded-md border border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-medium">{binding.label ?? selected?.name ?? "Specialist"} · v{binding.versionNumber ?? selected?.versionNumber ?? "?"}</span><Button type="button" size="sm" variant="ghost" onClick={() => change(bindings.filter(item => item.id !== binding.id))}>Remove</Button></div>
          <p className="break-words text-sm text-muted-foreground">{binding.description ?? selected?.description}</p>
          {!selected || !selected.ready ? <p className="text-sm text-destructive">{selected?.reasons.join(". ") || "Pinned version unavailable"}</p> : <p className="text-xs text-muted-foreground">Ready</p>}
        </div>;
      })}
      {specialists.length === 0 && !bindings.length ? <p className="text-sm text-muted-foreground">No published specialists</p> : null}
      <ul className="divide-y divide-border">{specialists.filter(specialist => !bindings.some(binding => binding.versionId === specialist.versionId)).map(specialist => <li key={specialist.versionId} className="space-y-2 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><Link className="text-sm font-medium underline underline-offset-4" to={`/app/agents/${encodeURIComponent(specialist.agentId)}?section=configuration`}>{specialist.name} · v{specialist.versionNumber}</Link><Button type="button" size="sm" variant="outline" disabled={!specialist.ready || bindings.length >= 2 || bindings.some(binding => binding.id === `specialist_${specialist.agentId.replaceAll("-", "")}`)} onClick={() => select(specialist)}>Add specialist</Button></div>
        <p className="break-words text-sm text-muted-foreground">{specialist.description}</p>
        <p className={`text-xs ${specialist.ready ? "text-muted-foreground" : "text-destructive"}`}>{specialist.ready ? "Ready" : specialist.reasons.join(". ") || "Needs configuration"}</p>
      </li>)}</ul>
    </>}
    <CreateSpecialist open={creating} onOpenChange={setCreating} organizationId={organizationId} />
  </section>;
}

function CreateSpecialist({ open, onOpenChange, organizationId }: { open: boolean; onOpenChange: (open: boolean) => void; organizationId: string }) {
  const navigate = useNavigate();
  const [name, setName] = useState("Content");
  const [instructions, setInstructions] = useState("Write a text draft for the requesting member from the supplied brief and permitted context. Ask for missing details when needed. Return the draft to the coordinating assistant. Do not publish or claim that anything was published.");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [operationId] = useState(() => crypto.randomUUID());
  async function create(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    const configuration: Configuration = { executionKind: "business", program: { id: "tool-directed", version: "1" }, instructions, model: { selection: { kind: "organization_default" }, maxInputBytes: 16384, maxOutputTokens: 4096, maxDurationSeconds: 120 }, sourceRevisionIds: [], connectedToolBindingIds: [], tools: [], memory: { enabled: false }, capabilities: { delegation: { enabled: false }, sandbox: { enabled: false }, businessActions: { enabled: false }, workflows: { enabled: false }, schedules: { enabled: false } } };
    try { const result = await api<{ agent: Agent }>(`${organizationPath(organizationId)}/agents`, { name, configuration, operationId }); toast.success("Specialist created"); onOpenChange(false); navigate(`/app/agents/${encodeURIComponent(result.agent.id)}?section=configuration`); }
    catch (e) { setError(message(e)); }
    finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={value => { if (!busy) onOpenChange(value); }}><DialogContent showCloseButton={!busy}><DialogHeader><DialogTitle>Create specialist</DialogTitle><DialogDescription>Creates a business agent with private text output.</DialogDescription></DialogHeader><form onSubmit={event => void create(event)} className="space-y-4"><ErrorMessage value={error} /><label className="block space-y-2 text-sm">Name<Input required maxLength={120} value={name} onChange={event => setName(event.target.value)} /></label><label className="block space-y-2 text-sm">Instructions<Textarea required rows={6} maxLength={8000} value={instructions} onChange={event => setInstructions(event.target.value)} /></label><div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>Cancel</Button><Button type="submit" disabled={busy || !name.trim() || !instructions.trim()}>{busy ? "Creating…" : "Create specialist"}</Button></div></form></DialogContent></Dialog>;
}
