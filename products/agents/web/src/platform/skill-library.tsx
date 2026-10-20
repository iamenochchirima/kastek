import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { api, message, type SkillPackage } from "./api";
import { SkillRevisionControls } from "./skill-revisions";
import { ErrorMessage, Loading } from "./shell";

export function SkillImport({ path, onImported }: { path: string; onImported: (skill: SkillPackage) => void }) {
  const [open, setOpen] = useState(false), [file, setFile] = useState<File | null>(null);
  const [source, setSource] = useState("file"), [repository, setRepository] = useState(""), [commit, setCommit] = useState(""), [packagePath, setPackagePath] = useState("");
  const [operationId, setOperationId] = useState(crypto.randomUUID());
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault(); if (source === "file" && !file) return; setBusy(true); setError("");
    try {
      if (source === "repository") {
        if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repository.trim())) throw new Error("Enter a public GitHub repository as owner/repository.");
        if (!/^[0-9a-f]{40}$/.test(commit.trim())) throw new Error("Enter the full 40-character commit SHA in lowercase.");
        const result = await api<{ package: SkillPackage }>(`${path}/repository`, { operationId, repository: repository.trim(), commit: commit.trim(), path: packagePath.trim() });
        setOpen(false); onImported(result.package); toast.success("Skill imported"); return;
      }
      if (!file) return;
      if (file.size > 2 * 1024 * 1024) throw new Error("Choose a file smaller than 2 MB.");
      let body: object;
      if (file.name.toLowerCase().endsWith(".zip")) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        body = { operationId, zipBase64: btoa(binary) };
      } else {
        if (file.name !== "SKILL.md") throw new Error("Choose a ZIP package or SKILL.md.");
        body = { operationId, files: [{ path: "SKILL.md", content: await file.text() }] };
      }
      const result = await api<{ package: SkillPackage }>(path, body);
      setOpen(false); setFile(null); onImported(result.package); toast.success("Skill imported");
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <><Button type="button" size="sm" variant="outline" onClick={() => { setOpen(true); setError(""); setFile(null); setOperationId(crypto.randomUUID()); }}>Import skill</Button><Dialog open={open} onOpenChange={value => { if (!busy) setOpen(value); }}><DialogContent showCloseButton={!busy}><DialogHeader><DialogTitle>Import skill</DialogTitle><DialogDescription>Import a skill file or a public GitHub package at an exact commit.</DialogDescription></DialogHeader><form className="space-y-4" onSubmit={event => void submit(event)}><label className="block space-y-2 text-sm">Source<select aria-label="Skill source" className="w-full rounded-md border bg-background p-2" value={source} disabled={busy} onChange={event => { setSource(event.target.value); setError(""); setOperationId(crypto.randomUUID()); }}><option value="file">File</option><option value="repository">Public GitHub repository</option></select></label>{source === "repository" ? <><label className="block space-y-2 text-sm">Repository<Input required placeholder="owner/repository" value={repository} disabled={busy} onChange={event => { setRepository(event.target.value); setOperationId(crypto.randomUUID()); }} /></label><label className="block space-y-2 text-sm">Commit SHA<Input required pattern="[0-9a-f]{40}" maxLength={40} value={commit} disabled={busy} onChange={event => { setCommit(event.target.value); setOperationId(crypto.randomUUID()); }} /></label><label className="block space-y-2 text-sm">Package path<Input placeholder="skills/my-skill" value={packagePath} disabled={busy} onChange={event => { setPackagePath(event.target.value); setOperationId(crypto.randomUUID()); }} /></label><p className="text-sm text-muted-foreground">Leave the path empty for a package at the repository root. Imported files require owner review.</p></> : <label className="block space-y-2 text-sm">Skill file<Input type="file" accept=".zip,.md" required disabled={busy} onChange={event => { setFile(event.target.files?.[0] ?? null); setError(""); setOperationId(crypto.randomUUID()); }} /></label>}<ErrorMessage value={error} /><div className="flex justify-end gap-2"><Button type="button" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>Cancel</Button><Button type="submit" disabled={busy || (source === "file" ? !file : !repository.trim() || !commit.trim())}>{busy ? "Importing…" : "Import"}</Button></div></form></DialogContent></Dialog></>;
}

