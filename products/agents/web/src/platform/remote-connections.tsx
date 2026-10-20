import { useEffect, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useConfirmationDialog } from "@/components/ui/confirmation-provider";
import { api, message, type RemoteConnection, type RemoteToolCatalogue } from "./api";
import { ErrorMessage, Loading } from "./shell";

const statusLabel = (value: string) => ({ draft: "Not checked", discovering: "Check tools", authenticating: "Sign in pending", authorization_required: "Authentication required", selection_required: "Tools checked", failed: "Connection failed", unsupported: "Unsupported server", disconnected: "Disconnected" })[value] ?? "Not ready";
function connectionError(connection: RemoteConnection) {
  if (!connection.lastError) return "";
  if (connection.status === "authorization_required") return "Sign in to continue, or reconnect with the required credentials.";
  if (connection.status === "unsupported") return "This server does not support a compatible MCP connection.";
  return "The server could not be checked. Check its address and availability, then try again.";
}

export function RemoteConnections({ path, createOpen, onCreateOpenChange }: { path: string; createOpen: boolean; onCreateOpenChange: (value: boolean) => void }) {
  const { confirm } = useConfirmationDialog();
  const [searchParams] = useSearchParams();
  const setupId = searchParams.get("setup");
  const [connections, setConnections] = useState<RemoteConnection[] | null>(null);
  const [catalogues, setCatalogues] = useState<Record<string, RemoteToolCatalogue>>({});
  const [selectedId, setSelectedId] = useState<string | null>(setupId);
  const [name, setName] = useState(""), [endpoint, setEndpoint] = useState("");
  const [authentication, setAuthentication] = useState<RemoteConnection["authentication"]>("auto");
  const [secret, setSecret] = useState(""), [headerName, setHeaderName] = useState("");
  const [operationId, setOperationId] = useState(crypto.randomUUID());
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [formError, setFormError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    api<{ connections: RemoteConnection[] }>(path).then(result => { if (live) { setConnections(result.connections); } }).catch(e => { if (live) setError(message(e)); });
    return () => { live = false; };
  }, [path, attempt]);
  function replace(connection: RemoteConnection) { setConnections(current => [...(current ?? []).filter(item => item.id !== connection.id), connection]); }
  function closeCreate() { if (!busy) { onCreateOpenChange(false); setSecret(""); setFormError(""); } }
  function inputChanged() { setOperationId(crypto.randomUUID()); setFormError(""); }
  async function discover(connection: RemoteConnection) {
    setBusy(connection.id); setError(""); setSelectedId(connection.id);
    try {
      const result = await api<{ connection: RemoteConnection; catalog?: RemoteToolCatalogue }>(`${path}/${encodeURIComponent(connection.id)}/discover`, { generation: connection.generation });
      replace(result.connection); setCatalogues(current => { const next = { ...current }; if (result.catalog) next[connection.id] = result.catalog; else delete next[connection.id]; return next; });
    } catch (e) { setError(message(e)); setAttempt(value => value + 1); }
    finally { setBusy(""); }
  }
  async function create(event: FormEvent) {
    event.preventDefault(); setBusy("create"); setFormError("");
    let created: RemoteConnection | null = null;
    try {
      const result = await api<{ connection: RemoteConnection }>(path, { operationId, ...(name.trim() ? { name: name.trim() } : {}), endpoint: endpoint.trim(), authentication, ...(["bearer", "header"].includes(authentication) ? { secret } : {}), ...(authentication === "header" ? { headerName: headerName.trim() } : {}) });
      created = result.connection; replace(result.connection); setSelectedId(result.connection.id); setSecret(""); setName(""); setEndpoint(""); setAuthentication("auto"); setHeaderName(""); setOperationId(crypto.randomUUID()); onCreateOpenChange(false);
    } catch (e) { setFormError(message(e)); }
    finally { setBusy(""); }
    if (created) await discover(created);
  }
  async function authorize(connection: RemoteConnection) {
    setBusy(connection.id); setError("");
    try {
      const result = await api<{ connection: RemoteConnection; authorizationUrl: string }>(`${path}/${encodeURIComponent(connection.id)}/authorize`, { generation: connection.generation });
      const url = new URL(result.authorizationUrl);
      if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) throw new Error("The server returned an invalid sign-in address.");
      replace(result.connection); window.location.assign(url.href);
    } catch (e) { setError(message(e)); setBusy(""); }
  }
  async function disconnect(connection: RemoteConnection) {
    if (!await confirm({ title: `Disconnect ${connection.name}?`, description: "Agents will lose local access. Provider access may remain active.", confirmLabel: "Disconnect", variant: "destructive" })) return;
    setBusy(connection.id); setError("");
    try { await api(`${path}/${encodeURIComponent(connection.id)}/disconnect`, { generation: connection.generation }); replace({ ...connection, status: "disconnected", generation: connection.generation + 1 }); setCatalogues(current => { const next = { ...current }; delete next[connection.id]; return next; }); toast.success("Disconnected"); }
    catch (e) { setError(message(e)); } finally { setBusy(""); }
  }
  const selected = connections?.find(connection => connection.id === selectedId);
  const catalog = selected ? catalogues[selected.id] : undefined;
  const needsSecret = authentication === "bearer" || authentication === "header";
  return <section aria-label="Custom MCP connections" className="mt-7 space-y-3">
    {!selected ? <ErrorMessage value={error} /> : null}
    {!connections && !error ? <Loading /> : null}
    {error && !selected ? <Button type="button" size="sm" variant="outline" onClick={() => { setError(""); setAttempt(value => value + 1); }}>Retry MCP connections</Button> : null}
    {connections?.length ? <><h2 className="text-sm font-medium">Custom MCP</h2><div className="management-list">{connections.map(connection => <div key={connection.id} className="management-row flex flex-wrap items-start justify-between gap-4"><div className="min-w-0 space-y-1"><h3 className="flex items-center gap-2 text-sm font-medium"><Plug size={16} className="shrink-0" /><span className="min-w-0 break-words">{connection.name}</span></h3><p className="break-all text-xs text-muted-foreground">{connection.endpoint}</p><p className="text-xs text-muted-foreground">{statusLabel(connection.status)}</p>{connection.status === "disconnected" ? <p className="text-xs text-muted-foreground">Provider access may remain active.</p> : null}</div><div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => { setSelectedId(connection.id); setError(""); }}>Details</Button>{connection.status !== "disconnected" ? <Button type="button" size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => void disconnect(connection)}>Disconnect</Button> : null}</div></div>)}</div></> : null}
    <Dialog open={createOpen} onOpenChange={value => { if (!value) closeCreate(); }}><DialogContent showCloseButton={!busy}><DialogHeader><DialogTitle>Connect MCP server</DialogTitle><DialogDescription>Enter the server's HTTPS address.</DialogDescription></DialogHeader><form onSubmit={event => void create(event)} className="space-y-4"><label className="block space-y-2 text-sm">Server URL<Input type="url" required autoFocus placeholder="https://example.com/mcp" value={endpoint} disabled={Boolean(busy)} onChange={event => { setEndpoint(event.target.value); inputChanged(); }} /></label><details className="space-y-4 text-sm"><summary className="cursor-pointer text-muted-foreground">Advanced</summary><label className="block space-y-2">Name<Input maxLength={120} value={name} disabled={Boolean(busy)} onChange={event => { setName(event.target.value); inputChanged(); }} /></label><label className="block space-y-2">Authentication<select aria-label="Authentication" value={authentication} disabled={Boolean(busy)} className="w-full rounded-md border border-border bg-background p-2" onChange={event => { setAuthentication(event.target.value as typeof authentication); setSecret(""); inputChanged(); }}><option value="auto">Automatic</option><option value="oauth">Sign in with OAuth</option><option value="none">No authentication</option><option value="bearer">Bearer token</option><option value="header">API key header</option></select></label>{authentication === "header" ? <label className="block space-y-2">Header name<Input required value={headerName} disabled={Boolean(busy)} placeholder="X-API-Key" onChange={event => { setHeaderName(event.target.value); inputChanged(); }} /></label> : null}{needsSecret ? <label className="block space-y-2">{authentication === "bearer" ? "Token" : "API key"}<Input type="password" autoComplete="new-password" required maxLength={4096} value={secret} disabled={Boolean(busy)} onChange={event => { setSecret(event.target.value); inputChanged(); }} /></label> : null}</details><ErrorMessage value={formError} /><div className="flex justify-end gap-2"><Button type="button" variant="ghost" disabled={Boolean(busy)} onClick={closeCreate}>Cancel</Button><Button type="submit" disabled={Boolean(busy) || !endpoint.trim()}>{busy ? "Connecting…" : "Connect"}</Button></div></form></DialogContent></Dialog>
    <Dialog open={Boolean(selected)} onOpenChange={open => { if (!open && !busy) { setSelectedId(null); setError(""); } }}><DialogContent className="sm:max-w-2xl" showCloseButton={!busy}><DialogHeader><DialogTitle className="break-words">{selected?.name ?? "MCP connection"}</DialogTitle><DialogDescription className="break-all">{selected?.endpoint}</DialogDescription></DialogHeader><ErrorMessage value={error} />{selected ? <><p role="status" className="text-sm text-muted-foreground">{busy ? "Checking connection…" : statusLabel(selected.status)}</p>{connectionError(selected) ? <p className="text-sm text-muted-foreground">{connectionError(selected)}</p> : null}{catalog ? <><h3 className="text-sm font-medium">Tools · {catalog.tools.length}</h3>{catalog.tools.length ? <div className="max-h-72 divide-y divide-border overflow-y-auto">{catalog.tools.map(tool => <article key={tool.name} className="min-w-0 py-3"><h4 className="break-words text-sm font-medium">{tool.name.replaceAll("_", " ")}</h4><p className="mt-1 break-words text-sm text-muted-foreground">{tool.description}</p></article>)}</div> : <p className="text-sm text-muted-foreground">This server returned no tools.</p>}<p className="text-xs text-muted-foreground">Tool selection for agents is not available for custom servers yet.</p></> : null}<div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="ghost" disabled={Boolean(busy)} onClick={() => { setSelectedId(null); setError(""); }}>Close</Button>{selected.status !== "disconnected" ? <>{(["auto", "oauth"].includes(selected.authentication) && ["authorization_required", "authenticating"].includes(selected.status)) || selected.authentication === "oauth" && selected.status === "draft" ? <Button type="button" variant="outline" disabled={Boolean(busy)} onClick={() => void authorize(selected)}>Sign in</Button> : null}<Button type="button" disabled={Boolean(busy)} onClick={() => void discover(selected)}>{busy ? "Checking…" : catalog ? "Refresh tools" : "Check tools"}</Button></> : null}</div></> : null}</DialogContent></Dialog>
  </section>;
}
