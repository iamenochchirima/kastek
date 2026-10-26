import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, ApiError, message, organizationPath, type Agent, type KnowledgeImport, type KnowledgePreview, type KnowledgeSource, type KnowledgeSources } from "./api";
import { ErrorMessage } from "./shell";

type CrawlPage = { id: string; url: string; title: string; markdown: string };
type WebsiteCrawl = { id: string; url: string; state: string; pages: CrawlPage[]; total: number; completed: number; errorCode: string | null; importJobId?: string | null; importJob?: KnowledgeImport | null };
const active = (crawl: WebsiteCrawl) => ["queued", "submitting", "running", "scraping", "crawling"].includes(crawl.state);

export function WebsiteKnowledgeImport({ organizationId, agentId, onComplete, onBusyChange, initialUrl = "" }: {
  organizationId: string; agentId: string; onComplete: () => void; onBusyChange?: (busy: boolean) => void; initialUrl?: string;
}) {
  const base = organizationPath(organizationId), path = `${base}/agents/${encodeURIComponent(agentId)}/website-crawls`;
  const [url, setUrl] = useState(initialUrl), [crawl, setCrawl] = useState<WebsiteCrawl | null>(null);
  const [selected, setSelected] = useState<string[]>([]), [previewId, setPreviewId] = useState("");
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [source, setSource] = useState<KnowledgeSource | null>(null), [preview, setPreview] = useState<KnowledgePreview | null>(null);
  const [importJob, setImportJob] = useState<KnowledgeImport | null>(null);
  const [available, setAvailable] = useState(true);
  const [publicReplies, setPublicReplies] = useState(false), [attached, setAttached] = useState(false);
  const startOperation = useRef(crypto.randomUUID()), importOperation = useRef(crypto.randomUUID());
  const approvalOperation = useRef(crypto.randomUUID()), visibilityOperation = useRef(crypto.randomUUID());
  const importedIds = useRef<string[] | null>(null);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => {
    let live = true;
    api<{ crawls: WebsiteCrawl[]; available?: boolean }>(path).then(result => { if (!live) return; setAvailable(result.available !== false); const latest = result.crawls[0]; if (latest) { setCrawl(latest); setUrl(latest.url); setSelected(latest.pages.map(page => page.id)); } }).catch(e => { if (live) setError(message(e)); }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [path]);
  const job = importJob ?? crawl?.importJob;
  const importJobId = job?.id ?? crawl?.importJobId;
  const importPending = Boolean(importJobId && (!job || !["ready", "failed", "cancelled"].includes(job.state)));
  useEffect(() => {
    if (!importJobId || !importPending) return;
    let live = true;
    async function load() { try { const result = await api<KnowledgeSources>(`${base}/knowledge/sources`); if (live) { const current = result.imports.find(item => item.id === importJobId); if (current) setImportJob(current); } } catch (e) { if (live) setError(message(e)); } }
    void load(); const timer = setInterval(() => void load(), 1500);
    return () => { live = false; clearInterval(timer); };
  }, [base, importJobId, importPending]);
  const polling = Boolean(crawl && (active(crawl) || job && !["ready", "failed", "cancelled"].includes(job.state)));
  useEffect(() => {
    if (!crawl || !polling) return;
    let live = true;
    const timer = setInterval(() => {
      api<{ crawl: WebsiteCrawl }>(`${path}/${crawl.id}`).then(result => { if (!live) return; setCrawl(result.crawl); setError(""); }).catch(e => { if (live) setError(message(e)); });
    }, 1500);
    return () => { live = false; clearInterval(timer); };
  }, [path, crawl, polling]);
  useEffect(() => {
    if (!job || job.state !== "ready") return;
    let live = true;
    api<KnowledgeSources>(`${base}/knowledge/sources`).then(async result => {
      const current = result.sources.find(item => item.id === job.sourceId);
      if (!current) throw new Error("Imported source is unavailable.");
      const content = await api<KnowledgePreview>(`${base}/knowledge/sources/${current.id}/revisions/${job.revisionId}/preview`);
      if (live) { setSource(current); setPreview(content); if (current.visibility === "public") setPublicReplies(true); }
    }).catch(e => { if (live) setError(message(e)); });
    return () => { live = false; };
  }, [base, job]);
  async function start() {
    setBusy(true); setError("");
    try {
      const result = await api<{ crawl: WebsiteCrawl }>(path, { operationId: startOperation.current, url });
      setCrawl(result.crawl); setSelected(result.crawl.pages.map(page => page.id)); setPreviewId("");
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  async function cancel() {
    if (!crawl) return;
    setBusy(true); setError("");
    try { const result = await api<{ crawl: WebsiteCrawl }>(`${path}/${crawl.id}/cancel`, {}); setCrawl(result.crawl); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  async function importSelected() {
    if (!crawl || !selected.length) return;
    setBusy(true); setError("");
    importedIds.current ??= [...selected];
    try { const result = await api<{ crawl: WebsiteCrawl; job: KnowledgeImport }>(`${path}/${crawl.id}/import`, { operationId: importOperation.current, pageIds: importedIds.current }); setImportJob(result.job); setCrawl(result.crawl); }
    catch (e) { if (e instanceof ApiError && e.status >= 400 && e.status < 500) { importedIds.current = null; importOperation.current = crypto.randomUUID(); } setError(message(e)); } finally { setBusy(false); }
  }
  async function approve() {
    if (!source || !job) return;
    setBusy(true); setError("");
    try {
      let current = source;
      if (!current.revisions.some(item => item.id === job.revisionId && item.state === "approved")) {
        await api(`${base}/knowledge/sources/${source.id}/policy`, { operationId: approvalOperation.current, expectedGeneration: current.generation, action: "approve", revisionId: job.revisionId });
        current = (await api<KnowledgeSources>(`${base}/knowledge/sources`)).sources.find(item => item.id === source.id)!; setSource(current);
      }
      if (publicReplies && current.visibility !== "public") {
        await api(`${base}/knowledge/sources/${source.id}/policy`, { operationId: visibilityOperation.current, expectedGeneration: current.generation, action: "visibility", visibility: "public" });
        current = (await api<KnowledgeSources>(`${base}/knowledge/sources`)).sources.find(item => item.id === source.id)!; setSource(current);
      }
      const { agent } = await api<{ agent: Agent }>(`${base}/agents/${encodeURIComponent(agentId)}`);
      const configuration = { ...agent.draft, sourceRevisionIds: [...new Set([...(agent.draft.sourceRevisionIds ?? []), job.revisionId])], tools: [...new Set([...(agent.draft.tools ?? []), "knowledge.search" as const, "knowledge.read" as const])] };
      await api(`${base}/agents/${encodeURIComponent(agentId)}/configuration`, { name: agent.name, expectedRevision: agent.draftRevision, configuration, confirmImpact: true });
      setAttached(true); toast.success("Website knowledge added"); onComplete();
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  function reset() {
    startOperation.current = crypto.randomUUID(); importOperation.current = crypto.randomUUID(); importedIds.current = null;
    approvalOperation.current = crypto.randomUUID(); visibilityOperation.current = crypto.randomUUID();
    setCrawl(null); setImportJob(null); setSelected([]); setPreviewId(""); setSource(null); setPreview(null); setAttached(false); setError(""); setPublicReplies(false);
  }
  const chosenPage = crawl?.pages.find(page => page.id === previewId);
  return <div className="min-w-0 space-y-4">
    <ErrorMessage value={error} />
    {loading ? <p role="status" className="text-sm text-muted-foreground">Loading website imports…</p> : !crawl ? <>
      <label className="block space-y-2 text-sm">Business website<Input autoFocus value={url} maxLength={2048} placeholder="example.com" onChange={event => { setUrl(event.target.value); startOperation.current = crypto.randomUUID(); }} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); if (url.trim() && !busy && available) void start(); } }} /></label>
      {!available ? <p role="status" className="text-sm text-muted-foreground">Website crawling is unavailable.</p> : null}
      <Button type="button" disabled={busy || !url.trim() || !available} onClick={() => void start()}>{busy ? "Starting…" : "Crawl website"}</Button>
    </> : attached ? <div className="space-y-3"><p role="status" className="text-sm">Website knowledge added</p><Button type="button" variant="outline" onClick={reset}>Import another website</Button></div> : <>
      <p className="break-all text-sm text-muted-foreground">{crawl.url}</p>
      {active(crawl) ? <div className="space-y-3"><p role="status" className="text-sm">Crawling website · {crawl.completed} pages collected{crawl.total ? ` of ${crawl.total}` : ""}</p><Button type="button" variant="outline" disabled={busy} onClick={() => void cancel()}>Cancel crawl</Button></div>
        : job || importJobId ? <>
          {job?.state === "ready" && source && preview ? <>
            <h3 className="text-sm font-medium">Review knowledge</h3>
            <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border p-3 font-sans text-sm leading-6">{preview.text}</pre>
            <label className="flex items-start gap-2 text-sm"><input className="mt-0.5 size-4 shrink-0 accent-primary" type="checkbox" checked={publicReplies} disabled={busy} onChange={event => setPublicReplies(event.target.checked)} /><span>Allow use in public website replies</span></label>
            {source.canApprove ? <Button type="button" disabled={busy} onClick={() => void approve()}>{busy ? "Saving…" : "Approve and use"}</Button> : <p className="text-sm text-muted-foreground">An owner must approve this source in Knowledge.</p>}
          </> : ["failed", "cancelled"].includes(job?.state ?? "") ? <div className="space-y-3"><p role="alert" className="text-sm text-destructive">{job?.state === "failed" ? "Knowledge import failed." : "Knowledge import cancelled."}</p><Button type="button" variant="outline" onClick={reset}>Start again</Button></div> : <p role="status" className="text-sm">Preparing knowledge…</p>}
        </> : ["failed", "cancelled"].includes(crawl.state) ? <div className="space-y-3"><p role="alert" className="text-sm text-destructive">{crawl.state === "failed" ? "Website crawl failed." : "Website crawl cancelled."}</p><Button type="button" variant="outline" onClick={reset}>Try another crawl</Button></div> : crawl.pages.length ? <>
          <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-medium">Review pages</h3><Button type="button" size="sm" variant="ghost" disabled={busy || Boolean(importedIds.current)} onClick={() => setSelected(selected.length === crawl.pages.length ? [] : crawl.pages.map(page => page.id))}>{selected.length === crawl.pages.length ? "Deselect all" : "Select all"}</Button></div>
          <div className="max-h-64 space-y-2 overflow-y-auto">{crawl.pages.map(page => <div key={page.id} className="flex min-w-0 items-start gap-2 rounded-md border border-border p-3"><input type="checkbox" aria-label={`Include ${page.title || page.url}`} className="mt-1 size-4 shrink-0 accent-primary" checked={selected.includes(page.id)} disabled={busy || Boolean(importedIds.current)} onChange={event => setSelected(current => event.target.checked ? [...current, page.id] : current.filter(id => id !== page.id))} /><button type="button" className="min-w-0 text-left text-sm" onClick={() => setPreviewId(page.id)}><span className="block break-words font-medium">{page.title || page.url}</span><span className="block break-all text-xs text-muted-foreground">{page.url}</span></button></div>)}</div>
          {chosenPage ? <section aria-label="Page preview" className="space-y-2"><h4 className="text-sm font-medium">{chosenPage.title}</h4><pre className="max-h-60 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border p-3 font-sans text-sm leading-6">{chosenPage.markdown}</pre></section> : null}
          <div className="flex flex-wrap gap-2"><Button type="button" disabled={busy || !selected.length} onClick={() => void importSelected()}>{busy ? "Importing…" : `Import selected (${selected.length})`}</Button><Button type="button" variant="ghost" disabled={busy} onClick={reset}>Different website</Button></div>
        </> : <div className="space-y-3"><p className="text-sm text-muted-foreground">No pages collected</p><Button type="button" variant="outline" onClick={reset}>Try another website</Button></div>}
    </>}
  </div>;
}
