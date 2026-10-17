import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, message, organizationPath, type Agent, type Configuration, type DelegationBinding, type KnowledgeSource, type CapabilityBinding, type Version } from "./api";
import { ErrorMessage } from "./shell";

type Specialist = { agentName: string; version: Version };
export function ExecutionConfiguration({ organizationId, agentId, configuration, knowledge, connectedBindings, onChange }: {
  organizationId: string; agentId: string; configuration: Configuration; knowledge: KnowledgeSource[]; connectedBindings: CapabilityBinding[]; onChange: (value: Configuration) => void;
}) {
  const [specialists, setSpecialists] = useState<Specialist[] | null>(null);
  const [error, setError] = useState("");
  const delegation = configuration.capabilities.delegation;
  useEffect(() => {
    if (!delegation.enabled) return;
    let live = true;
    const path = `${organizationPath(organizationId)}/agents`;
    api<{ agents: Agent[] }>(path).then(async result => {
      const records = await Promise.all(result.agents.filter(agent => agent.id !== agentId).map(async agent => {
        const detail = await api<{ versions: Version[] }>(`${path}/${encodeURIComponent(agent.id)}`);
        return detail.versions.filter(version => version.configuration.executionKind === "business" && !version.configuration.capabilities.delegation.enabled && !version.configuration.capabilities.sandbox.enabled && !version.configuration.memory?.enabled && !version.configuration.capabilities.workflows.enabled).map(version => ({ agentName: agent.name, version }));
      }));
      if (live) setSpecialists(records.flat());
    }).catch(e => { if (live) setError(message(e)); });
    return () => { live = false; };
  }, [organizationId, agentId, delegation.enabled]);
  function bindingsChanged(bindings: DelegationBinding[]) {
    onChange({ ...configuration, capabilities: { ...configuration.capabilities, delegation: { enabled: true, bindings, maxChildren: 2, maxDepth: 1 } } });
  }
  function selectBinding(index: number, versionId: string) {
    if (!delegation.enabled) return;
    const selected = specialists?.find(item => item.version.id === versionId);
    if (!selected) return;
    const previous = delegation.bindings[index];
    const binding: DelegationBinding = { id: previous?.id ?? crypto.randomUUID(), versionId, knowledgeIds: [], sourceRevisionIds: [], connectedToolBindingIds: [], tools: [], maxTokens: previous?.maxTokens ?? 8000, maxActiveMs: previous?.maxActiveMs ?? 240000 };
    const next = [...delegation.bindings]; next[index] = binding; bindingsChanged(next);
  }
  return <div className="space-y-6 border-t border-border pt-6">
    <fieldset className="space-y-4"><legend className="mb-3 text-sm font-medium">Specialists</legend>
      <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-primary" checked={delegation.enabled} onChange={event => onChange({ ...configuration, capabilities: { ...configuration.capabilities, delegation: event.target.checked ? { enabled: true, bindings: [], maxChildren: 2, maxDepth: 1 } : { enabled: false } }, tools: event.target.checked ? [...new Set([...(configuration.tools ?? []), "agents.delegate" as const])] : (configuration.tools ?? []).filter(tool => tool !== "agents.delegate") })} /><span>Delegate to specialists</span></label>
      {delegation.enabled ? <><ErrorMessage value={error} />{specialists === null && !error ? <p role="status" className="text-sm text-muted-foreground">Loading published versions…</p> : null}
        {specialists?.length === 0 ? <p className="text-sm text-muted-foreground">No eligible specialist versions. Publish another business agent with memory, delegation and analysis disabled.</p> : null}
        {Array.from({ length: Math.max(1, delegation.bindings.length) }, (_, index) => {
          const binding = delegation.bindings[index];
          const selected = specialists?.find(item => item.version.id === binding?.versionId);
          const availableTools = (["knowledge.search", "knowledge.read"] as const).filter(tool => selected?.version.configuration.tools?.includes(tool));
          const sources = knowledge.flatMap(source => source.state === "active" ? source.revisions.filter(revision => revision.state === "approved" && (configuration.sourceRevisionIds ?? []).includes(revision.id) && (selected?.version.configuration.sourceRevisionIds ?? []).includes(revision.id)).map(revision => ({ source, revision })) : []);
          const sharedTools = connectedBindings.filter(tool => (configuration.connectedToolBindingIds ?? []).includes(tool.id) && (selected?.version.configuration.connectedToolBindingIds ?? []).includes(tool.id));
          return <fieldset key={binding?.id ?? index} aria-label={`Specialist ${index + 1} configuration`} className="space-y-3 rounded-md border border-border p-4"><div className="flex items-end gap-3"><label className="min-w-0 flex-1 space-y-2 text-sm">Specialist {index + 1}<select required aria-label={`Specialist ${index + 1}`} className="w-full min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm" value={binding?.versionId ?? ""} onChange={event => selectBinding(index, event.target.value)}><option value="" disabled>Select a published version</option>{binding && !selected ? <option value={binding.versionId}>Pinned version unavailable</option> : null}{specialists?.filter(item => !delegation.bindings.some((other, otherIndex) => otherIndex !== index && other.versionId === item.version.id)).map(item => <option key={item.version.id} value={item.version.id}>{item.agentName} · Version {item.version.number}</option>)}</select></label>{binding ? <Button type="button" variant="ghost" size="sm" onClick={() => bindingsChanged(delegation.bindings.filter((_, position) => position !== index))}>Remove</Button> : null}</div>
            {binding ? <><fieldset className="space-y-2"><legend className="mb-2 text-xs font-medium">Shared knowledge</legend>{sources.length ? sources.map(({ source, revision }) => <label key={revision.id} className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-0.5 size-4 accent-primary" checked={(binding.sourceRevisionIds ?? []).includes(revision.id)} onChange={event => bindingsChanged(delegation.bindings.map((item, position) => position === index ? { ...item, sourceRevisionIds: event.target.checked ? [...(item.sourceRevisionIds ?? []), revision.id] : (item.sourceRevisionIds ?? []).filter(id => id !== revision.id) } : item))} />{source.title} · Revision {revision.revision}</label>) : <p className="text-xs text-muted-foreground">No shared sources selected.</p>}</fieldset>
              {sources.length && availableTools.length ? <label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-0.5 size-4 accent-primary" checked={binding.tools.length > 0} onChange={event => bindingsChanged(delegation.bindings.map((item, position) => position === index ? { ...item, tools: event.target.checked ? availableTools : [] } : item))} />{availableTools.length === 2 ? "Allow knowledge search and reading" : availableTools[0] === "knowledge.search" ? "Allow knowledge search" : "Allow reading sources"}</label> : null}
              <fieldset className="space-y-2"><legend className="mb-2 text-xs font-medium">Shared connected tools</legend>{sharedTools.length ? sharedTools.map(tool => <label key={tool.id} className="flex min-w-0 items-start gap-3 text-sm"><input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-primary" checked={(binding.connectedToolBindingIds ?? []).includes(tool.id)} onChange={event => bindingsChanged(delegation.bindings.map((item, position) => position === index ? { ...item, connectedToolBindingIds: event.target.checked ? [...(item.connectedToolBindingIds ?? []), tool.id] : (item.connectedToolBindingIds ?? []).filter(id => id !== tool.id) } : item))} /><span className="min-w-0 break-words">{tool.definition.providerOperation.replaceAll("_", " ")}<span className="mt-1 block text-xs text-muted-foreground">{tool.resources.map(resource => resource.id).join(", ")}</span></span></label>) : <p className="text-xs text-muted-foreground">No shared tools selected.</p>}</fieldset>
              <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">Specialist limits</summary><div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="space-y-2">Token allocation<Input aria-label={`Specialist ${index + 1} token allocation`} type="number" required min={2048} max={12000} value={binding.maxTokens} onChange={event => bindingsChanged(delegation.bindings.map((item, position) => position === index ? { ...item, maxTokens: Number(event.target.value) } : item))} /></label><label className="space-y-2">Active seconds<Input aria-label={`Specialist ${index + 1} active seconds`} type="number" required min={1} max={300} value={binding.maxActiveMs / 1000} onChange={event => bindingsChanged(delegation.bindings.map((item, position) => position === index ? { ...item, maxActiveMs: Number(event.target.value) * 1000 } : item))} /></label></div></details>
            </> : null}
          </fieldset>;
        })}
        {delegation.bindings.length === 1 ? <Button type="button" size="sm" variant="outline" disabled={!specialists?.some(item => item.version.id !== delegation.bindings[0].versionId)} onClick={() => { const next = specialists?.find(item => item.version.id !== delegation.bindings[0].versionId); if (next) selectBinding(1, next.version.id); }}>Add specialist</Button> : null}
      </> : null}
    </fieldset>
    <fieldset className="space-y-3"><legend className="mb-3 text-sm font-medium">Analysis</legend><label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-primary" checked={configuration.capabilities.sandbox.enabled} onChange={event => onChange({ ...configuration, capabilities: { ...configuration.capabilities, sandbox: event.target.checked ? { enabled: true, profileId: "python-analysis-v1" } : { enabled: false } }, tools: event.target.checked ? [...new Set([...(configuration.tools ?? []), "sandbox.analyze" as const])] : (configuration.tools ?? []).filter(tool => tool !== "sandbox.analyze") })} /><span>Run Python analysis<span className="mt-1 block text-xs text-muted-foreground">Temporary isolated compute. Network access disabled.</span></span></label></fieldset>
  </div>;
}
