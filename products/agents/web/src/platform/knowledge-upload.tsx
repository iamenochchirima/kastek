import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, ApiError, message, organizationPath, type Agent, type KnowledgeImport, type KnowledgePreview, type KnowledgeSource, type KnowledgeSources } from "./api";
import { ErrorMessage } from "./shell";

const fileTypes: Record<string, string> = { pdf: "application/pdf", html: "text/html", htm: "text/html", md: "text/markdown", txt: "text/plain", json: "application/json", csv: "text/csv" };
const terminal = (state: KnowledgeImport["state"] | "uploading" | "added") => ["ready", "failed", "cancelled", "added"].includes(state);
const limit = 10_485_760, maxActiveImports = 2;
type EntryState = "ready" | "uploading" | "added" | KnowledgeImport["state"];
type Entry = { key: string; file: File; operationId: string; approvalOperationId: string; state: EntryState; job?: KnowledgeImport; error?: string; preview?: KnowledgePreview; reviewing?: boolean };
function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  return btoa(binary);
}
function title(file: File): string {
  return (file.name.replace(/\.[^.]+$/u, "").trim() || "Document").slice(0, 200);
}

export function KnowledgeUpload({ organizationId, agentId, onComplete, onBusyChange }: {
  organizationId: string; agentId: string; onComplete?: () => void; onBusyChange?: (busy: boolean) => void;
}) {
  const base = organizationPath(organizationId), agentPath = `${base}/agents/${encodeURIComponent(agentId)}`;
  const [entries, setEntries] = useState<Entry[]>([]);
  const [sources, setSources] = useState<KnowledgeSource[]>([]);
  const [publicReplies, setPublicReplies] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => { onBusyChange?.(busy); return () => onBusyChange?.(false); }, [busy, onBusyChange]);
  useEffect(() => {
    let live = true;
    api<KnowledgeSources>(`${base}/knowledge/sources`).then(result => { if (live) setSources(result.sources ?? []); }).catch(e => { if (live) setError(message(e)); });
    return () => { live = false; };
  }, [base]);
  const pending = useMemo(() => entries.filter(entry => entry.job && !terminal(entry.state)), [entries]);
  const pendingKey = pending.map(entry => entry.job!.id).join(",");
  async function refreshSources() {
    const result = await api<KnowledgeSources>(`${base}/knowledge/sources`);
    setSources(result.sources ?? []);
  }
  useEffect(() => {
    if (!pendingKey) return;
    let live = true;
    async function load() {
      let ready = false;
      const updates = new Map<string, KnowledgeImport>();
      await Promise.all(pendingKey.split(",").map(async id => {
        try { const result = await api<{ job: KnowledgeImport }>(`${base}/knowledge/imports/${id}`); updates.set(id, result.job); }
        catch (e) { if (live) setError(message(e)); }
      }));
      if (!live) return;
      setEntries(current => current.map(entry => {
        const job = entry.job && updates.get(entry.job.id);
        if (!job) return entry;
        if (job.state === "ready" && entry.state !== "ready") ready = true;
        return { ...entry, job, state: job.state === "failed" ? "failed" : job.state === "cancelled" ? "cancelled" : job.state, error: job.errorCode ?? entry.error };
      }));
      if (ready) await api<KnowledgeSources>(`${base}/knowledge/sources`).then(result => { if (live) setSources(result.sources ?? []); }).catch(e => { if (live) setError(message(e)); });
    }
    void load(); const timer = setInterval(() => void load(), 1500);
    return () => { live = false; clearInterval(timer); };
  }, [base, pendingKey]);
  function choose(files: FileList | null) {
    setError("");
    if (!files) return;
    const chosen = [...files];
    if (entries.length + chosen.length > 10) { setError("Add up to 10 documents at a time."); return; }
    const next: Entry[] = [];
    for (const file of chosen) {
      const type = fileTypes[file.name.split(".").pop()?.toLowerCase() ?? ""];
      if (!type) { setError(`${file.name} is not a PDF, HTML, Markdown, text, JSON or CSV file.`); continue; }
      if (file.size > limit) { setError(`${file.name} is larger than 10 MB.`); continue; }
      if (!file.size) { setError(`${file.name} is empty.`); continue; }
      if (entries.some(entry => entry.file.name === file.name && entry.file.size === file.size) || next.some(entry => entry.file.name === file.name && entry.file.size === file.size)) continue;
      next.push({ key: crypto.randomUUID(), file, operationId: crypto.randomUUID(), approvalOperationId: crypto.randomUUID(), state: "ready" });
    }
    if (next.length) setEntries(current => [...current, ...next]);
    if (fileInput.current) fileInput.current.value = "";
  }
  function remove(key: string) {
    setEntries(current => current.filter(entry => entry.key !== key));
  }
  async function uploadEntry(entry: Entry): Promise<KnowledgeImport | undefined> {
    const type = fileTypes[entry.file.name.split(".").pop()?.toLowerCase() ?? ""]!;
    const bytes = new Uint8Array(await entry.file.arrayBuffer());
    setEntries(current => current.map(item => item.key === entry.key ? { ...item, state: "uploading", error: undefined } : item));
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        const result = await api<{ job: KnowledgeImport }>(`${base}/knowledge/imports`, { operationId: entry.operationId, title: title(entry.file), kind: "upload", contentType: type, contentBase64: base64(bytes) });
        setEntries(current => current.map(item => item.key === entry.key ? { ...item, job: result.job, state: result.job.state, error: result.job.errorCode ?? undefined } : item));
        return result.job;
      } catch (e) {
        if (e instanceof ApiError && e.code === "IMPORT_CONCURRENCY_LIMIT") { await new Promise(resolve => setTimeout(resolve, 2000)); continue; }
        setEntries(current => current.map(item => item.key === entry.key ? { ...item, state: "failed", error: message(e), operationId: crypto.randomUUID() } : item));
        return undefined;
      }
    }
    setEntries(current => current.map(item => item.key === entry.key ? { ...item, state: "failed", error: "Import capacity is busy. Try again.", operationId: crypto.randomUUID() } : item));
    return undefined;
  }
  async function waitForJob(job: KnowledgeImport) {
    if (["ready", "failed", "cancelled"].includes(job.state)) return;
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      try {
        const result = await api<{ job: KnowledgeImport }>(`${base}/knowledge/imports/${job.id}`);
        setEntries(current => current.map(item => item.job?.id === job.id ? { ...item, job: result.job, state: result.job.state, error: result.job.errorCode ?? item.error } : item));
        if (["ready", "failed", "cancelled"].includes(result.job.state)) return;
      } catch { return; }
    }
  }
  async function upload() {
    const selected = entries.filter(entry => entry.state === "ready" && !entry.job);
    if (!selected.length) return;
    setBusy(true); setError("");
    try {
      for (let index = 0; index < selected.length; index += maxActiveImports) {
        const batch = selected.slice(index, index + maxActiveImports);
        const jobs = (await Promise.all(batch.map(entry => uploadEntry(entry)))).filter((job): job is KnowledgeImport => Boolean(job));
        await Promise.all(jobs.map(job => waitForJob(job)));
        await refreshSources().catch(() => undefined);
      }
    } finally { setBusy(false); }
  }
  async function review(entry: Entry) {
    if (!entry.job) return;
    if (entry.preview) { setEntries(current => current.map(item => item.key === entry.key ? { ...item, preview: undefined } : item)); return; }
    const job = entry.job;
    setEntries(current => current.map(item => item.key === entry.key ? { ...item, reviewing: true } : item));
    try {
      const preview = await api<KnowledgePreview>(`${base}/knowledge/sources/${job.sourceId}/revisions/${job.revisionId}/preview`);
      setEntries(current => current.map(item => item.key === entry.key ? { ...item, preview, reviewing: false } : item));
    } catch (e) { setEntries(current => current.map(item => item.key === entry.key ? { ...item, reviewing: false } : item)); setError(message(e)); }
  }
  async function addToAgent() {
    const selected = entries.filter(entry => entry.state === "ready" && entry.job);
    if (!selected.length) return;
    setBusy(true); setError("");
    try {
      const currentSources = (await api<KnowledgeSources>(`${base}/knowledge/sources`)).sources ?? [];
      setSources(currentSources);
      let agent = (await api<{ agent: Agent }>(agentPath)).agent;
      const revisionIds: string[] = [];
      for (const entry of selected) {
        const job = entry.job!;
        const source = currentSources.find(item => item.id === job.sourceId);
        const revision = source?.revisions.find(item => item.id === job.revisionId);
        if (!source || !revision) throw new Error("Reload the document and try again.");
        if (revision.state === "withdrawn") throw new Error(`${entry.file.name} was withdrawn.`);
        if ((revision.state === "candidate" || publicReplies) && !source.canApprove) throw new Error("An owner must approve these documents in Knowledge.");
        if (revision.state === "candidate") {
          await api(`${base}/knowledge/sources/${source.id}/policy`, { operationId: entry.approvalOperationId, expectedGeneration: source.generation, action: "approve", revisionId: revision.id });
        }
        revisionIds.push(revision.id);
      }
      if (publicReplies) {
        const current = (await api<KnowledgeSources>(`${base}/knowledge/sources`)).sources ?? [];
        const publish = new Map<string, number>();
        for (const entry of selected) {
          const source = current.find(item => item.id === entry.job!.sourceId);
          if (source && source.visibility !== "public") publish.set(source.id, source.generation);
        }
        for (const [id, generation] of publish) await api(`${base}/knowledge/sources/${id}/policy`, { operationId: crypto.randomUUID(), expectedGeneration: generation, action: "visibility", visibility: "public" });
      }
      await refreshSources();
      agent = (await api<{ agent: Agent }>(agentPath)).agent;
      const configuration = { ...agent.draft, sourceRevisionIds: [...new Set([...(agent.draft.sourceRevisionIds ?? []), ...revisionIds])], tools: [...new Set([...(agent.draft.tools ?? []), "knowledge.search" as const, "knowledge.read" as const])] };
      await api(`${agentPath}/configuration`, { name: agent.name, expectedRevision: agent.draftRevision, configuration, confirmImpact: true });
      const keys = new Set(selected.map(entry => entry.key));
      setEntries(current => current.map(entry => keys.has(entry.key) ? { ...entry, state: "added", error: undefined } : entry));
      toast.success("Knowledge added"); onComplete?.();
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  const ready = entries.filter(entry => entry.state === "ready" && entry.job);
  const pendingUpload = entries.some(entry => ["uploading", "queued", "acquiring", "extracting", "indexing"].includes(entry.state));
  return <div className="min-w-0 space-y-3">
    <ErrorMessage value={error} />
    <label className="block space-y-2 text-sm">Documents<Input ref={fileInput} type="file" multiple disabled={busy || pendingUpload} accept=".pdf,.html,.htm,.md,.txt,.json,.csv" onChange={event => choose(event.target.files)} /><span className="text-xs text-muted-foreground">PDF, HTML, Markdown, text, JSON or CSV · up to 10 MB each</span></label>
    {entries.length ? <ul className="space-y-2">{entries.map(entry => {
      const job = entry.job, source = job && sources.find(item => item.id === job.sourceId), revision = source?.revisions.find(item => item.id === job?.revisionId);
      const status = entry.state === "added" ? "Added" : entry.state === "failed" ? "Import failed" : entry.state === "cancelled" ? "Import cancelled" : entry.state === "ready" ? revision?.state === "approved" ? "Approved" : "Ready to review" : entry.state === "uploading" ? "Uploading…" : "Processing…";
      return <li key={entry.key} className="space-y-2 rounded-md border border-border p-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><span className="min-w-0 break-words text-sm font-medium">{entry.file.name}</span><span className="text-xs text-muted-foreground" data-status={entry.state}>{status}</span></div>
        {entry.error ? <p role="alert" className="text-xs text-destructive">{entry.error}</p> : null}
        <div className="flex flex-wrap gap-2">
          {entry.state === "ready" && !entry.job ? <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => remove(entry.key)}>Remove</Button> : null}
          {entry.state === "ready" && entry.job ? <Button type="button" size="sm" variant="outline" disabled={busy || entry.reviewing} onClick={() => void review(entry)}>{entry.reviewing ? "Loading…" : entry.preview ? "Hide preview" : "Review"}</Button> : null}
          {entry.state === "failed" ? <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setEntries(current => current.map(item => item.key === entry.key ? { ...item, state: "ready", job: undefined, error: undefined } : item))}>Try again</Button> : null}
        </div>
        {entry.preview ? <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border p-3 font-sans text-xs leading-5">{entry.preview.text}</pre> : null}
      </li>;
    })}</ul> : null}
    <label className="flex items-start gap-2 text-sm"><input className="mt-0.5 size-4 shrink-0 accent-primary" type="checkbox" checked={publicReplies} disabled={busy} onChange={event => setPublicReplies(event.target.checked)} /><span>Allow use in public customer replies</span></label>
    <div className="flex flex-wrap gap-2">
      <Button type="button" disabled={busy || pendingUpload || !entries.some(entry => entry.state === "ready" && !entry.job)} onClick={() => void upload()}>{pendingUpload ? "Processing…" : "Upload"}</Button>
      <Button type="button" disabled={busy || pendingUpload || !ready.length} onClick={() => void addToAgent()}>{busy ? "Saving…" : "Use knowledge"}</Button>
    </div>
    <p className="text-xs text-muted-foreground"><Link className="underline underline-offset-4" to="/app/knowledge">Manage knowledge</Link></p>
  </div>;
}
