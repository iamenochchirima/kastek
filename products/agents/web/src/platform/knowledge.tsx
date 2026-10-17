import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, message, organizationPath, type Knowledge } from "./api";
import { ErrorMessage, Loading, useWorkspace } from "./shell";

export function KnowledgePage() {
  const { organizationId } = useWorkspace();
  const path = `${organizationPath(organizationId)}/knowledge`;
  const [sources, setSources] = useState<Knowledge[] | null>(null);
  const [error, setError] = useState("");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [visibility, setVisibility] = useState<"public" | "private">("public");
  const [busy, setBusy] = useState(false);
  useEffect(() => { let live = true; api<{ knowledge: Knowledge[] }>(path).then(result => { if (live) setSources(result.knowledge); }).catch(e => { if (live) setError(message(e)); }); return () => { live = false; }; }, [path]);
  async function add(event: FormEvent) { event.preventDefault(); setBusy(true); setError(""); try { const { knowledge } = await api<{ knowledge: Knowledge }>(path, { title, content, visibility }); setSources(current => [...current ?? [], knowledge]); setTitle(""); setContent(""); toast.success("Knowledge approved"); } catch (e) { setError(message(e)); } finally { setBusy(false); } }
  return <div className="max-w-2xl space-y-7"><h1 className="text-2xl font-semibold tracking-tight">Knowledge</h1><ErrorMessage value={error} />
    {!sources && !error ? <Loading /> : sources?.length ? <div className="divide-y divide-border rounded-lg border border-border bg-card">{sources.map(source => <details key={source.id} className="p-4"><summary className="cursor-pointer text-sm font-medium">{source.title}<span className="ml-3 text-xs font-normal text-muted-foreground">{source.visibility}</span></summary><p className="mt-4 whitespace-pre-wrap break-words text-sm leading-6">{source.content}</p></details>)}</div> : !error ? <p className="text-sm text-muted-foreground">No sources yet</p> : null}
    <form className="space-y-4 rounded-lg border border-border bg-card p-5" onSubmit={event => void add(event)}><h2 className="font-medium">Add knowledge</h2><label className="block space-y-2 text-sm">Title<Input required maxLength={200} value={title} onChange={event => setTitle(event.target.value)} /></label><label className="block space-y-2 text-sm">Content<Textarea rows={7} required maxLength={8_000} value={content} onChange={event => setContent(event.target.value)} /></label><label className="block space-y-2 text-sm">Visibility<select className="w-full rounded-md border border-border bg-background px-3 py-2" value={visibility} onChange={event => setVisibility(event.target.value as "public" | "private")}><option value="public">Public</option><option value="private">Private</option></select></label><p className="text-xs text-muted-foreground">Public sources may appear in website replies.</p><Button type="submit" disabled={busy || !title.trim() || !content.trim()}>{busy ? "Saving…" : "Approve source"}</Button></form>
  </div>;
}
