import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { api, message, type Memory } from "./api";
import { ErrorMessage, Loading } from "./shell";

export function AgentMemory({ path }: { path: string }) {
  const [records, setRecords] = useState<{ items: Memory[]; candidates: Memory[] } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<{ action: "add" | "correct" | "forget"; item?: Memory; operationId: string } | null>(null);
  const [content, setContent] = useState("");
  const requestIds = useRef(new Map<string, string>());
  const endpoint = `${path}/memory`;
  async function refresh() { setRecords(await api<{ items: Memory[]; candidates: Memory[] }>(endpoint)); }
  useEffect(() => { let live = true; api<{ items: Memory[]; candidates: Memory[] }>(endpoint).then(result => { if (live) setRecords(result); }).catch(e => { if (live) setError(message(e)); }); return () => { live = false; }; }, [endpoint]);
  function open(action: "add" | "correct" | "forget", item?: Memory) { setContent(item?.content ?? ""); setError(""); setDialog({ action, item, operationId: crypto.randomUUID() }); }
  async function accept(item: Memory) {
    const key = `${item.id}:${item.revision}:accept`;
    const operationId = requestIds.current.get(key) ?? crypto.randomUUID();
    requestIds.current.set(key, operationId); setBusy(true); setError("");
    try { await api(`${endpoint}/candidates/${encodeURIComponent(item.id)}/accept`, { operationId, expectedRevision: item.revision }); await refresh(); requestIds.current.delete(key); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!dialog) return; setBusy(true); setError("");
    try {
      const item = dialog.item;
      if (dialog.action === "add") await api(endpoint, { operationId: dialog.operationId, kind: "semantic", content });
      else if (dialog.action === "correct" && item) await api(`${endpoint}/${encodeURIComponent(item.id)}`, { operationId: dialog.operationId, expectedRevision: item.revision, content }, "PATCH");
      else if (item) await api(`${endpoint}/${encodeURIComponent(item.id)}/forget`, { operationId: dialog.operationId, expectedRevision: item.revision });
      await refresh(); setDialog(null);
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <section className="max-w-2xl space-y-6" aria-label="Personal memory">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-medium">Your memory</h2><p className="mt-1 text-sm text-muted-foreground">Only your permitted conversations with this agent can use these memories.</p></div><Button variant="outline" onClick={() => open("add")}>Add memory</Button></div>
    {!dialog ? <ErrorMessage value={error} /> : null}
    {!records && !error ? <Loading /> : records ? <>
      {records.candidates.length ? <section className="space-y-3" aria-label="Memory suggestions"><h3 className="text-sm font-medium">Suggestions to review</h3><div className="divide-y divide-border rounded-lg border border-border">{records.candidates.map(item => <div key={item.id} className="space-y-3 p-4"><p className="whitespace-pre-wrap break-words text-sm">{item.content}</p><div className="flex flex-wrap gap-2"><Button size="sm" disabled={busy} onClick={() => void accept(item)}>Remember</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => open("correct", item)}>Edit</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => open("forget", item)}>Dismiss</Button></div></div>)}</div></section> : null}
      {records.items.length ? <div className="divide-y divide-border">{records.items.map(item => <div key={item.id} className="flex flex-wrap items-start justify-between gap-3 py-4"><p className="min-w-0 flex-1 basis-60 whitespace-pre-wrap break-words text-sm">{item.content}</p><div className="flex gap-2"><Button size="sm" variant="outline" disabled={busy} onClick={() => open("correct", item)}>Correct</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => open("forget", item)}>Forget</Button></div></div>)}</div> : <p className="py-6 text-sm text-muted-foreground">No saved memories.</p>}
    </> : null}
    <Dialog open={Boolean(dialog)} onOpenChange={value => { if (!value && !busy) setDialog(null); }}><DialogContent><DialogHeader><DialogTitle>{dialog?.action === "add" ? "Add memory" : dialog?.action === "correct" ? "Correct memory" : "Forget memory"}</DialogTitle><DialogDescription>{dialog?.action === "forget" ? "Future replies will stop using this memory. Earlier replies may still contain it." : "Save a preference or fact you want this agent to remember."}</DialogDescription></DialogHeader><form className="space-y-4" onSubmit={event => void save(event)}><ErrorMessage value={error} />{dialog?.action === "forget" ? <p className="whitespace-pre-wrap break-words text-sm">{dialog.item?.content}</p> : <label className="block space-y-2 text-sm">Memory<Textarea autoFocus required maxLength={2000} rows={4} value={content} onChange={event => setContent(event.target.value)} /></label>}<div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" disabled={busy} onClick={() => setDialog(null)}>Cancel</Button><Button type="submit" disabled={busy || (dialog?.action !== "forget" && !content.trim())}>{busy ? "Saving…" : dialog?.action === "forget" ? "Forget memory" : dialog?.action === "add" ? "Add suggestion" : "Save correction"}</Button></div></form></DialogContent></Dialog>
  </section>;
}
