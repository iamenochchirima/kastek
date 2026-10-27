import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { CalendarDays, ContactRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useConfirmationDialog } from "@/components/ui/confirmation-provider";
import { api, message, type NativeServiceConnector, type ProviderOperation } from "./api";
import { ErrorMessage, Loading } from "./shell";

type ProviderConnection = { grantedScopes?: string[]; authorizationVerifiedAt?: string | null; credentialExpiresAt?: string | null; providerId: string; operations: string[]; bindingIds: string[]; id: string; name: string; status: string; account: { subject: string; email: string } | null; calendar: { id: string; name: string; timeZone: string; role: string } | null; revision: number; policyRevision: number; generation: number; sharing: "private" | "organization_service"; customerDeploymentEligible: boolean; readiness: { state: string; reasons: { code: string; message: string }[] } };
type ProviderStatus = { available: boolean; reasons: { code: string; message: string }[] };
type Calendar = { id: string; name: string; timeZone: string; role: string };

export function ProviderConnections({ path, owner, connector }: { path: string; owner: boolean; connector: NativeServiceConnector }) {
  const isCalendar = connector.setup.kind === "calendar_service";
  const [operationIds, setOperationIds] = useState<string[]>([]);
  const [operationEdit, setOperationEdit] = useState<{ connectionId: string; generation: number; operations: (ProviderOperation & { selected: boolean })[] } | null>(null);
  const [timeZone, setTimeZone] = useState("");
  const [params] = useSearchParams();
  const createAttempt = useRef<{ signature: string; operationId: string } | null>(null);
  const requestedReturn = params.get("returnTo");
  let returnTo: string | null = null;
  if (requestedReturn?.startsWith("/app/agents/") && !/[\\\x00-\x1f\x7f]/.test(requestedReturn)) {
    const target = new URL(requestedReturn, window.location.origin);
    if (target.origin === window.location.origin && target.pathname.startsWith("/app/agents/")) returnTo = target.pathname + target.search;
  }
  const requestedConnector = params.get("connector");
  const requested = requestedConnector ? requestedConnector === connector.id : params.get("profile") === connector.profileId;
  const [open, setOpen] = useState(requested);
  const [status, setStatus] = useState<ProviderStatus | null>(connector.readiness), [connections, setConnections] = useState<ProviderConnection[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(requested ? params.get("setup") : null);
  const [calendars, setCalendars] = useState<Calendar[] | null>(null), [calendarId, setCalendarId] = useState("");
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState(connector.name), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const { confirm } = useConfirmationDialog();
  const selected = connections.find(connection => connection.id === selectedId);
  async function refresh() {
    const [provider, list] = await Promise.all([api<ProviderStatus>(`${path}/status`), api<{ connections: ProviderConnection[] }>(`${path}/connections`)]);
    setStatus({ available: connector.readiness.available && provider.available, reasons: [...connector.readiness.reasons, ...provider.reasons].filter((reason, index, values) => values.findIndex(item => item.code === reason.code) === index) }); setConnections(list.connections);
  }
  useEffect(() => { if (!open || !owner) return; let live = true; setLoading(true); Promise.all([api<ProviderStatus>(`${path}/status`), api<{ connections: ProviderConnection[] }>(`${path}/connections`)]).then(([provider, list]) => { if (live) { setStatus({ available: connector.readiness.available && provider.available, reasons: [...connector.readiness.reasons, ...provider.reasons].filter((reason, index, values) => values.findIndex(item => item.code === reason.code) === index) }); setConnections(list.connections); setError(""); } }).catch(e => { if (live) setError(message(e)); }).finally(() => { if (live) setLoading(false); }); return () => { live = false; }; }, [open, owner, path, connector.readiness]);
  async function run(action: () => Promise<void>) { setBusy(true); setError(""); try { await action(); } catch (e) { setError(message(e)); try { await refresh(); } catch { /* Keep the original error available for retry. */ } } finally { setBusy(false); } }
  function update(connection: ProviderConnection) { setConnections(current => current.map(item => item.id === connection.id ? connection : item)); }
  async function authorize(connection: ProviderConnection) {
    const result = await api<{ authorizationUrl: string }>(`${path}/connections/${encodeURIComponent(connection.id)}/authorize`, returnTo ? { returnTo } : {});
    const url = new URL(result.authorizationUrl);
    if (url.protocol !== "https:") throw new Error(`${connector.setup.identityLabel} sign-in is unavailable. Try again later.`);
    window.location.assign(url.href);
  }
  async function create() {
    const operations = [...operationIds].sort(), signature = JSON.stringify({ name: name.trim(), operations });
    if (createAttempt.current?.signature !== signature) createAttempt.current = { signature, operationId: crypto.randomUUID() };
    const result = await api<{ connection: ProviderConnection }>(`${path}/connections`, { name: name.trim(), operations, operationId: createAttempt.current.operationId });
    setConnections(current => [...current.filter(connection => connection.id !== result.connection.id), result.connection]); setSelectedId(result.connection.id);
    await authorize(result.connection);
  }
  async function loadCalendars(connection: ProviderConnection) {
    setSelectedId(connection.id); setCalendars(null); setCalendarId(connection.calendar?.id ?? ""); setTimeZone(connection.calendar?.timeZone ?? ""); setOperationEdit(null);
    const result = await api<{ items: Calendar[] }>(`${path}/connections/${encodeURIComponent(connection.id)}/calendars`); setCalendars(result.items);
  }
  async function loadOperations(connection: ProviderConnection) {
    setCalendars(null);
    const result = await api<{ operations: (ProviderOperation & { selected: boolean })[]; generation: number }>(`${path}/connections/${encodeURIComponent(connection.id)}/operations`);
    setOperationEdit({ connectionId: connection.id, ...result });
  }
  async function saveOperations() {
    if (!operationEdit) return;
    const result = await api<{ connection: ProviderConnection }>(`${path}/connections/${encodeURIComponent(operationEdit.connectionId)}/operations`, { generation: operationEdit.generation, operationIds: operationEdit.operations.filter(operation => operation.selected).map(operation => operation.id) });
    update(result.connection); setOperationEdit(null);
    if (result.connection.status === "authorization_required") await authorize(result.connection);
  }
  async function sharing(connection: ProviderConnection) {
    const next = connection.sharing === "private" ? "organization_service" : "private";
    if (!await confirm({ title: next === "organization_service" ? isCalendar ? "Allow customer calendar access?" : "Allow customer contact intake?" : "Make this connection private?", description: isCalendar ? next === "organization_service" ? "Availability uses the selected policy. Booking also requires customer confirmation." : "Customer calendar access will stop." : next === "organization_service" ? "Customers must confirm their exact contact details before saving. Customer record lookup stays unavailable." : "Customer contact intake will stop.", confirmLabel: next === "organization_service" ? isCalendar ? "Allow access" : "Allow intake" : "Make private" })) return;
    await run(async () => { const result = await api<{ connection: ProviderConnection }>(`${path}/connections/${encodeURIComponent(connection.id)}/sharing`, { generation: connection.generation, sharing: next }); update(result.connection); });
  }
  async function disconnect(connection: ProviderConnection) {
    if (!await confirm({ title: `Disconnect ${connection.name}?`, description: isCalendar ? "Agents will lose access. Existing appointments will remain in the calendar." : "Agents will lose access to this account.", confirmLabel: "Disconnect", variant: "destructive" })) return;
    await run(async () => { await api(`${path}/connections/${encodeURIComponent(connection.id)}/disconnect`, { generation: connection.generation }); await refresh(); setCalendars(null); setOperationEdit(null); });
  }
  const Icon = isCalendar ? CalendarDays : ContactRound;
  return <><div className="connection-entry"><span className="connection-entry-icon">{connector.id.includes("google") ? <img src="/images/integrations/google-calendar.svg" alt="" /> : <Icon size={19} strokeWidth={1.7} aria-hidden="true" />}</span><div className="connection-entry-body"><h2>{connector.name}</h2><p>{connector.description}</p>{!connector.readiness.available ? <p>{connector.readiness.reasons.map(reason => reason.message).join(" ") || "Unavailable"}</p> : null}</div><Button className="connection-entry-actions" aria-label={owner && connector.readiness.available ? "Connect or manage" : undefined} variant="outline" size="sm" disabled={!owner} onClick={() => setOpen(true)}>{owner ? connector.readiness.available ? "Connect" : "View setup" : "Owner only"}</Button></div><Dialog open={open} onOpenChange={value => { if (!busy) { setOpen(value); setCalendars(null); setOperationEdit(null); } }}><DialogContent className="sm:max-w-2xl" showCloseButton={!busy}><DialogHeader><DialogTitle>{connector.name}</DialogTitle><DialogDescription>{isCalendar ? "Choose an account, actions and calendar." : "Choose an account and permitted actions."}</DialogDescription></DialogHeader><ErrorMessage value={error} />{!owner ? <p className="text-sm">An organization owner must manage this connection.</p> : loading || !status && !error ? <Loading /> : <>
    {status && !status.available ? <p className="text-sm text-muted-foreground">{status.reasons.map(reason => reason.message).join(" ") || "Account connection is unavailable. Contact your administrator."}</p> : null}
    {connections.map(connection => <div className="space-y-2 border-b border-border pb-4" key={connection.id}><h3 className="font-medium break-words">{connection.name}</h3><p className="text-sm text-muted-foreground break-words">{connection.account?.email ?? connection.status.replaceAll("_", " ")}{connection.calendar ? ` · ${connection.calendar.name} · ${connection.calendar.timeZone}` : ""}</p><p className="text-xs text-muted-foreground">{connection.sharing === "private" ? "Private" : isCalendar ? "Shared with the calendar service" : "Customer intake allowed"}{isCalendar && connection.customerDeploymentEligible ? " · Calendar access ready for a booking policy" : ""}</p>{connection.readiness.reasons.length ? <p className="text-sm text-muted-foreground">{connection.readiness.reasons.map(reason => reason.message).join(" ")}</p> : null}<details className="text-xs text-muted-foreground"><summary>Connection details</summary><dl className="mt-2 space-y-1 break-words">{connection.authorizationVerifiedAt ? <><dt>Authorization verified</dt><dd>{new Date(connection.authorizationVerifiedAt).toLocaleString()}</dd></> : null}{connection.credentialExpiresAt ? <><dt>Token expires</dt><dd>{new Date(connection.credentialExpiresAt).toLocaleString()}</dd></> : null}{connection.grantedScopes?.length ? <><dt>Granted permissions</dt><dd className="break-all">{connection.grantedScopes.join(", ")}</dd></> : null}</dl></details><div className="flex flex-wrap gap-2"><Button size="sm" variant="outline" disabled={busy || !status?.available} onClick={() => void run(() => authorize(connection))}>Sign in to {connector.setup.identityLabel}</Button><Button size="sm" variant="outline" disabled={busy || !connection.account || !status?.available || connection.status === "disconnected"} onClick={() => void run(() => loadOperations(connection))}>Choose actions</Button>{isCalendar ? <Button size="sm" variant="outline" disabled={busy || !connection.account || !status?.available || connection.status === "disconnected" || connection.status === "authorization_required"} onClick={() => void run(() => loadCalendars(connection))}>Choose calendar</Button> : null}{(isCalendar ? connection.calendar : connection.account) && connection.status !== "disconnected" && (connection.sharing !== "private" || connection.status === "ready" && (isCalendar ? connection.operations?.some(operation => ["calendar.availability", "calendar.book"].includes(operation)) : connection.operations?.includes("contacts.create"))) ? <Button size="sm" variant="outline" disabled={busy} onClick={() => void sharing(connection)}>{connection.sharing === "private" ? isCalendar ? "Allow customer access" : "Allow customer intake" : "Make private"}</Button> : null}{connection.status !== "disconnected" ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void disconnect(connection)}>Disconnect</Button> : null}</div></div>)}
    {selected && calendars ? <form className="space-y-3" onSubmit={event => { event.preventDefault(); void run(async () => { const result = await api<{ connection: ProviderConnection }>(`${path}/connections/${encodeURIComponent(selected.id)}/calendar`, { generation: selected.generation, calendarId, ...(timeZone.trim() ? { timeZone: timeZone.trim() } : {}) }); update(result.connection); setCalendars(null); }); }}><label className="block space-y-2 text-sm">Calendar<select aria-label="Calendar" className="w-full rounded-md border bg-background p-2" required value={calendarId} onChange={event => { setCalendarId(event.target.value); setTimeZone(calendars.find(calendar => calendar.id === event.target.value)?.timeZone ?? ""); }}><option value="">Choose a calendar</option>{calendars.map(calendar => <option key={calendar.id} value={calendar.id}>{calendar.name} · {calendar.timeZone} · {calendar.role}</option>)}</select></label><label className="block space-y-2 text-sm">Booking time zone<Input value={timeZone} placeholder="Europe/London" onChange={event => setTimeZone(event.target.value)} /></label>{!calendars.length ? <p className="text-sm text-muted-foreground">No calendars are available for this account.</p> : null}<Button size="sm" disabled={busy || !calendarId}>Save calendar</Button></form> : null}
    {operationEdit ? <form className="space-y-3" onSubmit={event => { event.preventDefault(); void run(saveOperations); }}><fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">Permitted actions</legend>{operationEdit.operations.map(operation => <label key={operation.id} className="flex gap-2 text-sm"><input className="mt-1" type="checkbox" disabled={busy} checked={operation.selected} onChange={event => setOperationEdit({ ...operationEdit, operations: operationEdit.operations.map(item => item.id === operation.id ? { ...item, selected: event.target.checked } : item) })} /><span>{operation.name}{operation.effect === "reviewed_write" ? <span className="ml-2 text-xs text-muted-foreground">{" "}Confirmation required</span> : null}</span></label>)}</fieldset><Button size="sm" disabled={busy || !operationEdit.operations.some(operation => operation.selected)}>Save actions</Button></form> : null}
    {status?.available ? <form className="space-y-3" onSubmit={event => { event.preventDefault(); void run(create); }}><label className="block space-y-2 text-sm">Connection name<Input required maxLength={120} value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>{connector.operations?.length ? <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">Permitted actions</legend>{connector.operations.map(operation => <label key={operation.id} className="flex gap-2 text-sm"><input type="checkbox" disabled={busy} checked={operationIds.includes(operation.id)} onChange={event => setOperationIds(current => event.target.checked ? [...current, operation.id] : current.filter(id => id !== operation.id))} /><span>{operation.name}{operation.effect === "reviewed_write" ? <span className="ml-2 text-xs text-muted-foreground">{" "}Confirmation required</span> : null}</span></label>)}</fieldset> : null}<Button disabled={busy || !name.trim() || Boolean(connector.operations?.length && !operationIds.length)}>{busy ? "Connecting…" : `Connect ${connector.setup.identityLabel} account`}</Button></form> : null}
    </>}</DialogContent></Dialog></>;
}
