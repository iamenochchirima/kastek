import "./management.css";
import "./workspace-surfaces.css";
import "./knowledge.css";
import { PiFileText as FileText } from "react-icons/pi";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { api, message, organizationPath, type KnowledgeImport, type KnowledgePreview, type KnowledgeRevision, type KnowledgeSource, type KnowledgeSources } from "./api";
import { ErrorMessage, Loading, useWorkspace } from "./shell";

const activeImport = (job: KnowledgeImport) => ["queued", "acquiring", "extracting", "indexing"].includes(job.state);
type SourceDialog = { kind: "import"; source?: KnowledgeSource; operationId: string }
  | { kind: "preview"; source: KnowledgeSource; revision: KnowledgeRevision }
  | { kind: "withdraw"; source: KnowledgeSource; operationId: string }
  | { kind: "delete"; source: KnowledgeSource };
const fileTypes: Record<string, string> = { pdf: "application/pdf", html: "text/html", htm: "text/html", txt: "text/plain", md: "text/markdown", json: "application/json", csv: "text/csv" };
function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  return btoa(binary);
}
export function KnowledgePage() {
  const { organizationId } = useWorkspace(), path = `${organizationPath(organizationId)}/knowledge`;
  const [data, setData] = useState<KnowledgeSources | null>(null), [error, setError] = useState("");
  const [dialog, setDialog] = useState<SourceDialog | null>(null), [dialogError, setDialogError] = useState("");
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  function fieldError(field: string) { return fieldErrors[field] ? <p id={`source-error-${field}`} role="alert" className="mt-1 text-sm text-destructive">{fieldErrors[field]}</p> : null; }
  function fieldProps(field: string) { return { name: field, "aria-invalid": fieldErrors[field] ? true : undefined, "aria-describedby": fieldErrors[field] ? `source-error-${field}` : undefined }; }
  const [title, setTitle] = useState(""), [kind, setKind] = useState<"text" | "file" | "url">("text");
  const [content, setContent] = useState(""), [url, setUrl] = useState(""), [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false), [preview, setPreview] = useState<KnowledgePreview | null>(null);
  const [verifying, setVerifying] = useState<string | null>(null);
  const previewSequence = useRef(0);
  async function refresh() { setData(await api<KnowledgeSources>(`${path}/sources`)); }
  useEffect(() => {
    let live = true;
    api<KnowledgeSources>(`${path}/sources`).then(value => { if (live) setData(value); }).catch(e => { if (live) setError(message(e)); });
    return () => { live = false; };
  }, [path]);
  const importing = data?.imports.some(activeImport) ?? false;
  useEffect(() => {
    if (!importing) return;
    let live = true;
    const timer = setInterval(() => { api<KnowledgeSources>(`${path}/sources`).then(value => { if (live) setData(value); }).catch(e => { if (live) setError(message(e)); }); }, 2000);
    return () => { live = false; clearInterval(timer); };
  }, [path, importing]);
  function openImport(source?: KnowledgeSource) {
    setDialogError(""); setFieldErrors({}); setTitle(source?.title ?? ""); setKind("text"); setContent(""); setFile(null); setUrl("");
    setDialog({ kind: "import", source, operationId: crypto.randomUUID() });
  }
  function close() { if (!busy) { previewSequence.current++; setDialog(null); setPreview(null); setDialogError(""); } }
  async function openPreview(source: KnowledgeSource, revision: KnowledgeRevision) {
    const sequence = ++previewSequence.current;
    setDialog({ kind: "preview", source, revision }); setDialogError(""); setPreview(null);
    try { const result = await api<KnowledgePreview>(`${path}/sources/${source.id}/revisions/${revision.id}/preview`); if (sequence === previewSequence.current) setPreview(result); }
    catch (e) { if (sequence === previewSequence.current) setDialogError(message(e)); }
  }
  async function importSource(event: FormEvent) {
    event.preventDefault(); if (dialog?.kind !== "import") return;
    setBusy(true); setDialogError("");
    try {
      const common = { operationId: dialog.operationId, title, ...(dialog.source ? { sourceId: dialog.source.id } : {}) };
      if (kind === "url") await api(`${path}/imports`, { ...common, kind: "public_url", url });
      else {
        let bytes: Uint8Array, contentType = "text/plain";
        if (kind === "file") {
          if (!file) throw new Error("Choose a file.");
          contentType = fileTypes[file.name.split(".").pop()?.toLowerCase() ?? ""] ?? "";
          if (!contentType) throw new Error("Choose a PDF, HTML, Markdown, text, JSON or CSV file.");
          if (file.size > 10_485_760) throw new Error("Files must be 10 MB or smaller.");
          bytes = new Uint8Array(await file.arrayBuffer());
        } else bytes = new TextEncoder().encode(content);
        if (!bytes.length || bytes.length > 10_485_760) throw new Error("Source content must be between 1 byte and 10 MB.");
        await api(`${path}/imports`, { ...common, kind: "upload", contentType, contentBase64: base64(bytes) });
      }
      await refresh(); setDialog(null); toast.success("Import started");
    } catch (e) { setDialogError(message(e)); } finally { setBusy(false); }
  }
  async function policy(source: KnowledgeSource, action: "approve" | "withdraw", revisionId?: string) {
    setBusy(true); setError(""); setDialogError("");
    try {
      await api(`${path}/sources/${source.id}/policy`, { operationId: dialog && "operationId" in dialog ? dialog.operationId : crypto.randomUUID(), expectedGeneration: source.generation, action,
        ...(revisionId ? { revisionId } : {}) });
      await refresh(); setDialog(null); toast.success(action === "approve" ? "Source approved" : "Source withdrawn");
    } catch (e) { if (dialog) setDialogError(message(e)); else setError(message(e)); } finally { setBusy(false); }
  }
  async function removeSource(source: KnowledgeSource) {
    setBusy(true); setDialogError("");
    try { await api(`${path}/sources/${source.id}?force=true`, undefined, "DELETE"); await refresh(); setDialog(null); toast.success("Source deleted"); }
    catch (e) { setDialogError(message(e)); } finally { setBusy(false); }
  }
  async function restoreSource(source: KnowledgeSource) {
    setBusy(true); setError("");
    try { await api(`${path}/sources/${source.id}/restore`, {}); await refresh(); toast.success("Source restored"); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  async function cancel(job: KnowledgeImport) {
    setBusy(true); setError("");
    try { await api(`${path}/imports/${job.id}/cancel`, {}); await refresh(); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  async function verify(source: KnowledgeSource) {
    setVerifying(source.id); setError("");
    try { await api(`${path}/sources/${source.id}/verify`, {}); await refresh(); toast.success("Source marked current"); }
    catch (e) { setError(message(e)); } finally { setVerifying(null); }
  }
  function review(source: KnowledgeSource) {
    if (!source.reviewDueAt) return null;
    const due = new Date(source.reviewDueAt).getTime(), days = Math.ceil((due - Date.now()) / 86_400_000);
    if (due <= Date.now()) return <span className="knowledge-review is-overdue">Review overdue</span>;
    if (days <= 30) return <span className="knowledge-review">Review in {days} days</span>;
    return null;
  }
  return <section className="management-page"><div className="management-header"><h1>Knowledge</h1><Button onClick={() => openImport()}>Add source</Button></div><ErrorMessage value={error} />
    {!data && !error ? <Loading /> : data ? <div className="workspace-record-list">{data.sources.length ? data.sources.map(source => {
      const revisions = [...source.revisions].sort((a, b) => b.revision - a.revision), latest = revisions.find(revision => revision.state !== "withdrawn");
      const job = [...data.imports].filter(item => item.sourceId === source.id).sort((a, b) => b.revision - a.revision)[0];
      const running = job && activeImport(job), deleted = source.state === "deleted", withdrawn = source.state === "withdrawn", approved = revisions.some(revision => revision.state === "approved");
      const status = deleted ? "Deleted" : withdrawn ? "Withdrawn" : running ? "Importing…" : job?.state === "failed" ? "Import failed" : job?.state === "cancelled" ? "Import cancelled" : latest?.state === "candidate" ? "Awaiting approval" : approved ? "Ready" : "Pending";
      return <div key={source.id} className="workspace-record knowledge-record"><div className="knowledge-record-main"><div className="workspace-record-heading"><span className="workspace-record-icon"><FileText size={17} strokeWidth={1.7} aria-hidden="true" /></span><div className="workspace-record-copy"><h2>{source.title}</h2><div className="knowledge-record-meta"><span className="knowledge-status" data-status={status}>{status}</span>{latest ? <span>Revision {latest.revision}</span> : null}{review(source)}</div></div></div>
        {deleted ? <div className="knowledge-record-actions">{source.canApprove ? <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void restoreSource(source)}>Restore</Button> : null}</div> : !withdrawn ? <div className="knowledge-record-actions">{latest ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void openPreview(source, latest)}>Preview</Button> : null}{source.canApprove ? <Button type="button" size="sm" variant="ghost" disabled={busy || verifying === source.id} onClick={() => void verify(source)}>{verifying === source.id ? "Saving…" : "Verify"}</Button> : null}{running ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void cancel(job)}>Cancel import</Button> : <Button size="sm" variant="ghost" disabled={busy} onClick={() => openImport(source)}>Refresh</Button>}{source.canApprove && latest?.state === "candidate" && !running ? <Button size="sm" disabled={busy} onClick={() => void policy(source, "approve", latest.id)}>Approve source</Button> : null}{source.canApprove ? <>{approved ? <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { setDialogError(""); setDialog({ kind: "delete", source }); }}>Delete</Button> : null}<Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => { setDialogError(""); setDialog({ kind: "withdraw", source, operationId: crypto.randomUUID() }); }}>Withdraw</Button></> : null}</div> : null}</div>
        {revisions.length > 1 && !withdrawn ? <details className="workspace-record-extra text-sm"><summary className="cursor-pointer text-muted-foreground">Previous revisions</summary><div className="mt-2 space-y-2">{revisions.slice(1).map(revision => <div key={revision.id} className="flex flex-wrap items-center gap-3"><span>Revision {revision.revision} · {revision.state === "candidate" ? "Awaiting approval" : revision.state}</span>{revision.state !== "withdrawn" ? <button type="button" className="underline underline-offset-4" onClick={() => void openPreview(source, revision)}>Preview</button> : null}</div>)}</div></details> : null}</div>;
    }) : <p className="management-empty">No sources yet</p>}</div> : null}
    <Dialog open={Boolean(dialog)} onOpenChange={open => { if (!open) close(); }}><DialogContent className={dialog?.kind === "preview" ? "sm:max-w-2xl" : undefined} showCloseButton={!busy}><DialogHeader><DialogTitle>{dialog?.kind === "import" ? dialog.source ? "Refresh source" : "Add source" : dialog?.kind === "preview" ? dialog.source.title : dialog?.kind === "delete" ? "Delete source" : "Withdraw source"}</DialogTitle><DialogDescription>{dialog?.kind === "import" ? "Sources start private and need approval before use." : dialog?.kind === "preview" ? `Revision ${dialog.revision.revision}` : dialog?.kind === "delete" ? "This permanently removes the source and its content. Every agent stops using it immediately. This cannot be undone." : "Agents will lose access to this source and answers based on it. You can restore it later."}</DialogDescription></DialogHeader><ErrorMessage value={dialogError} />
      {dialog?.kind === "import" ? <form className="space-y-4" onSubmit={event => void importSource(event)} onInvalid={event => { const field = event.target; if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) || !field.name) return; event.preventDefault(); setFieldErrors(current => ({ ...current, [field.name]: field.validationMessage })); if (event.currentTarget.querySelector(":invalid") === field) { field.focus(); field.scrollIntoView({ block: "nearest" }); } }} onInput={event => { const field = event.target; if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) || !field.name || !field.validity.valid) return; setFieldErrors(current => { if (!current[field.name]) return current; const next = { ...current }; delete next[field.name]; return next; }); }}><div><label className="block space-y-2 text-sm">Title<Input autoFocus {...fieldProps("title")} required maxLength={200} value={title} onChange={event => setTitle(event.target.value)} /></label>{fieldError("title")}</div><label className="block space-y-2 text-sm">Source<select className="w-full min-w-0 rounded-md border border-border bg-background p-2" value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="text">Text</option><option value="file">File</option><option value="url">Public URL</option></select></label>{kind === "text" ? <div><label className="block space-y-2 text-sm">Content<Textarea rows={7} {...fieldProps("content")} required maxLength={1_048_576} value={content} onChange={event => setContent(event.target.value)} /></label>{fieldError("content")}</div> : kind === "file" ? <div><label className="block space-y-2 text-sm">File<Input type="file" {...fieldProps("file")} required accept=".pdf,.html,.htm,.md,.txt,.json,.csv" onChange={event => setFile(event.target.files?.[0] ?? null)} /><span className="text-xs text-muted-foreground">PDF, HTML, Markdown, text, JSON or CSV · up to 10 MB</span></label>{fieldError("file")}</div> : <div><label className="block space-y-2 text-sm">URL<Input type="url" {...fieldProps("url")} required maxLength={2048} placeholder="https://example.com/document" value={url} onChange={event => setUrl(event.target.value)} /></label>{fieldError("url")}</div>}<div className="flex flex-wrap justify-end gap-2"><Button variant="outline" type="button" disabled={busy} onClick={close}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? "Importing…" : "Import source"}</Button></div></form>
        : dialog?.kind === "preview" ? preview ? <div className="space-y-4"><p className="text-xs text-muted-foreground">Imported {new Date(preview.acquiredAt).toLocaleString()}</p><pre className="max-h-[55dvh] overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border p-4 font-sans text-sm leading-6">{preview.text}</pre><p className="text-xs text-muted-foreground">{preview.chunks.length} sections</p></div> : !dialogError ? <Loading /> : null
          : dialog ? <div className="flex flex-wrap justify-end gap-2"><Button variant="outline" disabled={busy} onClick={close}>Cancel</Button><Button disabled={busy} variant={dialog.kind === "withdraw" || dialog.kind === "delete" ? "destructive" : "default"} onClick={() => dialog.kind === "delete" ? void removeSource(dialog.source) : void policy(dialog.source, dialog.kind)}>{busy ? "Saving…" : dialog.kind === "delete" ? "Delete source" : "Withdraw source"}</Button></div> : null}
    </DialogContent></Dialog>
  </section>;
}
