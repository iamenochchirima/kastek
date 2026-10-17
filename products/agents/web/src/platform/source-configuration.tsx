import { Link } from "react-router-dom";
import { type CapabilityBinding, type Configuration, type Connection, type KnowledgeSource } from "./api";

export function selectedEmbeddingRelease(sources: KnowledgeSource[], ids: readonly string[]): string | null {
  if (!ids.length) return null;
  const revisions = ids.map(id => sources.flatMap(source => source.revisions).find(revision => revision.id === id && revision.state === "approved"));
  const release = revisions[0]?.embeddingRelease;
  return release && revisions.every(revision => revision?.embeddingRelease === release) ? release : null;
}
export function SourceConfiguration({ sources, bindings, connections, configuration, onChange }: {
  sources: KnowledgeSource[]; bindings: CapabilityBinding[]; connections: Connection[]; configuration: Configuration; onChange: (value: Configuration) => void;
}) {
  const ids = configuration.sourceRevisionIds ?? [], toolIds = configuration.connectedToolBindingIds ?? [];
  const embeddingRelease = selectedEmbeddingRelease(sources, ids), retrieval = configuration.retrievalProfile ?? { kind: "lexical-v1" };
  function update(sourceRevisionIds: string[], connectedToolBindingIds = toolIds) {
    const delegation = configuration.capabilities.delegation;
    onChange({ ...configuration, sourceRevisionIds, connectedToolBindingIds, capabilities: { ...configuration.capabilities,
      delegation: delegation.enabled ? { ...delegation, bindings: delegation.bindings.map(binding => ({ ...binding,
        sourceRevisionIds: (binding.sourceRevisionIds ?? []).filter(id => sourceRevisionIds.includes(id)),
        connectedToolBindingIds: (binding.connectedToolBindingIds ?? []).filter(id => connectedToolBindingIds.includes(id)) })) } : delegation } });
  }
  const missingIds = ids.filter(id => !sources.some(source => source.revisions.some(revision => revision.id === id)));
  return <div className="space-y-6"><fieldset className="space-y-3"><legend className="mb-3 text-sm font-medium">Knowledge</legend>{!sources.length && !missingIds.length ? <p className="text-sm text-muted-foreground">No approved sources. <Link className="underline underline-offset-4" to="/app/knowledge">Manage knowledge</Link></p> : null}
    {sources.filter(source => source.state === "active" && source.revisions.some(revision => revision.state === "approved") || source.revisions.some(revision => ids.includes(revision.id))).map(source => {
      const revisions = source.revisions.filter(revision => revision.state === "approved").sort((a, b) => b.revision - a.revision);
      const pinned = source.revisions.find(revision => ids.includes(revision.id)), unavailable = source.state !== "active" || pinned?.state === "withdrawn";
      function setRevision(id?: string) { update([...ids.filter(value => !source.revisions.some(revision => revision.id === value)), ...(id ? [id] : [])]); }
      return <div key={source.id} className="space-y-2"><label className="flex min-w-0 items-start gap-3 text-sm"><input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-primary" checked={Boolean(pinned)} disabled={!pinned && !revisions.length} onChange={event => setRevision(event.target.checked ? revisions[0]?.id : undefined)} /><span className="min-w-0 break-words">{source.title}<span className="ml-2 text-xs text-muted-foreground">{unavailable ? "Unavailable" : source.visibility === "public" ? "Public" : "Private"}</span></span></label>{pinned ? <label className="ml-7 block space-y-2 text-xs text-muted-foreground">Revision<select aria-label={`${source.title} revision`} className="w-full min-w-0 rounded-md border border-border bg-background p-2 text-sm text-foreground sm:max-w-xs" value={pinned.id} onChange={event => setRevision(event.target.value)}>{!revisions.some(revision => revision.id === pinned.id) ? <option value={pinned.id}>Revision {pinned.revision} unavailable</option> : null}{revisions.map(revision => <option key={revision.id} value={revision.id}>Revision {revision.revision}</option>)}</select></label> : null}</div>;
    })}
    {missingIds.map(id => <label key={id} className="flex items-start gap-3 text-sm"><input className="mt-0.5 size-4 accent-primary" type="checkbox" checked onChange={() => update(ids.filter(value => value !== id))} /><span>Source unavailable</span></label>)}
    {sources.length && !sources.some(source => source.state === "active" && source.revisions.some(revision => revision.state === "approved")) ? <p className="text-sm text-muted-foreground">Approve a source in <Link className="underline underline-offset-4" to="/app/knowledge">Knowledge</Link>.</p> : null}
  </fieldset>
    <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">Search options</summary><label className="mt-3 block space-y-2">Search method<select className="w-full min-w-0 rounded-md border border-border bg-background p-2" value={retrieval.kind} onChange={event => onChange({ ...configuration, retrievalProfile: event.target.value === "hybrid-v1" && embeddingRelease ? { kind: "hybrid-v1", embeddingRelease } : { kind: "lexical-v1" } })}><option value="lexical-v1">Keyword search</option><option value="hybrid-v1" disabled={!embeddingRelease}>Keyword and semantic search</option></select></label>{retrieval.kind === "hybrid-v1" && retrieval.embeddingRelease !== embeddingRelease ? <p role="alert" className="mt-2 text-sm text-destructive">Selected sources do not support the saved semantic search profile. Choose keyword search or compatible source revisions.</p> : !embeddingRelease ? <p className="mt-2 text-xs text-muted-foreground">Semantic search needs compatible indexed source revisions.</p> : null}</details>
    <fieldset className="space-y-3 border-t border-border pt-6"><legend className="mb-3 text-sm font-medium">Connected tools</legend>{bindings.length ? bindings.map(binding => {
      const connection = connections.find(item => item.id === binding.connection?.id);
      const available = connection?.state === "active" && new Date(connection.expiresAt).getTime() > Date.now() && connection.policyRevision === binding.connection?.policyRevision;
      const checked = toolIds.includes(binding.id);
      return <label key={binding.id} className="flex min-w-0 items-start gap-3 text-sm"><input className="mt-0.5 size-4 shrink-0 accent-primary" type="checkbox" checked={checked} disabled={!checked && (!available || toolIds.length >= 8)} onChange={event => update(ids, event.target.checked ? [...toolIds, binding.id] : toolIds.filter(id => id !== binding.id))} /><span className="min-w-0 break-words">{binding.definition.providerOperation.replaceAll("_", " ")}<span className="ml-2 text-xs text-muted-foreground">{connection?.name ?? "Unavailable connection"}{!available ? " · Unavailable" : ""}</span><span className="mt-1 block text-xs text-muted-foreground">{binding.resources.map(resource => resource.id).join(", ")}</span></span></label>;
    }) : <p className="text-sm text-muted-foreground">No tools selected. <Link className="underline underline-offset-4" to="/app/connections">Manage connections</Link></p>}{toolIds.filter(id => !bindings.some(binding => binding.id === id)).map(id => <label key={id} className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-0.5 size-4 accent-primary" checked onChange={() => update(ids, toolIds.filter(value => value !== id))} />Tool unavailable</label>)}</fieldset>
  </div>;
}
