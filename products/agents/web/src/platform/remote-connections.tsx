import { useEffect, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import { PiPlugsConnected as Plug } from "react-icons/pi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useConfirmationDialog } from "@/components/ui/confirmation-provider";
import { api, ApiError, message, type RemoteConnection, type RemoteToolCatalogue, type CatalogCandidate, type CapabilityBinding } from "./api";
import { McpOperationPicker, remoteOperationLabel, remotePickerOperations, templateSelectionsComplete } from "./mcp-operation-picker";
import { ErrorMessage, Loading } from "./shell";

const statusLabel = (value: string) => ({ draft: "Not checked", discovering: "Check tools", authenticating: "Sign in pending", authorization_required: "Authentication required", reconnect_required: "Reconnect required", selection_required: "Tools checked", failed: "Connection failed", unsupported: "Unsupported server", disconnected: "Disconnected" })[value] ?? "Not ready";
function connectionError(connection: RemoteConnection) {
  if (!connection.lastError) return "";
  if (["authorization_required", "reconnect_required"].includes(connection.status)) return "Sign in to continue, or reconnect with the required credentials.";
  if (connection.status === "unsupported") return "This server does not support a compatible MCP connection.";
  return "The server could not be checked. Check its address and availability, then try again.";
}

export function RemoteConnections({ path, createOpen, onCreateOpenChange, query = "" }: { path: string; createOpen: boolean; onCreateOpenChange: (value: boolean) => void; query?: string }) {
  const { confirm } = useConfirmationDialog();
  const [searchParams] = useSearchParams();
  const setupProfile = searchParams.get("profile");
  const setupId = !setupProfile || setupProfile === "remote-mcp-v1" ? searchParams.get("setup") : null;
  const [connections, setConnections] = useState<RemoteConnection[] | null>(null);
  const connectionsPath = path.replace(/\/remote-connections$/, "/connections");
  const bindingsPath = path.replace(/\/remote-connections$/, "/tool-bindings");
  const [candidates, setCandidates] = useState<Record<string, CatalogCandidate>>({});
  const [availableBindings, setAvailableBindings] = useState<Record<string, string[]>>({});
  const [chosenTools, setChosenTools] = useState<string[]>([]);
  const [templateArguments, setTemplateArguments] = useState<Record<string, Record<string, string>>>({});
  const [selectionId, setSelectionId] = useState(crypto.randomUUID());
  const [catalogues, setCatalogues] = useState<Record<string, RemoteToolCatalogue>>({});
  const [selectedId, setSelectedId] = useState<string | null>(setupId);
  const [editingConnection, setEditingConnection] = useState<RemoteConnection | null>(null);
  const submitting = useRef(false);
  const [name, setName] = useState(""), [endpoint, setEndpoint] = useState("");
  const [authentication, setAuthentication] = useState<RemoteConnection["authentication"]>("auto");
  const connectorId=searchParams.get("connector");
  useEffect(()=>{
    if(!connectorId||!createOpen)return;let live=true;
    api<{connectors:{id:string;name:string;profileId:string;connectionDefaults?:{endpoint:string;authentication:RemoteConnection["authentication"]}}[]}>(path.replace(/\/remote-connections$/,"/connectors")).then(result=>{
      const record=result.connectors.find(item=>item.id===connectorId&&item.profileId==="remote-mcp-v1");
      if(live&&record?.connectionDefaults){setName(current=>current||record.name);setEndpoint(current=>current||record.connectionDefaults!.endpoint);setAuthentication(current=>current==="auto"?record.connectionDefaults!.authentication:current);}
    }).catch(error=>{if(live)setFormError(message(error));});return()=>{live=false;};
  },[connectorId,createOpen,path]);
  const [secret, setSecret] = useState(""), [headerName, setHeaderName] = useState("");
  const [oauthClient, setOauthClient] = useState({ issuer: "", clientId: "", clientSecret: "", authMethod: "none" });
  const [operationId, setOperationId] = useState(crypto.randomUUID());
  const [busy, setBusy] = useState(""), [error, setError] = useState(""), [formError, setFormError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    api<{ connections: RemoteConnection[] }>(path).then(result => { if (live) { setConnections(result.connections); } }).catch(e => { if (live) setError(message(e)); });
    return () => { live = false; };
  }, [path, attempt]);
  function replace(connection: RemoteConnection) { setConnections(current => [...(current ?? []).filter(item => item.id !== connection.id), connection]); }
  function closeCreate() { if (!busy) { onCreateOpenChange(false); setEditingConnection(null); setSecret(""); setOauthClient(current => ({ ...current, clientSecret: "" })); setFormError(""); } }
  function inputChanged() { setOperationId(crypto.randomUUID()); setFormError(""); }
  async function discover(connection: RemoteConnection) {
    setBusy(connection.id); setError(""); setSelectedId(connection.id);
    try {
      const result = await api<{ connection: RemoteConnection; catalog?: RemoteToolCatalogue; candidate?: CatalogCandidate }>(`${path}/${encodeURIComponent(connection.id)}/discover`, { generation: connection.generation });
      replace(result.connection); setChosenTools([]); setTemplateArguments({}); setSelectionId(crypto.randomUUID());
      setCandidates(current => { const next = { ...current }; if (result.candidate) next[connection.id] = result.candidate; else delete next[connection.id]; return next; });
      setCatalogues(current => { const next = { ...current }; if (result.catalog) next[connection.id] = result.catalog; else delete next[connection.id]; return next; });
    } catch (e) { setError(message(e)); setAttempt(value => value + 1); }
    finally { setBusy(""); }
  }
  async function openDetails(connection: RemoteConnection) {
    setSelectedId(connection.id); setChosenTools([]); setTemplateArguments({}); setSelectionId(crypto.randomUUID()); setBusy(connection.id); setError("");
    try {
      const [catalogs, result] = await Promise.all([api<{ catalogs: CatalogCandidate[] }>(`${connectionsPath}/${encodeURIComponent(connection.id)}/catalogs`), api<{ bindings: CapabilityBinding[] }>(bindingsPath)]);
      const current = catalogs.catalogs.filter(candidate => candidate.credentialRevision === connection.revision).sort((a, b) => b.catalog.revision - a.catalog.revision)[0];
      const added = [...new Set(result.bindings.filter(binding => binding.connection?.id === connection.id && (!current || binding.connection.policyRevision === current.policyRevision)).map(binding => binding.definition.providerOperation))];
      setAvailableBindings(value => ({ ...value, [connection.id]: added }));
      if (current) { setCandidates(value => ({ ...value, [connection.id]: current })); setCatalogues(value => ({ ...value, [connection.id]: { protocolVersion: current.catalog.protocolVersion ?? "", tools: current.catalog.tools.filter(tool => !tool.remote?.target || tool.remote.target.kind === "tool").map(tool => ({ name: tool.providerOperation, description: tool.description, inputSchema: tool.inputSchema ?? {}, schemaDigest: "" })) } })); }
    } catch (e) { setError(message(e)); } finally { setBusy(""); }
  }
  async function saveTools(connection: RemoteConnection) {
    const candidate = candidates[connection.id]; if (!candidate || !chosenTools.length) return;
    setBusy(connection.id); setError("");
    try {
      await api<{ bindings: CapabilityBinding[] }>(`${connectionsPath}/${encodeURIComponent(connection.id)}/catalogs/${encodeURIComponent(candidate.id)}/select`, { operationId: selectionId, expectedRevision: connection.revision, selections: chosenTools.map(providerOperation => ({ providerOperation, resources: [{ kind: "mcp.endpoint", id: connection.endpoint }], ...(candidate.catalog.tools.find(operation => operation.providerOperation === providerOperation)?.remote?.target?.kind === "template" ? { templateArguments: templateArguments[providerOperation] ?? {} } : {}) })) });
      setAvailableBindings(current => ({ ...current, [connection.id]: [...new Set([...(current[connection.id] ?? []), ...chosenTools])] })); setChosenTools([]); setTemplateArguments({}); setSelectionId(crypto.randomUUID()); setSelectedId(null); toast.success("Tools added");
    } catch (e) { setError(message(e)); } finally { setBusy(""); }
  }
  function reconnect(connection: RemoteConnection) {
    setSelectedId(null); setEditingConnection(connection); setEndpoint(connection.endpoint); setName(connection.name); setAuthentication(connection.authentication); setSecret(""); setHeaderName(""); setOauthClient({ issuer: "", clientId: "", clientSecret: "", authMethod: "none" }); setOperationId(crypto.randomUUID()); setFormError(""); onCreateOpenChange(true);
  }
  async function create(event: FormEvent) {
    event.preventDefault(); if (submitting.current) return; submitting.current = true;
    if (editingConnection && !await confirm({ title: `Reconnect ${editingConnection.name}?`, description: "Published agents will need their tool access reviewed. Existing tool permissions will not carry over.", confirmLabel: "Reconnect" })) { submitting.current = false; return; }
    setBusy("create"); setFormError("");
    let created: RemoteConnection | null = null;
    try {
      const ownClient = ["auto", "oauth"].includes(authentication) && (oauthClient.issuer.trim() || oauthClient.clientId.trim());
      if (ownClient && (!oauthClient.issuer.trim() || !oauthClient.clientId.trim())) throw new Error("Enter both the OAuth issuer and client ID.");
      const result = await api<{ connection: RemoteConnection }>(editingConnection ? `${path}/${encodeURIComponent(editingConnection.id)}/credentials` : path, { operationId, ...(editingConnection ? { generation: editingConnection.generation } : {}), ...(ownClient ? { oauthClient: { issuer: oauthClient.issuer.trim(), clientId: oauthClient.clientId.trim(), authMethod: oauthClient.authMethod, ...(oauthClient.authMethod !== "none" ? { clientSecret: oauthClient.clientSecret } : {}) } } : {}), ...(!editingConnection ? { ...(name.trim() ? { name: name.trim() } : {}), endpoint: endpoint.trim() } : {}), authentication, ...(["bearer", "header"].includes(authentication) ? { secret } : {}), ...(authentication === "header" ? { headerName: headerName.trim() } : {}) });
      created = result.connection; replace(result.connection); setEditingConnection(null); setChosenTools([]);
      setAvailableBindings(current => ({ ...current, [result.connection.id]: [] }));
      setCandidates(current => { const next = { ...current }; delete next[result.connection.id]; return next; });
      setCatalogues(current => { const next = { ...current }; delete next[result.connection.id]; return next; }); setSelectedId(result.connection.id); setSecret(""); setName(""); setEndpoint(""); setAuthentication("auto"); setHeaderName(""); setOauthClient({ issuer: "", clientId: "", clientSecret: "", authMethod: "none" }); setOperationId(crypto.randomUUID()); onCreateOpenChange(false);
    } catch (e) {
      setFormError(message(e));
      if (editingConnection && e instanceof ApiError && e.status === 409) {
        try { const current = await api<{ connection: RemoteConnection }>(`${path}/${encodeURIComponent(editingConnection.id)}`); replace(current.connection); setEditingConnection(current.connection); setOperationId(crypto.randomUUID()); } catch { /* Preserve the original reconnect error. */ }
      }
    } finally { setBusy(""); submitting.current = false; }
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
  const handledSetup = useRef("");
  const openDetailsRef = useRef(openDetails); openDetailsRef.current = openDetails;
  useEffect(() => {
    if (!setupId || handledSetup.current === setupId) return;
    const connection = connections?.find(item => item.id === setupId);
    if (!connection) return;
    handledSetup.current = setupId; void openDetailsRef.current(connection);
  }, [connections, setupId]);
  const selected = connections?.find(connection => connection.id === selectedId);
  const catalog = selected ? catalogues[selected.id] : undefined;
  const candidate = selected ? candidates[selected.id] : undefined;
  const operations = remotePickerOperations(candidate?.catalog.tools ?? [], catalog);
  const templatesComplete = templateSelectionsComplete(operations, chosenTools, templateArguments);
  const needsSecret = authentication === "bearer" || authentication === "header";
  return <section aria-label="Custom MCP connections" className="mt-7 space-y-3">
    {!selected ? <ErrorMessage value={error} /> : null}
    {!connections && !error ? <Loading /> : null}
    {error && !selected ? <Button type="button" size="sm" variant="outline" onClick={() => { setError(""); setAttempt(value => value + 1); }}>Retry MCP connections</Button> : null}
    {connections?.length ? <><h2 className="text-sm font-medium">Custom MCP</h2><div className="management-list">{connections.filter(connection => `${connection.name} ${connection.endpoint}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(connection => <div key={connection.id} className="management-row flex flex-wrap items-start justify-between gap-4"><div className="min-w-0 space-y-1"><h3 className="flex items-center gap-2 text-sm font-medium"><Plug size={16} className="shrink-0" /><span className="min-w-0 break-words">{connection.name}</span></h3><p className="break-all text-xs text-muted-foreground">{connection.endpoint}</p><p className="text-xs text-muted-foreground">{statusLabel(connection.status)}</p>{connection.status === "disconnected" ? <p className="text-xs text-muted-foreground">Provider access may remain active.</p> : null}</div><div className="flex flex-wrap gap-2"><Button type="button" size="sm" variant="outline" disabled={Boolean(busy)} onClick={() => void openDetails(connection)}>Details</Button>{connection.status !== "disconnected" ? <Button type="button" size="sm" variant="ghost" disabled={Boolean(busy)} onClick={() => void disconnect(connection)}>Disconnect</Button> : null}</div></div>)}</div></> : null}
    <Dialog open={createOpen} onOpenChange={value => { if (!value) closeCreate(); }}><DialogContent className="mcp-sheet" showCloseButton={!busy}><DialogHeader className="mcp-sheet-header"><DialogTitle>{editingConnection ? "Reconnect server" : "Connect MCP server"}</DialogTitle><DialogDescription>Enter the server's HTTPS address.</DialogDescription></DialogHeader><form onSubmit={event => void create(event)} className="space-y-4"><label className="block space-y-2 text-sm">Server URL<Input type="url" required autoFocus placeholder="https://example.com/mcp" value={endpoint} disabled={Boolean(busy) || Boolean(editingConnection)} onChange={event => { setEndpoint(event.target.value); inputChanged(); }} /></label><details className="space-y-4 text-sm"><summary className="cursor-pointer text-muted-foreground">Advanced</summary><label className="block space-y-2">Name<Input maxLength={120} value={name} disabled={Boolean(busy) || Boolean(editingConnection)} onChange={event => { setName(event.target.value); inputChanged(); }} /></label><label className="block space-y-2">Authentication<select aria-label="Authentication" value={authentication} disabled={Boolean(busy)} className="w-full rounded-md border border-border bg-background p-2" onChange={event => { setAuthentication(event.target.value as typeof authentication); setSecret(""); setOauthClient(current => ({ ...current, clientSecret: "" })); inputChanged(); }}><option value="auto">Automatic</option><option value="oauth">Sign in with OAuth</option><option value="none">No authentication</option><option value="bearer">Bearer token</option><option value="header">API key header</option></select></label>{authentication === "header" ? <label className="block space-y-2">Header name<Input required value={headerName} disabled={Boolean(busy)} placeholder="X-API-Key" onChange={event => { setHeaderName(event.target.value); inputChanged(); }} /></label> : null}{needsSecret ? <label className="block space-y-2">{authentication === "bearer" ? "Token" : "API key"}<Input type="password" autoComplete="new-password" required maxLength={4096} value={secret} disabled={Boolean(busy)} onChange={event => { setSecret(event.target.value); inputChanged(); }} /></label> : null}{["auto", "oauth"].includes(authentication) ? <details className="space-y-3"><summary className="cursor-pointer text-muted-foreground">OAuth client</summary><label className="block space-y-2">Issuer URL<Input type="url" placeholder="https://identity.example.com" disabled={Boolean(busy)} value={oauthClient.issuer} onChange={event => { setOauthClient(current => ({ ...current, issuer: event.target.value })); inputChanged(); }} /></label><label className="block space-y-2">Client ID<Input disabled={Boolean(busy)} maxLength={2048} value={oauthClient.clientId} onChange={event => { setOauthClient(current => ({ ...current, clientId: event.target.value })); inputChanged(); }} /></label><label className="block space-y-2">Client authentication<select aria-label="Client authentication" disabled={Boolean(busy)} className="w-full rounded-md border border-border bg-background p-2" value={oauthClient.authMethod} onChange={event => { setOauthClient(current => ({ ...current, authMethod: event.target.value, clientSecret: "" })); inputChanged(); }}><option value="none">Public client</option><option value="client_secret_basic">Client secret, basic</option><option value="client_secret_post">Client secret, post</option></select></label>{oauthClient.authMethod !== "none" ? <label className="block space-y-2">Client secret<Input type="password" autoComplete="new-password" required maxLength={4096} disabled={Boolean(busy)} value={oauthClient.clientSecret} onChange={event => { setOauthClient(current => ({ ...current, clientSecret: event.target.value })); inputChanged(); }} /></label> : null}</details> : null}</details><ErrorMessage value={formError} /><div className="flex justify-end gap-2"><Button type="button" variant="ghost" disabled={Boolean(busy)} onClick={closeCreate}>Cancel</Button><Button type="submit" disabled={Boolean(busy) || !endpoint.trim()}>{busy ? "Connecting…" : editingConnection ? "Reconnect" : "Connect"}</Button></div></form></DialogContent></Dialog>
    <Dialog open={Boolean(selected)} onOpenChange={open => { if (!open && !busy) { setSelectedId(null); setError(""); } }}><DialogContent className="sm:max-w-2xl" showCloseButton={!busy}><DialogHeader><DialogTitle className="break-words">{selected?.name ?? "MCP connection"}</DialogTitle><DialogDescription className="break-all">{selected?.endpoint}</DialogDescription></DialogHeader><ErrorMessage value={error} />{selected ? <><p role="status" className="text-sm text-muted-foreground">{busy ? "Checking connection…" : statusLabel(selected.status)}</p>{connectionError(selected) ? <p className="text-sm text-muted-foreground">{connectionError(selected)}</p> : null}{catalog ? <>{availableBindings[selected.id]?.length ? <details className="text-xs text-muted-foreground"><summary className="cursor-pointer">Added tools · {availableBindings[selected.id].length}</summary><ul className="mt-2 space-y-1">{availableBindings[selected.id].map(name => <li key={name}>{candidate?.catalog.tools.find(operation => operation.providerOperation === name) ? remoteOperationLabel(candidate.catalog.tools.find(operation => operation.providerOperation === name)!) : name.replaceAll("_", " ")}</li>)}</ul></details> : null}<McpOperationPicker key={`${selected.id}.${candidate?.id ?? "inventory"}`} operations={operations} selectable={candidate?.selectableOperations ?? []} selected={chosenTools} change={value => { setChosenTools(value); setSelectionId(crypto.randomUUID()); }} templateArguments={templateArguments} changeArguments={value => { setTemplateArguments(value); setSelectionId(crypto.randomUUID()); }} disabled={Boolean(busy)} />{chosenTools.length ? <p className="text-xs text-muted-foreground">Requests require approval of the exact action and data.</p> : null}</> : null}<details className="text-sm"><summary className="cursor-pointer text-muted-foreground">Connection settings</summary><Button type="button" size="sm" variant="outline" className="mt-3" disabled={Boolean(busy)} onClick={() => reconnect(selected)}>Reconnect</Button></details><div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="ghost" disabled={Boolean(busy)} onClick={() => { setSelectedId(null); setError(""); }}>Close</Button>{selected.status !== "disconnected" ? <>{(["auto", "oauth"].includes(selected.authentication) && ["authorization_required", "authenticating"].includes(selected.status)) || selected.authentication === "oauth" && selected.status === "draft" ? <Button type="button" variant="outline" disabled={Boolean(busy)} onClick={() => void authorize(selected)}>Sign in</Button> : null}<Button type="button" disabled={Boolean(busy)} onClick={() => void discover(selected)}>{busy ? "Checking…" : catalog ? "Refresh tools" : "Check tools"}</Button>{candidate && operations.length ? <Button type="button" disabled={Boolean(busy) || !chosenTools.length || !templatesComplete} onClick={() => void saveTools(selected)}>Add tools</Button> : null}</> : null}</div></> : null}</DialogContent></Dialog>
  </section>;
}
