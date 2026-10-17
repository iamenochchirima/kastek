import { useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { api, message, type Automation, type AutomationSchedule, type Connection, type Version } from "./api";
import { localDateTime } from "./time";
import { ErrorMessage } from "./shell";

export type AutomationVersion = { agentName: string; version: Version };
export function AutomationForm({ open, automation, operationId, reviewerAccountId, reviewerName, versions, connections, path, onClose, onSaved }: {
  open: boolean; automation?: Automation; operationId: string; reviewerAccountId: string; reviewerName: string; connections: Connection[]; versions: AutomationVersion[]; path: string; onClose: () => void; onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(automation?.name ?? "");
  const [versionId, setVersionId] = useState(automation?.versionId ?? versions[0]?.version.id ?? "");
  const [input, setInput] = useState(automation?.input ?? "");
  const [reviewer, setReviewer] = useState(automation?.reviewerAccountId ?? reviewerAccountId);
  const [kind, setKind] = useState<AutomationSchedule["kind"]>(automation?.schedule.kind ?? "once");
  const [at, setAt] = useState(localDateTime(automation?.schedule.kind === "once" ? automation.schedule.at : automation?.schedule.kind === "interval" ? automation.schedule.anchor : new Date(Date.now() + 300_000).toISOString()));
  const [seconds, setSeconds] = useState(automation?.schedule.kind === "interval" ? automation.schedule.everySeconds : 3600);
  const [expiresAt, setExpiresAt] = useState(localDateTime(automation?.expiresAt ?? new Date(Date.now() + 7 * 86_400_000).toISOString()));
  const [limit, setLimit] = useState(automation?.maxOccurrencesPerDay ?? 20);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const pinned = versions.find(item => item.version.id === versionId);
  const workflow = pinned?.version.configuration.capabilities.workflows;
  const connection = workflow?.enabled ? connections.find(item => item.id === workflow.connectionId) : undefined;
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const schedule: AutomationSchedule = kind === "event" ? { kind } : kind === "once" ? { kind, at: new Date(at).toISOString() } : { kind, anchor: new Date(at).toISOString(), everySeconds: seconds };
      await api(automation ? `${path}/${encodeURIComponent(automation.id)}` : path, { operationId, name, versionId, input, reviewerAccountId: reviewer, expiresAt: new Date(expiresAt).toISOString(), maxOccurrencesPerDay: limit, schedule, ...(automation ? { expectedRevision: automation.revision } : {}) }, automation ? "PATCH" : "POST");
      await onSaved(); onClose();
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={value => { if (!value && !busy) onClose(); }}><DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-xl"><DialogHeader><DialogTitle>{automation ? "Edit automation" : "Create automation"}</DialogTitle><DialogDescription>{automation ? "Changes apply to future occurrences. Accepted tasks keep their original version and authority." : "Each report requires approval before delivery."}</DialogDescription></DialogHeader><form className="space-y-4" onSubmit={event => void save(event)}><ErrorMessage value={error} /><label className="block space-y-2 text-sm">Name<Input required maxLength={120} value={name} onChange={event => setName(event.target.value)} autoFocus /></label><label className="block space-y-2 text-sm">Agent version<select required className="w-full min-w-0 rounded-md border border-border bg-background p-2" value={versionId} onChange={event => setVersionId(event.target.value)}><option value="" disabled>Select published version</option>{versionId && !pinned ? <option value={versionId}>Pinned version unavailable</option> : null}{versions.map(item => <option key={item.version.id} value={item.version.id}>{item.agentName} · Version {item.version.number}</option>)}</select></label>{workflow?.enabled ? <p className="break-all text-xs text-muted-foreground">Report: {workflow.reportArtifactName ?? "report.md"} · {connection ? `${connection.name} · ${connection.resource}` : "Connection unavailable"}</p> : null}<label className="block space-y-2 text-sm">Task<Textarea required rows={3} maxLength={8000} value={input} onChange={event => setInput(event.target.value)} /></label><label className="block space-y-2 text-sm">Trigger<select className="w-full rounded-md border border-border bg-background p-2" value={kind} onChange={event => setKind(event.target.value as AutomationSchedule["kind"])}><option value="once">Once</option><option value="interval">Fixed interval</option><option value="event">Authenticated event</option></select></label>{kind !== "event" ? <label className="block space-y-2 text-sm">{kind === "once" ? "Run at" : "First occurrence"}<Input required type="datetime-local" step={1} value={at} onChange={event => setAt(event.target.value)} /><span className="block text-xs text-muted-foreground">{Intl.DateTimeFormat().resolvedOptions().timeZone}</span></label> : null}{kind === "interval" ? <label className="block space-y-2 text-sm">Interval in seconds<Input type="number" required min={60} step={1} value={seconds} onChange={event => setSeconds(Number(event.target.value))} /></label> : null}<div className="grid gap-4 sm:grid-cols-2"><label className="block space-y-2 text-sm">Expires at<Input required type="datetime-local" value={expiresAt} max={localDateTime(new Date(Date.now() + 30 * 86_400_000).toISOString())} onChange={event => setExpiresAt(event.target.value)} /></label><label className="block space-y-2 text-sm">Daily occurrence limit<Input type="number" required min={1} max={20} value={limit} onChange={event => setLimit(Number(event.target.value))} /></label></div><details className="text-sm"><summary className="cursor-pointer">Reviewer: {reviewer === reviewerAccountId ? reviewerName : "Assigned account"}</summary><label className="mt-3 block space-y-2 text-sm">Reviewer account<Input required value={reviewer} onChange={event => setReviewer(event.target.value)} /></label></details><div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" disabled={busy} onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy || !versionId}>{busy ? "Saving…" : automation ? "Save changes" : "Create automation"}</Button></div></form></DialogContent></Dialog>;
}
