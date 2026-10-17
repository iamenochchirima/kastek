import { useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { api, message, type Skill } from "./api";
import { ErrorMessage } from "./shell";

export function AgentSkills({ path, skills, onPublish }: { path: string; skills: Skill[]; onPublish: (skill: Skill) => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [reviewed, setReviewed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<{ digest: string; operationId: string } | null>(null);
  async function publish(event: FormEvent) {
    event.preventDefault(); if (!reviewed) return; setBusy(true); setError("");
    const digest = JSON.stringify({ name, description, body });
    if (request.current?.digest !== digest) request.current = { digest, operationId: crypto.randomUUID() };
    try { const { skill } = await api<{ skill: Skill }>(`${path}/skills`, { name, description, body, operationId: request.current.operationId }); onPublish(skill); setName(""); setDescription(""); setBody(""); setReviewed(false); request.current = null; }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <section className="max-w-2xl space-y-6" aria-label="Agent skills"><div><h2 className="font-medium">Skills</h2><p className="mt-1 text-sm text-muted-foreground">Reviewed procedures. Select a published revision in Configuration to use it.</p></div>
    {skills.length ? <div className="divide-y divide-border">{skills.map(skill => <details key={skill.id} className="py-4"><summary className="cursor-pointer text-sm font-medium">{skill.name}<span className="ml-2 text-xs font-normal text-muted-foreground">Revision {skill.revision}</span></summary><p className="mt-3 text-sm text-muted-foreground">{skill.description}</p><p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6">{skill.body}</p></details>)}</div> : <p className="text-sm text-muted-foreground">No published skills.</p>}
    <form onSubmit={event => void publish(event)} className="space-y-4 border-t border-border pt-6"><h3 className="text-sm font-medium">Publish a skill</h3><ErrorMessage value={error} /><label className="block space-y-2 text-sm">Skill name<Input required maxLength={80} pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="check-sources" title="Use lowercase words joined with hyphens" value={name} onChange={event => { setName(event.target.value); setReviewed(false); }} /></label><label className="block space-y-2 text-sm">Description<Input required maxLength={500} value={description} onChange={event => { setDescription(event.target.value); setReviewed(false); }} /></label><label className="block space-y-2 text-sm">Procedure<Textarea rows={7} required maxLength={8000} value={body} onChange={event => { setBody(event.target.value); setReviewed(false); }} /></label><label className="flex items-start gap-3 text-sm"><input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-primary" checked={reviewed} onChange={event => setReviewed(event.target.checked)} /><span>I reviewed this procedure. Publishing saves an immutable revision.</span></label><Button type="submit" disabled={busy || !reviewed || !name.trim() || !body.trim()}>{busy ? "Publishing…" : "Publish skill"}</Button></form>
  </section>;
}