export function SkillPreview({ path, id, canReview, onReviewed, onUseRevision, close }: { path: string; id: string; canReview: boolean; onReviewed: () => void; onUseRevision?: (skill: SkillPackage) => void; close: () => void }) {
  const [data, setData] = useState<{ package: SkillPackage; body: string } | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [file, setFile] = useState("SKILL.md"), [content, setContent] = useState<string | null>(null);
  const [fileError, setFileError] = useState("");
  useEffect(() => {
    let live = true;
    api<{ package: SkillPackage; body: string }>(`${path}/${encodeURIComponent(id)}`).then(result => { if (live) setData(result); }).catch(e => { if (live) setError(message(e)); });
    return () => { live = false; };
  }, [path, id]);
  useEffect(() => {
    if (file === "SKILL.md") return;
    let live = true;
    api<{ content: string }>(`${path}/${encodeURIComponent(id)}/files?path=${encodeURIComponent(file)}`).then(result => { if (live) { setContent(result.content); setFileError(""); } }).catch(e => { if (live) setFileError(message(e)); });
    return () => { live = false; };
  }, [path, id, file]);
  async function review() {
    if (!data) return; setBusy(true); setError("");
    try {
      const result = await api<{ package: SkillPackage }>(`${path}/${encodeURIComponent(id)}/review`, { contentDigest: data.package.contentDigest });
      setData({ ...data, package: result.package }); onReviewed(); toast.success("Skill reviewed");
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) close(); }}><DialogContent className="sm:max-w-2xl" showCloseButton={!busy}><DialogHeader><DialogTitle>{data?.package.name ?? "Skill preview"}</DialogTitle><DialogDescription>{data?.package.description ?? "Loading skill"}</DialogDescription></DialogHeader><ErrorMessage value={error} />{!data && !error ? <Loading /> : data ? <>
    <SkillRevisionControls path={path} skill={data.package} owner={canReview} update={skill => { setData({ ...data, package: skill }); onReviewed(); }} onUseRevision={onUseRevision} />
    {data.package.compatibility ? <p className="text-sm text-muted-foreground">{data.package.compatibility}</p> : null}
    <label className="block space-y-2 text-sm">Files<select className="w-full rounded-md border border-border bg-background p-2" value={file} onChange={event => { setFile(event.target.value); setContent(null); setFileError(""); }}>{data.package.files.map(entry => <option value={entry.path} key={entry.path}>{entry.path}</option>)}</select></label>
    <ErrorMessage value={fileError} /><pre className="skill-preview-body">{file === "SKILL.md" ? data.body : content ?? (fileError ? "Preview unavailable" : "Loading file…")}</pre>
    {data.package.reviewState === "pending" ? <p className="text-sm text-muted-foreground">{canReview ? "Review the files before adding this skill." : "An organization owner must review this skill."}</p> : <p className="text-xs text-muted-foreground">Reviewed</p>}
    <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="ghost" disabled={busy} onClick={close}>Close</Button>{canReview && data.package.reviewState === "pending" ? <Button type="button" disabled={busy} onClick={() => void review()}>{busy ? "Saving…" : "Mark reviewed"}</Button> : null}</div>
  </> : <Button type="button" variant="outline" onClick={close}>Close</Button>}</DialogContent></Dialog>;
}

export function CuratedSkillPreview({ path, slug, onInstalled, close }: { path: string; slug: string; onInstalled: (skill: SkillPackage) => void; close: () => void }) {
  const [data, setData] = useState<{ skill: { name: string; description: string; compatibility: string | null }; body: string } | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [operationId] = useState(crypto.randomUUID());
  useEffect(() => {
    let live = true;
    api<{ skill: { name: string; description: string; compatibility: string | null }; body: string }>(`${path}/${encodeURIComponent(slug)}`).then(result => { if (live) setData(result); }).catch(e => { if (live) setError(message(e)); });
    return () => { live = false; };
  }, [path, slug]);
  async function install() {
    setBusy(true); setError("");
    try { const result = await api<{ package: SkillPackage }>(`${path}/${encodeURIComponent(slug)}/install`, { operationId }); onInstalled(result.package); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) close(); }}><DialogContent className="sm:max-w-2xl" showCloseButton={!busy}><DialogHeader><DialogTitle>{data?.skill.name ?? "Skill preview"}</DialogTitle><DialogDescription>{data?.skill.description ?? "Loading skill"}</DialogDescription></DialogHeader><ErrorMessage value={error} />{data ? <><p className="text-xs text-muted-foreground">KasiTek</p>{data.skill.compatibility ? <p className="text-sm text-muted-foreground">{data.skill.compatibility}</p> : null}<pre className="skill-preview-body">{data.body}</pre><div className="flex justify-end gap-2"><Button type="button" variant="ghost" disabled={busy} onClick={close}>Close</Button><Button type="button" disabled={busy} onClick={() => void install()}>{busy ? "Adding…" : "Add skill"}</Button></div></> : !error ? <Loading /> : <Button type="button" variant="outline" onClick={close}>Close</Button>}</DialogContent></Dialog>;
}
