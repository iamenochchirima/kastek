import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useConfirmationDialog } from "@/components/ui/confirmation-provider";
import { api, message, type CalendarServiceConnector } from "./api";
import { ErrorMessage, Loading } from "./shell";

type CalendarConnection = { id: string; name: string; status: string; account: { subject: string; email: string } | null; calendar: { id: string; name: string; timeZone: string; role: string } | null; revision: number; policyRevision: number; generation: number; sharing: "private" | "organization_service"; customerDeploymentEligible: boolean; readiness: { state: string; reasons: { code: string; message: string }[] } };
type ProviderStatus = { available: boolean; reasons: { code: string; message: string }[] };
type Calendar = { id: string; name: string; timeZone: string; role: string };

export function CalendarServiceConnections({ path, owner, connector }: { path: string; owner: boolean; connector: CalendarServiceConnector }) {
  const [params] = useSearchParams();
  const requestedConnector = params.get("connector");
  const requested = requestedConnector ? requestedConnector === connector.id : params.get("profile") === connector.profileId;
  const [open, setOpen] = useState(requested);
  const [status, setStatus] = useState<ProviderStatus | null>(connector.readiness), [connections, setConnections] = useState<CalendarConnection[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(requested ? params.get("setup") : null);
  const [calendars, setCalendars] = useState<Calendar[] | null>(null), [calendarId, setCalendarId] = useState("");
  const [name, setName] = useState(connector.name), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const { confirm } = useConfirmationDialog();
  const selected = connections.find(connection => connection.id === selectedId);
  async function refresh() {
    const [provider, list] = await Promise.all([api<ProviderStatus>(`${path}/status`), api<{ connections: CalendarConnection[] }>(`${path}/connections`)]);
    setStatus({ available: connector.readiness.available && provider.available, reasons: [...connector.readiness.reasons, ...provider.reasons].filter((reason, index, values) => values.findIndex(item => item.code === reason.code) === index) }); setConnections(list.connections);
  }
  useEffect(() => { if (!open || !owner) return; let live = true; Promise.all([api<ProviderStatus>(`${path}/status`), api<{ connections: CalendarConnection[] }>(`${path}/connections`)]).then(([provider, list]) => { if (live) { setStatus({ available: connector.readiness.available && provider.available, reasons: [...connector.readiness.reasons, ...provider.reasons].filter((reason, index, values) => values.findIndex(item => item.code === reason.code) === index) }); setConnections(list.connections); setError(""); } }).catch(e => { if (live) setError(message(e)); }); return () => { live = false; }; }, [open, owner, path, connector.readiness]);
  async function run(action: () => Promise<void>) { setBusy(true); setError(""); try { await action(); } catch (e) { setError(message(e)); try { await refresh(); } catch { /* Keep the original error available for retry. */ } } finally { setBusy(false); } }
  function update(connection: CalendarConnection) { setConnections(current => current.map(item => item.id === connection.id ? connection : item)); }
  async function authorize(connection: CalendarConnection) {
    const result = await api<{ authorizationUrl: string }>(`${path}/connections/${encodeURIComponent(connection.id)}/authorize`, {});
    const url = new URL(result.authorizationUrl);
    if (url.protocol !== "https:") throw new Error(`${connector.setup.identityLabel} sign-in is unavailable. Try again later.`);
    window.location.assign(url.href);
  }
  async function create() {
    const result = await api<{ connection: CalendarConnection }>(`${path}/connections`, { name: name.trim() });
    setConnections(current => [...current, result.connection]); setSelectedId(result.connection.id);
    await authorize(result.connection);
  }
  async function loadCalendars(connection: CalendarConnection) {
    setSelectedId(connection.id); setCalendars(null); setCalendarId(connection.calendar?.id ?? "");
    const result = await api<{ items: Calendar[] }>(`${path}/connections/${encodeURIComponent(connection.id)}/calendars`); setCalendars(result.items);
  }
  async function sharing(connection: CalendarConnection) {
    const next = connection.sharing === "private" ? "organization_service" : "private";
    if (!await confirm({ title: next === "organization_service" ? "Use this calendar for customer bookings?" : "Make this calendar private?", description: next === "organization_service" ? "The organization can use this calendar for its booking service. Publishing a booking agent still requires a booking policy and customer confirmation." : "Customer booking access will stop. Published booking agents will need their access reviewed.", confirmLabel: next === "organization_service" ? "Allow booking service" : "Make private" })) return;
    await run(async () => { const result = await api<{ connection: CalendarConnection }>(`${path}/connections/${encodeURIComponent(connection.id)}/sharing`, { generation: connection.generation, sharing: next }); update(result.connection); });
  }
  async function disconnect(connection: CalendarConnection) {
    if (!await confirm({ title: `Disconnect ${connection.name}?`, description: "Agents will lose access to this calendar. Existing appointments will remain in the connected calendar.", confirmLabel: "Disconnect", variant: "destructive" })) return;
    await run(async () => { await api(`${path}/connections/${encodeURIComponent(connection.id)}/disconnect`, { generation: connection.generation }); await refresh(); setCalendars(null); });
  }
  return <><div className="management-row flex flex-wrap items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><CalendarDays size={20} className="shrink-0" aria-hidden="true" /><div className="min-w-0"><h2 className="break-words font-medium">{connector.name}</h2><p className="break-words text-sm text-muted-foreground">{connector.description}</p>{!connector.readiness.available ? <p className="mt-1 break-words text-xs text-muted-foreground">{connector.readiness.reasons.map(reason => reason.message).join(" ") || "Unavailable"}</p> : null}</div></div><Button variant="outline" size="sm" disabled={!owner} onClick={() => setOpen(true)}>{owner ? connector.readiness.available ? "Connect or manage" : "View setup" : "Owner access required"}</Button></div><Dialog open={open} onOpenChange={value => { if (!busy) { setOpen(value); setCalendars(null); } }}><DialogContent className="sm:max-w-2xl" showCloseButton={!busy}><DialogHeader><DialogTitle>{connector.name}</DialogTitle><DialogDescription>Connections start private. Choose a calendar after signing in to {connector.setup.identityLabel}.</DialogDescription></DialogHeader><ErrorMessage value={error} />{!owner ? <p className="text-sm">An organization owner must manage this connection.</p> : !status && !error ? <Loading /> : <>
    {status && !status.available ? <p className="text-sm text-muted-foreground">{status.reasons.map(reason => reason.message).join(" ") || "Calendar access is unavailable. Contact your administrator."}</p> : null}
    {connections.map(connection => <div className="space-y-2 border-b border-border pb-4" key={connection.id}><h3 className="font-medium break-words">{connection.name}</h3><p className="text-sm text-muted-foreground break-words">{connection.account?.email ?? connection.status.replaceAll("_", " ")}{connection.calendar ? ` · ${connection.calendar.name} · ${connection.calendar.timeZone}` : ""}</p><p className="text-xs text-muted-foreground">{connection.sharing === "private" ? "Private" : "Shared with the booking service"}{connection.customerDeploymentEligible ? " · Calendar access ready for a booking policy" : ""}</p>{connection.readiness.reasons.length ? <p className="text-sm text-muted-foreground">{connection.readiness.reasons.map(reason => reason.message).join(" ")}</p> : null}<div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy || !status?.available} onClick={() => void run(() => authorize(connection))}>Sign in to {connector.setup.identityLabel}</Button><Button size="sm" variant="outline" disabled={busy || !connection.account || !status?.available || connection.status === "disconnected"} onClick={() => void run(() => loadCalendars(connection))}>Choose calendar</Button>{connection.calendar && connection.status !== "disconnected" ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void sharing(connection)}>{connection.sharing === "private" ? "Allow customer bookings" : "Make private"}</Button> : null}{connection.status !== "disconnected" ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void disconnect(connection)}>Disconnect</Button> : null}</div></div>)}
    {selected && calendars ? <form className="space-y-3" onSubmit={event => { event.preventDefault(); void run(async () => { const result = await api<{ connection: CalendarConnection }>(`${path}/connections/${encodeURIComponent(selected.id)}/calendar`, { generation: selected.generation, calendarId }); update(result.connection); setCalendars(null); }); }}><label className="block space-y-2 text-sm">Calendar<select aria-label="Calendar" className="w-full rounded-md border bg-background p-2" required value={calendarId} onChange={event => setCalendarId(event.target.value)}><option value="">Choose a calendar</option>{calendars.map(calendar => <option key={calendar.id} value={calendar.id}>{calendar.name} · {calendar.timeZone} · {calendar.role}</option>)}</select></label>{!calendars.length ? <p className="text-sm text-muted-foreground">No calendars are available for this account.</p> : null}<Button size="sm" disabled={busy || !calendarId}>Save calendar</Button></form> : null}
    {status?.available ? <form className="space-y-3" onSubmit={event => { event.preventDefault(); void run(create); }}><label className="block space-y-2 text-sm">Connection name<Input required maxLength={120} value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label><Button disabled={busy || !name.trim()}>{busy ? "Connecting…" : `Connect ${connector.setup.identityLabel} account`}</Button></form> : null}
    </>}</DialogContent></Dialog></>;
}
