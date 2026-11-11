import "./management.css";
import { useState } from "react";
import { Link } from "react-router-dom";
import { PiGlobe as Globe } from "react-icons/pi";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, message, organizationPath, type Configuration, type KnowledgePreview, type KnowledgeRevision, type KnowledgeSource, type KnowledgeTest } from "./api";
import { ErrorMessage, Loading, useWorkspace } from "./shell";

export function selectedEmbeddingRelease(sources: KnowledgeSource[], ids: readonly string[]): string | null {
  if (!ids.length) return null;
  const revisions = ids.map(id => sources.flatMap(source => source.revisions).find(revision => revision.id === id && revision.state === "approved"));
  const release = revisions[0]?.embeddingRelease;
  return release && revisions.every(revision => revision?.embeddingRelease === release) ? release : null;
}
export function SourceConfiguration({ agentId, sources, configuration, onChange, action, onRefresh }: {
  agentId: string; sources: KnowledgeSource[]; configuration: Configuration; onChange: (value: Configuration) => void; action?: ReactNode; onRefresh?: () => void | Promise<void>;
}) {
  const { organizationId } = useWorkspace();
  const [preview, setPreview] = useState<{ source: KnowledgeSource; revision: KnowledgeRevision; text: string | null } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [verifying, setVerifying] = useState<string | null>(null);
  const [testQuery, setTestQuery] = useState(""), [testResult, setTestResult] = useState<KnowledgeTest | null>(null), [testing, setTesting] = useState(false);
  async function testRetrieval() {
    const query = testQuery.trim();
    if (!query) return;
    setTesting(true);
    try {
      setTestResult(await api<KnowledgeTest>(`${organizationPath(organizationId)}/agents/${encodeURIComponent(agentId)}/knowledge/test`, { query }));
    } catch (reason) {
      toast.error(message(reason));
    } finally {
      setTesting(false);
    }
  }
  async function verifySource(source: KnowledgeSource) {
    setVerifying(source.id);
    try {
      await api(`${organizationPath(organizationId)}/knowledge/sources/${source.id}/verify`, {});
      toast.success("Source marked current");
      await onRefresh?.();
    } catch (reason) {
      toast.error(message(reason));
    } finally {
      setVerifying(null);
    }
  }
  async function downloadOriginal(source: KnowledgeSource) {
    try {
      const response = await fetch(`${organizationPath(organizationId)}/knowledge/sources/${source.id}/original`, { credentials: "same-origin" });
      if (!response.ok) throw new Error("The original file is unavailable.");
      const name = source.title.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "source";
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      URL.revokeObjectURL(url);
    } catch (reason) {
      toast.error(message(reason));
    }
  }
  function reviewLabel(source: KnowledgeSource): { text: string; overdue: boolean } | null {
    if (!source.reviewDueAt) return null;
    const due = new Date(source.reviewDueAt).getTime();
    if (due <= Date.now()) return { text: "Review overdue", overdue: true };
    if (due - Date.now() <= 30 * 24 * 60 * 60 * 1000) return { text: "Review soon", overdue: false };
    return null;
  }
  async function openPreview(source: KnowledgeSource, selected?: KnowledgeRevision) {
    const revision = selected ?? [...source.revisions].filter(item => item.state !== "withdrawn").sort((a, b) => b.revision - a.revision)[0];
    if (!revision) return;
    setPreview({ source, revision, text: null });
    setPreviewError("");
    setPreviewLoading(true);
    try {
      const result = await api<KnowledgePreview>(`${organizationPath(organizationId)}/knowledge/sources/${source.id}/revisions/${revision.id}/preview`);
      setPreview({ source, revision, text: result.text });
    } catch (reason) {
      setPreviewError(message(reason));
    } finally {
      setPreviewLoading(false);
    }
  }
  function downloadPreview() {
    if (!preview?.text) return;
    const name = preview.source.title.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "source";
    const url = URL.createObjectURL(new Blob([preview.text], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${name}-revision-${preview.revision.revision}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  }
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
    <div className="agent-knowledge-table-wrap"><table className="agent-knowledge-table"><thead><tr><th scope="col">Source</th><th scope="col">Status</th><th scope="col">Revision</th><th scope="col">Actions</th></tr></thead><tbody>
    {visibleSources.map(source => {
      const revisions = source.revisions.filter(revision => revision.state === "approved").sort((a, b) => b.revision - a.revision);
      const pinned = source.revisions.find(revision => ids.includes(revision.id)), unavailable = source.state !== "active" || pinned?.state === "withdrawn";
      const review = reviewLabel(source);
      function setRevision(id?: string) { update([...ids.filter(value => !source.revisions.some(revision => revision.id === value)), ...(id ? [id] : [])]); }
      return <tr key={source.id}><td><label className="agent-knowledge-source"><input type="checkbox" className="size-4 shrink-0 accent-primary" checked={Boolean(pinned)} disabled={!pinned && !revisions.length} onChange={event => setRevision(event.target.checked ? revisions[0]?.id : undefined)} /><Globe size={16} aria-hidden="true" /><span className="agent-knowledge-name">{source.title}</span><span className="agent-knowledge-badge">{source.visibility === "public" ? "Public" : "Private"}</span></label></td><td><div className="grid gap-1"><span className={`agent-knowledge-status ${unavailable || !pinned ? "is-unavailable" : ""}`}>{unavailable ? "Unavailable" : pinned ? "Ready" : "Not selected"}</span>{review ? <span className={`agent-knowledge-status ${review.overdue ? "is-overdue" : "is-unavailable"}`}>{review.text}</span> : null}</div></td><td>{pinned ? <select aria-label={`${source.title} revision`} className="agent-knowledge-revision" value={pinned.id} onChange={event => setRevision(event.target.value)}>{!revisions.some(revision => revision.id === pinned.id) ? <option value={pinned.id}>Revision {pinned.revision} unavailable</option> : null}{revisions.map(revision => <option key={revision.id} value={revision.id}>Revision {revision.revision}</option>)}</select> : <span className="text-muted-foreground">—</span>}</td><td><div className="flex flex-wrap items-center gap-2"><Button type="button" size="sm" variant="ghost" onClick={() => void openPreview(source, pinned)}>Preview</Button><Button type="button" size="sm" variant="ghost" onClick={() => void downloadOriginal(source)}>Original</Button>{source.canApprove ? <Button type="button" size="sm" variant="ghost" disabled={verifying === source.id} onClick={() => void verifySource(source)}>{verifying === source.id ? "Saving…" : "Verify"}</Button> : null}<Link className="text-sm underline underline-offset-4" to="/app/knowledge">Manage</Link></div></td></tr>;
    })}
    {missingIds.map(id => <tr key={id}><td><label className="agent-knowledge-source"><input className="size-4 accent-primary" type="checkbox" checked onChange={() => update(ids.filter(value => value !== id))} /><span>Source unavailable</span></label></td><td>Unavailable</td><td>—</td><td>—</td></tr>)}
    </tbody></table></div>}
    {sources.length && !sources.some(source => source.state === "active" && source.revisions.some(revision => revision.state === "approved")) ? <p className="text-sm text-muted-foreground">Approve a source in <Link className="underline underline-offset-4" to="/app/knowledge">Knowledge</Link>.</p> : null}
    <Dialog open={Boolean(preview)} onOpenChange={open => { if (!open) { setPreview(null); setPreviewError(""); } }}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{preview?.source.title ?? "Source"}</DialogTitle>
          <DialogDescription>{preview ? `Revision ${preview.revision.revision} · ${new Date(preview.revision.acquiredAt).toLocaleString()}` : ""}</DialogDescription>
        </DialogHeader>
        <ErrorMessage value={previewError} />
        {previewLoading ? <Loading /> : preview?.text ? <pre className="max-h-[55dvh] overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border p-4 font-sans text-sm leading-6">{preview.text}</pre> : !previewError ? <p className="text-sm text-muted-foreground">This revision has no preview.</p> : null}
        <DialogFooter className="mt-4">
          <Button type="button" variant="outline" onClick={() => setPreview(null)}>Close</Button>
          <Button asChild variant="outline"><Link to="/app/knowledge" onClick={() => setPreview(null)}>Manage</Link></Button>
          <Button type="button" disabled={!preview?.text} onClick={downloadPreview}>Download text</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">Test retrieval</summary>
      <div className="mt-3 flex flex-wrap items-center gap-2"><Input aria-label="Test question" className="min-w-0 flex-1" maxLength={1024} placeholder="Ask what a customer might ask" value={testQuery} onChange={event => setTestQuery(event.target.value)} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void testRetrieval(); } }} /><Button type="button" size="sm" disabled={testing || !testQuery.trim()} onClick={() => void testRetrieval()}>{testing ? "Testing…" : "Test"}</Button></div>
      {testResult ? <div className="mt-3 space-y-2">
        {testResult.configuredProfile === "hybrid-v1" ? <p className="text-xs text-muted-foreground">Keyword matches only. Semantic ranking runs in private preview and live replies.</p> : null}
        {testResult.privateSources ? <p className="text-xs text-muted-foreground">{testResult.privateSources} private {testResult.privateSources === 1 ? "source is" : "sources are"} excluded from customer retrieval.</p> : null}
        {testResult.hits.length ? testResult.hits.map(hit => <div key={`${hit.revisionId}-${hit.start}`} className="rounded-md border border-border p-3"><div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground"><span className="font-medium text-foreground">{hit.title}</span>{hit.page === null ? null : <span>Page {hit.page}</span>}</div><p className="mt-1 whitespace-pre-wrap break-words text-sm">{hit.text}</p></div>) : <p className="text-sm text-muted-foreground">{testResult.attached ? "No keyword matches." : "No sources attached."}</p>}
      </div> : null}
    </details>
    <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">Search options</summary><label className="mt-3 block space-y-2">Search method<select className="w-full min-w-0 rounded-md border border-border bg-background p-2" value={retrieval.kind} onChange={event => onChange({ ...configuration, retrievalProfile: event.target.value === "hybrid-v1" && embeddingRelease ? { kind: "hybrid-v1", embeddingRelease } : { kind: "lexical-v1" } })}><option value="lexical-v1">Keyword search</option><option value="hybrid-v1" disabled={!embeddingRelease}>Keyword and semantic search</option></select></label>{retrieval.kind === "hybrid-v1" && retrieval.embeddingRelease !== embeddingRelease ? <p role="alert" className="mt-2 text-sm text-destructive">Selected sources do not support the saved semantic search profile. Choose keyword search or compatible source revisions.</p> : !embeddingRelease ? <p className="mt-2 text-xs text-muted-foreground">Semantic search needs compatible indexed source revisions.</p> : null}</details>
  </div>;
}
