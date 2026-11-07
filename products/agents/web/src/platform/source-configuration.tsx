import "./management.css";
import { Link } from "react-router-dom";
import { PiGlobe as Globe } from "react-icons/pi";
import type { ReactNode } from "react";
import { type Configuration, type KnowledgeSource } from "./api";

export function selectedEmbeddingRelease(sources: KnowledgeSource[], ids: readonly string[]): string | null {
  if (!ids.length) return null;
  const revisions = ids.map(id => sources.flatMap(source => source.revisions).find(revision => revision.id === id && revision.state === "approved"));
  const release = revisions[0]?.embeddingRelease;
  return release && revisions.every(revision => revision?.embeddingRelease === release) ? release : null;
}
export function SourceConfiguration({ sources, configuration, onChange, action }: {
  sources: KnowledgeSource[]; configuration: Configuration; onChange: (value: Configuration) => void; action?: ReactNode;
}) {
  const ids = configuration.sourceRevisionIds ?? [];
  const embeddingRelease = selectedEmbeddingRelease(sources, ids), retrieval = configuration.retrievalProfile ?? { kind: "lexical-v1" };
  function update(sourceRevisionIds: string[]) {
    const delegation = configuration.capabilities.delegation;
    onChange({ ...configuration, sourceRevisionIds, capabilities: { ...configuration.capabilities,
      delegation: delegation.enabled ? { ...delegation, bindings: delegation.bindings.map(binding => ({ ...binding,
        sourceRevisionIds: (binding.sourceRevisionIds ?? []).filter(id => sourceRevisionIds.includes(id)) })) } : delegation } });
  }
  const missingIds = ids.filter(id => !sources.some(source => source.revisions.some(revision => revision.id === id)));
  const visibleSources = sources.filter(source => source.state === "active" && source.revisions.some(revision => revision.state === "approved") || source.revisions.some(revision => ids.includes(revision.id)));
  return <div className="agent-knowledge-section">
    <div className="agent-knowledge-heading"><h2>Training data</h2>{action}</div>
    {!visibleSources.length && !missingIds.length ? <p className="agent-knowledge-empty">No approved sources. <Link className="underline underline-offset-4" to="/app/knowledge">Manage sources</Link></p> :
    <div className="agent-knowledge-table-wrap"><table className="agent-knowledge-table"><thead><tr><th scope="col">Source</th><th scope="col">Status</th><th scope="col">Revision</th></tr></thead><tbody>
    {visibleSources.map(source => {
      const revisions = source.revisions.filter(revision => revision.state === "approved").sort((a, b) => b.revision - a.revision);
      const pinned = source.revisions.find(revision => ids.includes(revision.id)), unavailable = source.state !== "active" || pinned?.state === "withdrawn";
      function setRevision(id?: string) { update([...ids.filter(value => !source.revisions.some(revision => revision.id === value)), ...(id ? [id] : [])]); }
      return <tr key={source.id}><td><label className="agent-knowledge-source"><input type="checkbox" className="size-4 shrink-0 accent-primary" checked={Boolean(pinned)} disabled={!pinned && !revisions.length} onChange={event => setRevision(event.target.checked ? revisions[0]?.id : undefined)} /><Globe size={16} aria-hidden="true" /><span className="agent-knowledge-name">{source.title}</span><span className="agent-knowledge-badge">{source.visibility === "public" ? "Public" : "Private"}</span></label></td><td><span className={`agent-knowledge-status ${unavailable || !pinned ? "is-unavailable" : ""}`}>{unavailable ? "Unavailable" : pinned ? "Ready" : "Not selected"}</span></td><td>{pinned ? <select aria-label={`${source.title} revision`} className="agent-knowledge-revision" value={pinned.id} onChange={event => setRevision(event.target.value)}>{!revisions.some(revision => revision.id === pinned.id) ? <option value={pinned.id}>Revision {pinned.revision} unavailable</option> : null}{revisions.map(revision => <option key={revision.id} value={revision.id}>Revision {revision.revision}</option>)}</select> : <span className="text-muted-foreground">—</span>}</td></tr>;
    })}
    {missingIds.map(id => <tr key={id}><td><label className="agent-knowledge-source"><input className="size-4 accent-primary" type="checkbox" checked onChange={() => update(ids.filter(value => value !== id))} /><span>Source unavailable</span></label></td><td>Unavailable</td><td>—</td></tr>)}
    </tbody></table></div>}
    {sources.length && !sources.some(source => source.state === "active" && source.revisions.some(revision => revision.state === "approved")) ? <p className="text-sm text-muted-foreground">Approve a source in <Link className="underline underline-offset-4" to="/app/knowledge">Knowledge</Link>.</p> : null}
    <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">Search options</summary><label className="mt-3 block space-y-2">Search method<select className="w-full min-w-0 rounded-md border border-border bg-background p-2" value={retrieval.kind} onChange={event => onChange({ ...configuration, retrievalProfile: event.target.value === "hybrid-v1" && embeddingRelease ? { kind: "hybrid-v1", embeddingRelease } : { kind: "lexical-v1" } })}><option value="lexical-v1">Keyword search</option><option value="hybrid-v1" disabled={!embeddingRelease}>Keyword and semantic search</option></select></label>{retrieval.kind === "hybrid-v1" && retrieval.embeddingRelease !== embeddingRelease ? <p role="alert" className="mt-2 text-sm text-destructive">Selected sources do not support the saved semantic search profile. Choose keyword search or compatible source revisions.</p> : !embeddingRelease ? <p className="mt-2 text-xs text-muted-foreground">Semantic search needs compatible indexed source revisions.</p> : null}</details>
  </div>;
}
