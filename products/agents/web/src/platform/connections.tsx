import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { api, message, organizationPath, type Connection, type ConnectionTarget } from "./api";
import { localDateTime } from "./time";
import { ErrorMessage, Loading, useWorkspace } from "./shell";

export function ConnectionsPage() {
  const { organizationId } = useWorkspace();
  const path = `${organizationPath(organizationId)}/connections`;
  const [data, setData] = useState<{ connections: Connection[]; targets: ConnectionTarget[] } | null>(null);
  const [dialog, setDialog] = useState<{ kind: "create" | "rotate" | "revoke"; connection?: Connection; operationId: string } | null>(null);
  const [name, setName] = useState(""), [targetId, setTargetId] = useState(""), [apiKey, setApiKey] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  async function refresh() { setData(await api(path)); }
  useEffect(() => { let live = true; api<{ connections: Connection[]; targets: ConnectionTarget[] }>(path).then(result => { if (live) setData(result); }).catch(e => { if (live) setError(message(e)); }); return () => { live = false; }; }, [path]);
  function open(kind: "create" | "rotate" | "revoke", connection?: Connection) { setError(""); setName(""); setTargetId(data?.targets[0]?.id ?? ""); setApiKey(""); setExpiresAt(localDateTime(connection?.expiresAt ?? new Date(Date.now() + 30 * 86_400_000).toISOString())); setDialog({ kind, connection, operationId: crypto.randomUUID() }); }
  function close() { if (!busy) { setDialog(null); setApiKey(""); } }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!dialog) return; setBusy(true); setError("");
    try {
      if (dialog.kind === "create") await api(path, { operationId: dialog.operationId, name, targetId, apiKey, expiresAt: new Date(expiresAt).toISOString() });
      else if (dialog.connection) await api(`${path}/${encodeURIComponent(dialog.connection.id)}/${dialog.kind}`, { operationId: dialog.operationId, expectedRevision: dialog.connection.revision, ...(dialog.kind === "rotate" ? { apiKey, expiresAt: new Date(expiresAt).toISOString() } : {}) });
      setApiKey(""); await refresh(); setDialog(null);
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <section className="space-y-6"><div className="flex flex-wrap items-center justify-between gap-3"><h1 className="text-2xl font-semibold tracking-tight">Connections</h1><Button onClick={() => open("create")} disabled={!data?.targets.length}>Add connection</Button></div>{!dialog ? <ErrorMessage value={error} /> : null}{!data && !error ? <Loading /> : data ? <div className="divide-y divide-border">{data.connections.length ? data.connections.map(connection => <div key={connection.id} className="flex flex-wrap items-start justify-between gap-4 py-5"><div className="min-w-0 space-y-1"><h2 className="font-medium break-words">{connection.name}</h2><p className="break-all text-sm text-muted-foreground">{connection.targetLabel} · {connection.resource}</p><p className="text-xs text-muted-foreground">{connection.state === "revoked" ? "Revoked" : `Active · revision ${connection.revision} · expires ${new Date(connection.expiresAt).toLocaleString()}`}</p></div>{connection.state === "active" ? <div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => open("rotate", connection)}>Replace key</Button><Button size="sm" variant="ghost" onClick={() => open("revoke", connection)}>Revoke</Button></div> : null}</div>) : <p className="py-8 text-sm text-muted-foreground">{data.targets.length ? "Add a connection to deliver reviewed reports." : "No delivery destinations are configured."}</p>}</div> : null}
    <Dialog open={Boolean(dialog)} onOpenChange={value => { if (!value) close(); }}><DialogContent><DialogHeader><DialogTitle>{dialog?.kind === "create" ? "Add connection" : dialog?.kind === "rotate" ? "Replace key" : "Revoke connection"}</DialogTitle><DialogDescription>{dialog?.kind === "revoke" ? "Future deliveries will be blocked. A delivery already claimed may still finish." : dialog?.kind === "rotate" ? "Pending reviews using the previous key revision will need a new review." : "Choose an approved destination and enter its API key."}</DialogDescription></DialogHeader><form onSubmit={event => void save(event)} className="space-y-4"><ErrorMessage value={error} />{dialog?.kind === "create" ? <><label className="block space-y-2 text-sm">Name<Input required maxLength={120} value={name} onChange={event => setName(event.target.value)} autoFocus /></label><label className="block space-y-2 text-sm">Destination<select required className="w-full rounded-md border border-border bg-background p-2" value={targetId} onChange={event => setTargetId(event.target.value)}>{data?.targets.map(target => <option key={target.id} value={target.id}>{target.label} · {target.resource}</option>)}</select></label></> : <p className="break-words text-sm">{dialog?.connection?.name}</p>}{dialog?.kind !== "revoke" ? <label className="block space-y-2 text-sm">API key<Input type="password" autoComplete="new-password" required value={apiKey} onChange={event => setApiKey(event.target.value)} /></label> : null}{dialog?.kind !== "revoke" ? <label className="block space-y-2 text-sm">Expires at<Input type="datetime-local" required value={expiresAt} max={localDateTime(new Date(Date.now() + 90 * 86_400_000).toISOString())} onChange={event => setExpiresAt(event.target.value)} /></label> : null}<div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" disabled={busy} onClick={close}>Cancel</Button><Button disabled={busy} type="submit">{busy ? "Saving…" : dialog?.kind === "create" ? "Add connection" : dialog?.kind === "rotate" ? "Replace key" : "Revoke connection"}</Button></div></form></DialogContent></Dialog>
  </section>;
}
