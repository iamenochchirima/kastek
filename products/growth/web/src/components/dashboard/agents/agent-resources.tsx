import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { GrowthAgentFeatureId, GrowthAgentResourceInventory, GrowthAgentResourcePreview, GrowthSkillImport } from "@kasitek-labs/contracts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { growthAgents } from "@/lib/growth-agents";

type PreviewSelection = { kind: "source"; sourceId: string; revisionId: string } | { kind: "skill"; skillId: string; path: string };
type Confirmation = { kind: "source"; id: string; title: string; generation: number } | { kind: "skill"; id: string; title: string; generation: number; state: "disabled" | "removed" };
const failure = (error: unknown) => error instanceof Error ? error.message : "Unable to update resources.";
const readySkill = (skill: GrowthAgentResourceInventory["skills"][number]) => skill.reviewState === "reviewed" && skill.state === "enabled" && Object.values(skill.missing).every(items => items.length === 0);
const sameIds = (a: string[], b: string[]) => a.length === b.length && a.every(id => b.includes(id));

export function AgentResources({ featureId, name, open, onOpenChange, onSaved }: {
  featureId: GrowthAgentFeatureId; name: string; open: boolean; onOpenChange: (open: boolean) => void; onSaved: () => Promise<unknown>;
}) {
  const [inventory, setInventory] = useState<GrowthAgentResourceInventory | null>(null);
  const [sourceIds, setSourceIds] = useState<string[]>([]), [skillIds, setSkillIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [retry, setRetry] = useState(0);
  const [importKind, setImportKind] = useState<"source" | "skill" | null>(null);
  const [title, setTitle] = useState(""), [sourceText, setSourceText] = useState(""), [curated, setCurated] = useState("");
  const [skillPackage, setSkillPackage] = useState<GrowthSkillImport | null>(null), [skillFilename, setSkillFilename] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [previewSelection, setPreviewSelection] = useState<PreviewSelection | null>(null), [preview, setPreview] = useState<GrowthAgentResourcePreview | null>(null), [previewError, setPreviewError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const requestKeys = useRef(new Map<string, string>());
  const inventoryRef=useRef(inventory);inventoryRef.current=inventory;
  const inventoryRequest=useRef<AbortController|null>(null),previewRequest=useRef<AbortController|null>(null);
  const inventoryEpoch=useRef(0),previewEpoch=useRef(0),visibilityEpoch=useRef(0),pendingMutation=useRef(false);
  const [staleSelection,setStaleSelection]=useState(false);
  const opener=useRef<HTMLElement|null>(null),previewOpener=useRef<HTMLElement|null>(null),closeButton=useRef<HTMLButtonElement|null>(null);

  useEffect(() => {
    if (!open) return;
    let stopped=false,pending=false,initial=true,timer:ReturnType<typeof setTimeout>;
    const refresh=async()=>{
      if(stopped||pending||document.visibilityState!=="visible")return;
      pending=true;const abort=new AbortController(),generation=++inventoryEpoch.current;inventoryRequest.current=abort;
      try{
        const result=await growthAgents.resources(featureId,abort.signal);
        if(stopped||abort.signal.aborted||generation!==inventoryEpoch.current)return;
        const previous=inventoryRef.current;
        if(initial||!previous){inventoryRef.current=result;setInventory(result);setSourceIds(result.sourceRevisionIds);setSkillIds(result.skillIds);setStaleSelection(false);setError(null);}
        else{
          if(result.revision!==previous.revision){setStaleSelection(true);setError("Agent settings changed. Refresh to continue.");}
          const current={...result,revision:previous.revision,sourceRevisionIds:previous.sourceRevisionIds,skillIds:previous.skillIds};
          inventoryRef.current=current;setInventory(current);
        }
        initial=false;
      }catch{
        if(stopped||abort.signal.aborted||generation!==inventoryEpoch.current)return;
        visibilityEpoch.current++;previewEpoch.current++;previewRequest.current?.abort();
        inventoryRef.current=null;setInventory(null);setSourceIds([]);setSkillIds([]);setPreview(null);setPreviewSelection(null);
        setConfirmation(null);setImportKind(null);setSourceText("");setSkillPackage(null);setTitle("");setError("Resources unavailable");initial=true;
      }finally{pending=false;if(!stopped&&generation===inventoryEpoch.current)setLoading(false);}
    };
    const tick=async()=>{await refresh();if(!stopped)timer=setTimeout(()=>void tick(),5000);};
    const visible=()=>{if(document.visibilityState==="visible")void refresh();};
    void tick();document.addEventListener("visibilitychange",visible);
    return()=>{stopped=true;clearTimeout(timer);inventoryEpoch.current++;visibilityEpoch.current++;inventoryRequest.current?.abort();document.removeEventListener("visibilitychange",visible);};
  }, [featureId, open, retry]);
  useEffect(() => {
    if (!open||!previewSelection) return;
    let stopped=false,pending=false,timer:ReturnType<typeof setTimeout>;
    const refresh=async()=>{
      if(stopped||pending||document.visibilityState!=="visible")return;
      pending=true;const abort=new AbortController(),generation=++previewEpoch.current;previewRequest.current=abort;
      try{const result=await growthAgents.resourcePreview(featureId,previewSelection,abort.signal);
        if(!stopped&&!abort.signal.aborted&&generation===previewEpoch.current){setPreview(result);setPreviewError(null);}
      }catch{if(!stopped&&!abort.signal.aborted&&generation===previewEpoch.current){setPreview(null);setPreviewError("Resource unavailable");}}
      finally{pending=false;}
    };
    const tick=async()=>{await refresh();if(!stopped)timer=setTimeout(()=>void tick(),5000);};
    const visible=()=>{if(document.visibilityState==="visible")void refresh();};
    void tick();document.addEventListener("visibilitychange",visible);
    return()=>{stopped=true;clearTimeout(timer);previewEpoch.current++;previewRequest.current?.abort();document.removeEventListener("visibilitychange",visible);};
  }, [featureId, open, previewSelection]);

  const update = (result: GrowthAgentResourceInventory, saved = false) => {
    inventoryEpoch.current++;inventoryRequest.current?.abort();inventoryRef.current=result;setInventory(result);
    if (saved) { setSourceIds(result.sourceRevisionIds); setSkillIds(result.skillIds);setStaleSelection(false); }
  };
  async function act(key: string, run: (requestId: string) => Promise<GrowthAgentResourceInventory>, message: string, done?: () => void, saved = false) {
    if (pendingMutation.current) return;
    pendingMutation.current=true;const epoch=visibilityEpoch.current;
    const requestId = requestKeys.current.get(key) ?? crypto.randomUUID(); requestKeys.current.set(key, requestId);
    setBusy(true); setError(null); setFormError(null);
    try { const result=await run(requestId);if(epoch!==visibilityEpoch.current)return;update(result,saved);requestKeys.current.delete(key);done?.();toast.success(message);await onSaved(); }
    catch (error) { if(epoch===visibilityEpoch.current){const message = failure(error); setError(message); setFormError(message);} }
    finally { pendingMutation.current=false;setBusy(false); }
  }
  function showPreview(selection: PreviewSelection) { setPreview(null); setPreviewError(null); setPreviewSelection(selection); }
  function toggle(ids: string[], id: string, checked: boolean) { return checked ? [...ids.filter(value => value !== id), id] : ids.filter(value => value !== id); }
  async function readSource(file?: File) {
    if (!file) return;
    if (file.size > 262144 || !/\.(txt|md|markdown)$/i.test(file.name)) { setFormError("Choose a text or Markdown file under 256 KB."); return; }
    setFormError(null); setTitle(file.name.replace(/\.[^.]+$/, "")); setSourceText(await file.text());
  }
  async function readSkill(file?: File) {
    if (!file) return;
    if (!/\.(zip|md)$/i.test(file.name) || file.size > (/\.zip$/i.test(file.name) ? 2097152 : 524288)) { setFormError("Choose SKILL.md under 512 KB or a ZIP under 2 MB."); return; }
    try {
      if (/\.zip$/i.test(file.name)) {
        const contentBase64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(",")[1] ?? ""); reader.onerror = () => reject(new Error("Unable to read the archive.")); reader.readAsDataURL(file); });
        setSkillPackage({ source: "zip", contentBase64 });
      } else setSkillPackage({ source: "files", files: [{ path: "SKILL.md", content: await file.text() }] });
      setCurated(""); setSkillFilename(file.name); setFormError(null);
    } catch (error) { setFormError(failure(error)); }
  }
  function importResource() {
    if (importKind === "source") {
      if (!title.trim() || !sourceText.trim()) { setFormError("Add a title and content."); return; }
      if (new TextEncoder().encode(sourceText).byteLength > 262144) { setFormError("Content must be under 256 KB."); return; }
      const input = { title, text: sourceText, contentType: "text/markdown" as const };
      void act(JSON.stringify(["source", input]), requestId => growthAgents.importSource(featureId, input, requestId), "Source imported", () => { setImportKind(null); setTitle(""); setSourceText(""); });
    } else {
      const input = curated ? { source: "curated" as const, slug: curated } : skillPackage;
      if (!input) { setFormError("Choose a skill."); return; }
      void act(JSON.stringify(["skill", input]), requestId => growthAgents.importSkill(featureId, input, requestId), "Skill imported", () => { setImportKind(null); setSkillPackage(null); setSkillFilename(""); setCurated(""); });
    }
  }
  const selectedSource = previewSelection?.kind === "source" ? inventory?.sources.find(source => source.id === previewSelection.sourceId) : undefined;
  const selectedRevision = selectedSource?.revisions.find(revision => previewSelection?.kind === "source" && revision.id === previewSelection.revisionId);
  const selectedSkill = previewSelection?.kind === "skill" ? inventory?.skills.find(skill => skill.id === previewSelection.skillId) : undefined;
  const previewUnavailable=!!previewSelection&&(previewSelection.kind==="source"?selectedSource?.state!=="active"||!selectedRevision||selectedRevision.state==="withdrawn":!selectedSkill||selectedSkill.state==="removed");
  const changed = !!inventory && (!sameIds(sourceIds, inventory.sourceRevisionIds) || !sameIds(skillIds, inventory.skillIds));
  const unlistedSourceIds = inventory ? sourceIds.filter(id => !inventory.sources.some(source => source.revisions.some(revision => revision.id === id))) : [];
  const unlistedSkillIds = inventory ? skillIds.filter(id => !inventory.skills.some(skill => skill.id === id)) : [];
  return <>
    <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="sm:max-w-3xl"
      onOpenAutoFocus={()=>{opener.current=document.activeElement instanceof HTMLElement?document.activeElement:null;}}
      onCloseAutoFocus={event=>{if(opener.current?.isConnected&&!opener.current.matches(":disabled")){event.preventDefault();opener.current.focus({preventScroll:true});}}}>
      <DialogHeader><DialogTitle>Knowledge &amp; skills</DialogTitle><DialogDescription>{name}</DialogDescription></DialogHeader>
      {error ? <div role="alert" className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/30 p-3 text-sm"><span className="min-w-0 flex-1">{error}</span><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { setLoading(true); setRetry(value => value + 1); }}>Refresh</Button></div> : null}
      {loading ? <div role="status" aria-label="Loading resources" className="space-y-3"><Skeleton className="h-10" /><Skeleton className="h-24" /><Skeleton className="h-24" /></div> : inventory ? <Tabs defaultValue="knowledge">
        <TabsList className="w-full"><TabsTrigger className="flex-1" value="knowledge">Knowledge</TabsTrigger><TabsTrigger className="flex-1" value="skills">Skills</TabsTrigger></TabsList>
        <TabsContent value="knowledge" className="space-y-3"><div className="flex justify-end"><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { setFormError(null); setImportKind("source"); }}>Add source</Button></div>
          {!inventory.sources.length ? <p className="py-8 text-center text-sm text-muted-foreground">No knowledge sources</p> : inventory.sources.map(source => <article key={source.id} className="rounded-lg border border-border p-3 sm:p-4"><div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h3 className="min-w-0 break-words text-sm font-medium">{source.title}</h3>{source.state === "active" ? <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmation({ kind: "source", id: source.id, title: source.title, generation: source.generation })}>Withdraw</Button> : <span className="text-xs text-muted-foreground">Withdrawn</span>}</div>
            <div className="space-y-2">{source.revisions.map(revision => <div key={revision.id} className="flex items-center gap-3"><label className="flex min-h-9 min-w-0 flex-1 items-center gap-2 text-sm"><Checkbox checked={sourceIds.includes(revision.id)} disabled={busy || !sourceIds.includes(revision.id) && (source.state !== "active" || revision.state !== "approved")} onCheckedChange={checked => setSourceIds(previous => toggle(previous, revision.id, checked === true))} /><span className="min-w-0">Version {revision.revision}<span className="ml-2 text-xs text-muted-foreground">{source.state !== "active" || revision.state === "withdrawn" ? "Withdrawn" : revision.state === "candidate" ? "Needs review" : "Approved"}</span></span></label><Button type="button" variant="ghost" size="sm" disabled={busy || source.state !== "active"} onClick={() => showPreview({ kind: "source", sourceId: source.id, revisionId: revision.id })}>Review</Button></div>)}</div>
          </article>)}
          {unlistedSourceIds.map(id => <label key={id} className="flex min-h-11 items-center gap-3 rounded-lg border p-3 text-sm"><Checkbox checked disabled={busy} onCheckedChange={() => setSourceIds(previous => previous.filter(value => value !== id))} />Unlisted selected source</label>)}
        </TabsContent>
        <TabsContent value="skills" className="space-y-3"><div className="flex justify-end"><Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => { setFormError(null); setImportKind("skill"); }}>Add skill</Button></div>
          {!inventory.skills.length ? <p className="py-8 text-center text-sm text-muted-foreground">No skills</p> : inventory.skills.map(skill => <article key={skill.id} className="rounded-lg border border-border p-3 sm:p-4"><div className="flex flex-wrap items-start gap-3"><label className="flex min-h-9 min-w-0 flex-1 items-center gap-2"><Checkbox checked={skillIds.includes(skill.id)} disabled={busy || !skillIds.includes(skill.id) && !readySkill(skill)} onCheckedChange={checked => setSkillIds(previous => toggle(previous, skill.id, checked === true))} /><span className="min-w-0 break-words text-sm font-medium">{skill.name}</span></label><Button type="button" variant="ghost" size="sm" disabled={busy || skill.state === "removed"} onClick={() => showPreview({ kind: "skill", skillId: skill.id, path: "SKILL.md" })}>Review</Button></div><p className="mt-1 break-words text-sm text-muted-foreground">{skill.description}</p><div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground"><span>Version {skill.revision} · {skill.state === "removed" ? "Removed" : skill.reviewState !== "reviewed" ? "Needs review" : skill.state === "disabled" ? "Disabled" : readySkill(skill) ? "Ready" : "Requirements unavailable"}</span>{skill.state !== "removed" ? <><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => skill.state === "disabled" ? void act(`enable:${skill.id}:${skill.generation}`, requestId => growthAgents.skillState(featureId, { skillId: skill.id, expectedGeneration: skill.generation, state: "enabled" }, requestId), "Skill enabled") : setConfirmation({ kind: "skill", id: skill.id, title: skill.name, generation: skill.generation, state: "disabled" })}>{skill.state === "disabled" ? "Enable" : "Disable"}</Button><Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmation({ kind: "skill", id: skill.id, title: skill.name, generation: skill.generation, state: "removed" })}>Remove</Button></> : null}</div>{!readySkill(skill) && skill.reviewState === "reviewed" && skill.state === "enabled" ? <p className="mt-2 break-words text-xs text-muted-foreground">Missing: {[...skill.missing.permissions, ...skill.missing.connectionProfiles, ...skill.missing.runtimes].join(", ")}</p> : null}</article>)}
          {unlistedSkillIds.map(id => <label key={id} className="flex min-h-11 items-center gap-3 rounded-lg border p-3 text-sm"><Checkbox checked disabled={busy} onCheckedChange={() => setSkillIds(previous => previous.filter(value => value !== id))} />Unlisted selected skill</label>)}
        </TabsContent>
      </Tabs> : null}
      <DialogFooter><Button ref={closeButton} type="button" variant="outline" onClick={() => onOpenChange(false)}>Close</Button><Button type="button" disabled={busy || !changed || !inventory||staleSelection} onClick={() => {
        if (!inventory) return;
        const input = { expectedRevision: inventory.revision, sourceRevisionIds: sourceIds, skillIds };
        void act(JSON.stringify(["select", input]), requestId => growthAgents.selectResources(featureId, input, requestId), "Resources saved", undefined, true);
      }}>{busy ? "Saving…" : "Save selection"}</Button></DialogFooter>
    </DialogContent></Dialog>
    <Dialog open={importKind !== null} onOpenChange={open => { if (!open && !busy) setImportKind(null); }}><DialogContent className="sm:max-w-xl"><DialogHeader><DialogTitle>{importKind === "source" ? "Add knowledge source" : "Add skill"}</DialogTitle><DialogDescription className="sr-only">Import a resource for review</DialogDescription></DialogHeader>
      {importKind === "source" ? <div className="space-y-4"><label className="block space-y-1 text-sm"><span>Title</span><Input maxLength={200} value={title} onChange={event => setTitle(event.target.value)} disabled={busy} /></label><label className="block space-y-1 text-sm"><span>Content</span><Textarea className="min-h-56" value={sourceText} onChange={event => setSourceText(event.target.value)} disabled={busy} /></label><label className="block space-y-1 text-sm"><span>Text or Markdown file</span><Input type="file" accept=".txt,.md,.markdown,text/plain,text/markdown" disabled={busy} onChange={event => void readSource(event.target.files?.[0]).catch(error => setFormError(failure(error)))} /></label></div> : <div className="space-y-4"><label className="block space-y-1 text-sm"><span>Catalogue</span><select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={curated} disabled={busy} onChange={event => { setCurated(event.target.value); setSkillPackage(null); setSkillFilename(""); }}><option value="">Choose a skill</option>{inventory?.curatedSkills.map(skill => <option key={skill.slug} value={skill.slug}>{skill.name}</option>)}</select></label><label className="block space-y-1 text-sm"><span>SKILL.md or skill ZIP</span><Input type="file" accept=".md,.zip" disabled={busy} onChange={event => void readSkill(event.target.files?.[0])} /></label>{skillFilename ? <p className="break-words text-sm text-muted-foreground">{skillFilename}</p> : null}</div>}
      {formError ? <p role="alert" className="text-sm text-destructive">{formError}</p> : null}<DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={() => setImportKind(null)}>Cancel</Button><Button type="button" disabled={busy} onClick={importResource}>{busy ? "Importing…" : "Import"}</Button></DialogFooter>
    </DialogContent></Dialog>
    <Dialog open={previewSelection !== null} onOpenChange={open => { if (!open) setPreviewSelection(null); }}><DialogContent className="sm:max-w-3xl"
      onOpenAutoFocus={()=>{previewOpener.current=document.activeElement instanceof HTMLElement?document.activeElement:null;}}
      onCloseAutoFocus={event=>{const target=previewOpener.current?.isConnected&&!previewOpener.current.matches(":disabled")?previewOpener.current:closeButton.current;if(target?.isConnected){event.preventDefault();target.focus({preventScroll:true});}}}><DialogHeader><DialogTitle>{selectedSource?.title ?? selectedSkill?.name ?? "Review resource"}</DialogTitle><DialogDescription>{previewSelection?.kind === "skill" ? "Review the procedure and package files." : "Review the exact source content."}</DialogDescription></DialogHeader>
      {selectedSkill ? <label className="block space-y-1 text-sm"><span>File</span><select className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm" value={previewSelection?.kind === "skill" ? previewSelection.path : "SKILL.md"} onChange={event => showPreview({ kind: "skill", skillId: selectedSkill.id, path: event.target.value })}>{selectedSkill.files.map(file => <option key={file.path} value={file.path}>{file.path}</option>)}</select></label> : null}
      {previewUnavailable||previewError ? <p role="alert" className="text-sm text-destructive">{previewUnavailable?"Resource unavailable":previewError}</p> : preview ? <><pre className="max-h-[50dvh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/30 p-3 text-xs leading-6 sm:text-sm">{preview.content}</pre><details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Content digest</summary><p className="mt-2 break-all font-mono">{selectedSkill?.contentDigest ?? preview.contentDigest}</p></details></> : <Skeleton aria-label="Loading preview" className="h-48" />}
      <DialogFooter><Button type="button" variant="outline" onClick={() => setPreviewSelection(null)}>Close</Button>{selectedSource && selectedRevision?.state === "candidate" ? <Button type="button" disabled={busy || !preview||previewUnavailable||!!previewError} onClick={() => void act(`review-source:${selectedRevision.id}:${selectedSource.generation}`, requestId => growthAgents.reviewSource(featureId, { sourceId: selectedSource.id, revisionId: selectedRevision.id, expectedGeneration: selectedSource.generation }, requestId), "Source approved", () => setPreviewSelection(null))}>{busy ? "Approving…" : "Approve source"}</Button> : selectedSkill?.reviewState === "pending" ? <Button type="button" disabled={busy || !preview||previewUnavailable||!!previewError} onClick={() => void act(`review-skill:${selectedSkill.id}:${selectedSkill.contentDigest}`, requestId => growthAgents.reviewSkill(featureId, { skillId: selectedSkill.id, contentDigest: selectedSkill.contentDigest }, requestId), "Skill approved", () => setPreviewSelection(null))}>{busy ? "Approving…" : "Approve package"}</Button> : null}</DialogFooter>
    </DialogContent></Dialog>
    <AlertDialog open={confirmation !== null} onOpenChange={open => { if (!open && !busy) setConfirmation(null); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{confirmation?.kind === "source" ? "Withdraw source?" : confirmation?.state === "removed" ? "Remove skill?" : "Disable skill?"}</AlertDialogTitle><AlertDialogDescription className="break-words">{confirmation?.title}</AlertDialogDescription></AlertDialogHeader>{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}<AlertDialogFooter><AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel><Button type="button" variant="destructive" disabled={busy} onClick={() => {
      if (!confirmation) return;
      const selected = confirmation;
      void act(JSON.stringify(["state", selected]), requestId => selected.kind === "source" ? growthAgents.sourceState(featureId, { sourceId: selected.id, expectedGeneration: selected.generation, state: "withdrawn" }, requestId) : growthAgents.skillState(featureId, { skillId: selected.id, expectedGeneration: selected.generation, state: selected.state }, requestId), "Resource updated", () => setConfirmation(null));
    }}>{busy ? "Updating…" : confirmation?.kind === "source" ? "Withdraw" : confirmation?.state === "removed" ? "Remove" : "Disable"}</Button></AlertDialogFooter></AlertDialogContent></AlertDialog>
  </>;
}
