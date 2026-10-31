import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, message, organizationPath, type Agent, type Configuration, type DelegationBinding } from "./api";
import { ErrorMessage } from "./shell";

const adaptiveTools = ["agents.discover", "agents.start", "agents.status", "agents.result", "agents.wait", "agents.followup", "agents.cancel", "work.update", "work.inspect"] as const;

type Specialist = { agentId: string; name: string; description: string; versionId: string; versionNumber: number; ready: boolean; reasons: string[]; skillCount?: number; sourceRevisionIds: string[]; tools: DelegationBinding["tools"]; connectedToolBindingIds: string[] };
export function SpecialistConfiguration({ organizationId, agentId, draftRevision, configuration, onChange }: { organizationId: string; agentId: string; draftRevision: number; configuration: Configuration; onChange: (configuration: Configuration) => void }) {
  const [specialists, setSpecialists] = useState<Specialist[] | null>(null);
  const [error, setError] = useState("");
  const [generation, setGeneration] = useState(0);
  const [creating, setCreating] = useState(false);
  const delegation = configuration.capabilities.delegation;
  const bindings = delegation.enabled ? delegation.bindings : [];
  const adaptive = configuration.program?.id === "tool-directed" && configuration.program.version === "4";
  const canEnableAdaptive = configuration.executionKind === "business" && !configuration.productBindings?.length && configuration.program?.version !== "3";
  const bindingLimit = adaptive ? 32 : 2;
  const [savedPolicy, setSavedPolicy] = useState(() => ({ maxChildren: delegation.enabled ? delegation.maxChildren : 2, maxTasks: delegation.enabled ? delegation.policy?.maxTasks ?? 16 : 16, maxStalls: delegation.enabled ? delegation.policy?.maxStalls ?? 3 : 3 }));
  const contextReady = (configuration.context?.maxInputTokens ?? 8192) >= 24000 && (configuration.context?.maxInputTokens ?? 8192) + configuration.model.maxOutputTokens <= 32000;
  function enableAdaptive() {
    const maxInputTokens = Math.max(configuration.context?.maxInputTokens ?? 8192, Math.max(1, Math.min(24000, 32000 - configuration.model.maxOutputTokens)));
    const compactAtTokens = Math.max(configuration.context?.compactAtTokens ?? 6144, Math.min(22000, maxInputTokens - 1));
    const tools = (configuration.tools ?? []).filter(tool => !(adaptiveTools as readonly string[]).includes(tool));
    onChange({ ...configuration, program: { id: "tool-directed", version: "4" }, context: { maxInputTokens, compactAtTokens }, tools: bindings.length ? [...new Set([...tools, ...adaptiveTools])] : tools, capabilities: { ...configuration.capabilities, delegation: bindings.length ? { enabled: true, bindings, maxChildren: savedPolicy.maxChildren, maxDepth: 1, policy: { maxTasks: savedPolicy.maxTasks, maxStalls: savedPolicy.maxStalls } } : { enabled: false } } });
  }
  function policy(field: "maxChildren" | "maxTasks" | "maxStalls", value: number) {
    if (!delegation.enabled || !Number.isInteger(value)) return;
    const limit = field === "maxTasks" ? 64 : 8;
    if (value < 1 || value > limit) return;
    setSavedPolicy(current => ({ ...current, [field]: value }));
    onChange({ ...configuration, capabilities: { ...configuration.capabilities, delegation: field === "maxChildren" ? { ...delegation, maxChildren: value } : { ...delegation, policy: { maxTasks: 16, maxStalls: 3, ...delegation.policy, [field]: value } } } });
  }
  useEffect(() => {
    let live = true;
    api<{ specialists: Specialist[] }>(`${organizationPath(organizationId)}/agents/${encodeURIComponent(agentId)}/specialists`).then(result => { if (live) { setSpecialists(result.specialists); setError(""); } }).catch(e => { if (live) setError(message(e)); });
    return () => { live = false; };
  }, [organizationId, agentId, draftRevision, generation]);
  function change(next: DelegationBinding[]) {
    const tools = (configuration.tools ?? []).filter(tool => tool !== "agents.delegate" && (!adaptive || !(adaptiveTools as readonly string[]).includes(tool)));
    if (delegation.enabled) setSavedPolicy({ maxChildren: delegation.maxChildren, maxTasks: delegation.policy?.maxTasks ?? 16, maxStalls: delegation.policy?.maxStalls ?? 3 });
    const limits = delegation.enabled ? { maxChildren: delegation.maxChildren, maxTasks: delegation.policy?.maxTasks ?? 16, maxStalls: delegation.policy?.maxStalls ?? 3 } : savedPolicy;
    onChange({ ...configuration, tools: next.length ? [...tools, "agents.delegate", ...(adaptive ? adaptiveTools : [])] : tools, capabilities: { ...configuration.capabilities, delegation: next.length ? { enabled: true, bindings: next, maxChildren: adaptive ? limits.maxChildren : 2, maxDepth: 1, ...(adaptive ? { policy: { maxTasks: limits.maxTasks, maxStalls: limits.maxStalls } } : {}) } : { enabled: false } } });
  }
  function select(specialist: Specialist) {
    if (bindings.some(binding => binding.versionId === specialist.versionId)) change(bindings.filter(binding => binding.versionId !== specialist.versionId));
    else if (bindings.length < bindingLimit) change([...bindings, { id: `specialist_${specialist.agentId.replaceAll("-", "")}`, versionId: specialist.versionId, versionNumber: specialist.versionNumber, label: specialist.name, description: specialist.description, sourceRevisionIds: specialist.sourceRevisionIds.filter(id => configuration.sourceRevisionIds?.includes(id)), connectedToolBindingIds: specialist.connectedToolBindingIds, tools: specialist.tools, maxTokens: 8000, maxActiveMs: 120000 }]);
  }
  return <section className="agent-config-panel space-y-4" aria-label="Specialists">
    <div className="flex flex-wrap items-center justify-between gap-2"><h2>Specialists</h2><Button type="button" size="sm" variant="outline" onClick={() => setCreating(true)}>Create specialist</Button></div>
    {adaptive ? <fieldset disabled={!delegation.enabled} className="space-y-3 rounded-md border border-border p-3"><legend className="px-1 text-sm font-medium">Adaptive orchestration</legend><div className="grid gap-3 sm:grid-cols-3">
      <label className="space-y-2 text-sm">Concurrent tasks<Input aria-label="Concurrent tasks" type="number" min={1} max={8} value={delegation.enabled ? delegation.maxChildren : 2} onChange={event => policy("maxChildren", Number(event.target.value))} /></label>
      <label className="space-y-2 text-sm">Total tasks<Input aria-label="Total tasks" type="number" min={1} max={64} value={delegation.enabled ? delegation.policy?.maxTasks ?? 16 : 16} onChange={event => policy("maxTasks", Number(event.target.value))} /></label>
      <label className="space-y-2 text-sm">Stall limit<Input aria-label="Stall limit" type="number" min={1} max={8} value={delegation.enabled ? delegation.policy?.maxStalls ?? 3 : 3} onChange={event => policy("maxStalls", Number(event.target.value))} /></label>
    </div></fieldset> : canEnableAdaptive ? <Button type="button" variant="outline" onClick={enableAdaptive}>Enable adaptive orchestration</Button> : null}
    {adaptive && !bindings.length ? <p className="text-sm text-muted-foreground">No specialists selected</p> : null}
    {adaptive && !contextReady ? <p role="status" className="text-sm text-destructive">Review model limits: orchestration needs room for tool schemas and specialist results.</p> : null}
    <ErrorMessage value={error} />
    {error ? <Button type="button" variant="outline" onClick={() => setGeneration(value => value + 1)}>Retry specialists</Button> : !specialists ? <div role="status" className="h-16 animate-pulse rounded bg-muted" aria-label="Loading specialists" /> : <>
      {bindings.map(binding => {
        const selected = specialists.find(specialist => specialist.versionId === binding.versionId);
        return <div key={binding.id} className="space-y-2 rounded-md border border-border p-3">
          <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-medium">{binding.label ?? selected?.name ?? "Specialist"} · v{binding.versionNumber ?? selected?.versionNumber ?? "?"}</span><Button type="button" size="sm" variant="ghost" onClick={() => change(bindings.filter(item => item.id !== binding.id))}>Remove</Button></div>
          <p className="break-words text-sm text-muted-foreground">{binding.description ?? selected?.description}</p>
          {selected?.skillCount ? <p className="text-xs text-muted-foreground">{selected.skillCount} {selected.skillCount === 1 ? "skill" : "skills"}</p> : null}
          {!selected || !selected.ready ? <p className="text-sm text-destructive">{selected?.reasons.join(". ") || "Pinned version unavailable"}</p> : <p className="text-xs text-muted-foreground">Ready</p>}
        </div>;
      })}
      {specialists.length === 0 && !bindings.length ? <p className="text-sm text-muted-foreground">No published specialists</p> : null}
      <ul className="divide-y divide-border">{specialists.filter(specialist => !bindings.some(binding => binding.versionId === specialist.versionId)).map(specialist => <li key={specialist.versionId} className="space-y-2 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><Link className="text-sm font-medium underline underline-offset-4" to={`/app/agents/${encodeURIComponent(specialist.agentId)}?section=configuration`}>{specialist.name} · v{specialist.versionNumber}</Link><Button type="button" size="sm" variant="outline" disabled={!specialist.ready || bindings.length >= bindingLimit || bindings.some(binding => binding.id === `specialist_${specialist.agentId.replaceAll("-", "")}`)} onClick={() => select(specialist)}>Add specialist</Button></div>
        <p className="break-words text-sm text-muted-foreground">{specialist.description}</p>
        {specialist.skillCount ? <p className="text-xs text-muted-foreground">{specialist.skillCount} {specialist.skillCount === 1 ? "skill" : "skills"}</p> : null}
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
