import "./management.css";
import "./connection-catalogue.css";
import { PiMagnifyingGlass as Search } from "react-icons/pi";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Link, useSearchParams } from "react-router-dom";
import { RemoteConnections } from "./remote-connections";
import { ApiConnections } from "./api-connections";
import { CustomerChannels, channelSetupContext } from "./customer-channels";
import { SupportedConnections } from "./supported-connections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { api, hasPermission, message, organizationPath, type CapabilityBinding, type CatalogCandidate, type Connection, type ConnectionList, type ConnectionProfile, type ResourceHandle } from "./api";
import { localDateTime } from "./time";
import { ErrorMessage, Loading, useWorkspace } from "./shell";

type ConnectionDialog = { kind: "create" | "rotate" | "revoke"; connection?: Connection; operationId: string };
const repositoryProfile = (profile?: ConnectionProfile["id"]) => profile === "github-public-read-v1" || profile === "public-repository-read-v1";
const operationLabel = (value: string) => value.replaceAll("_", " ").replace(/^./, letter => letter.toUpperCase());
export function ConnectionsPage() {
  const { organizationId, session } = useWorkspace(), path = `${organizationPath(organizationId)}/connections`;
  const [rawSearchParams, setSearchParams] = useSearchParams();
  const searchParams = channelSetupContext(organizationId, rawSearchParams);
  useEffect(() => {
    if (searchParams.toString() !== rawSearchParams.toString()) setSearchParams(searchParams, { replace: true });
  }, [searchParams, rawSearchParams, setSearchParams]);
  const requestedProfile = searchParams.get("profile");
  const requestedReturn = searchParams.get("returnTo");
  const returnTo = requestedReturn?.startsWith("/app/agents/") && !/[\\\x00-\x1f\x7f]/.test(requestedReturn) ? requestedReturn : null;
  const [apiOpen, setApiOpen] = useState(requestedProfile === "custom-api" || requestedProfile === "custom-api-v1" && !searchParams.get("setup"));
  const [remoteOpen, setRemoteOpen] = useState(requestedProfile === "custom-mcp" || requestedProfile === "remote-mcp-v1" && !searchParams.get("setup"));
  const handledProfile = useRef("");
  const [data, setData] = useState<ConnectionList | null>(null), [dialog, setDialog] = useState<ConnectionDialog | null>(null);
  const [tools, setTools] = useState<Connection | null>(null), [profileId, setProfileId] = useState<ConnectionProfile["id"]>("github-public-read-v1");
  const [name, setName] = useState(""), [targetId, setTargetId] = useState(""), [apiKey, setApiKey] = useState("");
  const [repositories, setRepositories] = useState([{ name: "", ref: "main" }]), [expiresAt, setExpiresAt] = useState("");
  const [stashItemIds, setStashItemIds] = useState([""]);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [view, setView] = useState<"all" | "channels" | "tools">("all");
  async function refresh() { setData(await api<ConnectionList>(path)); }
  useEffect(() => { let live = true; api<ConnectionList>(path).then(result => { if (live) setData(result); }).catch(e => { if (live) setError(message(e)); }); return () => { live = false; }; }, [path]);
  const profiles = (data?.profiles ?? [{ id: "report-delivery-v1" as const, label: "Report delivery", allowedTransports: ["builtin"] }]).filter(profile => ["report-delivery-v1", "github-public-read-v1", "stash-read-v1", "public-repository-read-v1"].includes(profile.id));
  function open(kind: ConnectionDialog["kind"], connection?: Connection) {
    setError(""); setName(""); setTargetId(data?.targets[0]?.id ?? ""); setApiKey(""); setRepositories([{ name: "", ref: "main" }]); setStashItemIds([""]);
    setProfileId(connection?.profileId ?? profiles.find(profile => profile.id === "github-public-read-v1")?.id ?? profiles[0]?.id ?? "report-delivery-v1");
    setExpiresAt(localDateTime(connection && new Date(connection.expiresAt).getTime() > Date.now() ? connection.expiresAt : new Date(Date.now() + 30 * 86_400_000).toISOString()));
    setDialog({ kind, connection, operationId: crypto.randomUUID() });
  }
  function close() { if (!busy) { setDialog(null); setApiKey(""); setError(""); } }
  useEffect(() => {
    if (!data || !requestedProfile || requestedProfile === handledProfile.current) return;
    if (!profiles.some(profile => profile.id === requestedProfile)) return;
    handledProfile.current = requestedProfile;
    setName(""); setTargetId(data.targets[0]?.id ?? ""); setApiKey("");
    setProfileId(requestedProfile as ConnectionProfile["id"]);
    setExpiresAt(localDateTime(new Date(Date.now() + 30 * 86_400_000).toISOString()));
    setDialog({ kind: "create", operationId: crypto.randomUUID() });
  }, [data, requestedProfile, profiles]);
  const github = dialog?.kind === "create" ? profileId === "github-public-read-v1" : dialog?.connection?.profileId === "github-public-read-v1";
  const stash = dialog?.kind === "create" ? profileId === "stash-read-v1" : dialog?.connection?.profileId === "stash-read-v1";
  const publicRepository = dialog?.kind === "create" ? profileId === "public-repository-read-v1" : dialog?.connection?.profileId === "public-repository-read-v1";
  async function save(event: FormEvent) {
    event.preventDefault(); if (!dialog) return; setBusy(true); setError("");
    try {
      if (dialog.kind === "create") {
        const selections = repositoryProfile(profileId) ? repositories.map(repository => {
          const parts = repository.name.trim().split("/");
          if (parts.length !== 2 || !parts[0] || !parts[1] || !repository.ref.trim()) throw new Error("Enter each repository as owner/name and choose its branch or tag.");
          return { owner: parts[0], repository: parts[1], ref: repository.ref.trim() };
        }) : [];
        const itemIds = stash ? stashItemIds.map(id => id.trim().toLowerCase()) : [];
        if (stash && (itemIds.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) || new Set(itemIds).size !== itemIds.length)) throw new Error("Enter distinct, valid item IDs.");
        await api(path, { operationId: dialog.operationId, name, profileId, targetId: publicRepository ? "provider:public-repository" : github ? "provider:github" : stash ? "provider:stash" : targetId, selections, ...(stash ? { stashItemIds: itemIds } : {}), ...(publicRepository ? {} : { apiKey }), expiresAt: new Date(expiresAt).toISOString() });
      } else if (dialog.connection) await api(`${path}/${encodeURIComponent(dialog.connection.id)}/${dialog.kind}`, { operationId: dialog.operationId, expectedRevision: dialog.connection.revision, ...(dialog.kind === "rotate" ? { apiKey, expiresAt: new Date(expiresAt).toISOString() } : {}) });
      setApiKey(""); await refresh(); setDialog(null); toast.success(dialog.kind === "create" ? "Connection added" : dialog.kind === "rotate" ? "Key replaced" : "Connection revoked");
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <section className="management-page"><div className="management-header"><h1>Connections</h1><div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => { setView("tools"); setApiOpen(true); }}>Custom API</Button><Button onClick={() => { setView("tools"); setRemoteOpen(true); }}>Add custom MCP</Button><Button variant="outline" onClick={() => open("create")} disabled={!data || !profiles.length}>Add connection</Button></div></div>{returnTo ? <Link className="mb-5 inline-block text-sm underline underline-offset-4" to={returnTo}>Back to agent</Link> : null}{!dialog ? <ErrorMessage value={error} /> : null}
    <div className="connection-toolbar"><label className="connection-search"><Search size={16} aria-hidden="true"/><Input aria-label="Search connections" placeholder="Search connections" value={query} onChange={event => setQuery(event.target.value)} /></label></div>
    <nav className="connection-views" aria-label="Connection types">{(["all", "channels", "tools"] as const).map(value => <button type="button" key={value} aria-current={view === value ? "page" : undefined} onClick={() => setView(value)}>{value === "all" ? "All" : value === "channels" ? "Channels" : "Tools"}</button>)}</nav>
    {view !== "tools" ? <CustomerChannels query={query} defaultAgentId={searchParams.get("agentId") ?? undefined} organizationId={organizationId} owner={hasPermission(session.organizations.find(organization => organization.id === organizationId), "channels.manage")} /> : null}
    {view !== "channels" ? <><h2 className="connection-section-title">Business tools</h2>
    <SupportedConnections query={query} organizationPath={organizationPath(organizationId)} owner={hasPermission(session.organizations.find(organization => organization.id === organizationId), "credentials.manage")} />
    {data?.connections.length ? <h3 className="connection-section-title mt-6">Existing connections</h3> : null}
    {!data && !error ? <Loading /> : data?.connections.length ? <div className="management-list">{data.connections.filter(connection => `${connection.name} ${connection.targetLabel}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())).map(connection => {
      const expired = new Date(connection.expiresAt).getTime() <= Date.now();
      return <div key={connection.id} className="management-row flex flex-wrap items-start justify-between gap-4"><div className="min-w-0 space-y-1"><h2 className="break-words font-medium">{connection.name}</h2><p className="break-words text-sm text-muted-foreground">{connection.targetLabel}{repositoryProfile(connection.profileId) ? ` · ${connection.selections?.length ?? 0} ${(connection.selections?.length ?? 0) === 1 ? "repository" : "repositories"}` : connection.profileId === "stash-read-v1" ? ` · ${connection.stashItemIds?.length ?? 0} ${(connection.stashItemIds?.length ?? 0) === 1 ? "item" : "items"}` : ` · ${connection.resource}`}</p>{connection.selections?.length ? <p className="max-w-xl break-words text-xs text-muted-foreground">{connection.selections.map(selection => `${selection.owner}/${selection.repository}`).join(", ")}</p> : null}<p className="text-xs text-muted-foreground">{connection.state === "revoked" ? "Revoked" : expired ? "Expired" : `Expires ${new Date(connection.expiresAt).toLocaleString()}`}</p></div>{connection.state === "active" ? <div className="flex flex-wrap gap-2">{(repositoryProfile(connection.profileId) || connection.profileId === "stash-read-v1") && !expired ? <Button size="sm" variant="outline" onClick={() => setTools(connection)}>Manage tools</Button> : null}{connection.profileId !== "public-repository-read-v1" && connection.authentication !== "none" ? <Button size="sm" variant="outline" onClick={() => open("rotate", connection)}>Replace key</Button> : null}<Button size="sm" variant="ghost" onClick={() => open("revoke", connection)}>Revoke</Button></div> : null}</div>;
    })}</div> : null}
    <ApiConnections query={query} path={`${organizationPath(organizationId)}/api-connections`} createOpen={apiOpen} onCreateOpenChange={setApiOpen} setupId={requestedProfile === "custom-api-v1" ? searchParams.get("setup") : null} />
    <RemoteConnections query={query} path={`${organizationPath(organizationId)}/remote-connections`} createOpen={remoteOpen} onCreateOpenChange={setRemoteOpen} /></> : null}
    <Dialog open={Boolean(dialog)} onOpenChange={value => { if (!value) close(); }}><DialogContent showCloseButton={!busy}><DialogHeader><DialogTitle>{dialog?.kind === "create" ? "Add connection" : dialog?.kind === "rotate" ? "Replace key" : "Revoke connection"}</DialogTitle><DialogDescription>{dialog?.kind === "revoke" ? "Future use will be blocked. A delivery already claimed may still finish." : dialog?.kind === "rotate" ? stash ? "The approved items stay the same." : "The approved resources stay the same. Pending report reviews will need a new review." : publicRepository ? "Read only the approved public repositories." : stash ? "Read only the approved Stash items." : github ? "Use a fine-grained token limited to public repositories." : "Choose an approved destination."}</DialogDescription></DialogHeader><form onSubmit={event => void save(event)} className="space-y-4"><ErrorMessage value={error} />
      {dialog?.kind === "create" ? <><label className="block space-y-2 text-sm">Name<Input required maxLength={120} value={name} onChange={event => setName(event.target.value)} autoFocus /></label><label className="block space-y-2 text-sm">Provider<select aria-label="Provider" required className="w-full min-w-0 rounded-md border border-border bg-background p-2" value={profileId} onChange={event => { setProfileId(event.target.value as typeof profileId); setApiKey(""); setError(""); }}>{profiles.filter(profile => profile.id !== "report-delivery-v1" || data?.targets.length).map(profile => <option key={profile.id} value={profile.id}>{profile.label}</option>)}</select></label>{repositoryProfile(profileId) ? <fieldset className="space-y-3"><legend className="mb-2 text-sm font-medium">Approved repositories</legend>{repositories.map((repository, index) => <div key={index} className="flex min-w-0 flex-wrap items-end gap-2"><label className="min-w-0 flex-1 space-y-1 text-sm">Repository<Input aria-label={`Repository ${index + 1}`} required placeholder="owner/repository" value={repository.name} onChange={event => setRepositories(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item))} /></label><label className="w-28 shrink-0 space-y-1 text-sm">Branch or tag<Input aria-label={`Branch or tag ${index + 1}`} required maxLength={256} value={repository.ref} onChange={event => setRepositories(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, ref: event.target.value } : item))} /></label>{repositories.length > 1 ? <Button type="button" variant="ghost" size="sm" aria-label={`Remove repository ${index + 1}`} onClick={() => setRepositories(current => current.filter((_, itemIndex) => itemIndex !== index))}>×</Button> : null}</div>)}{repositories.length < 20 ? <Button size="sm" variant="outline" type="button" onClick={() => setRepositories(current => [...current, { name: "", ref: "main" }])}>Add repository</Button> : null}</fieldset> : stash ? <fieldset className="space-y-3"><legend className="mb-2 text-sm font-medium">Approved items</legend>{stashItemIds.map((id, index) => <div key={index} className="flex min-w-0 flex-wrap items-end gap-2"><label className="min-w-0 flex-1 space-y-1 text-sm">Item ID<Input aria-label={`Item ID ${index + 1}`} required maxLength={36} placeholder="00000000-0000-0000-0000-000000000000" value={id} onChange={event => { setStashItemIds(current => current.map((item, itemIndex) => itemIndex === index ? event.target.value : item)); setError(""); }} /></label>{stashItemIds.length > 1 ? <Button type="button" variant="ghost" size="sm" aria-label={`Remove item ${index + 1}`} onClick={() => setStashItemIds(current => current.filter((_, itemIndex) => itemIndex !== index))}>×</Button> : null}</div>)}{stashItemIds.length < 20 ? <Button size="sm" variant="outline" type="button" onClick={() => setStashItemIds(current => [...current, ""])}>Add item</Button> : null}</fieldset> : <label className="block space-y-2 text-sm">Destination<select required className="w-full min-w-0 rounded-md border border-border bg-background p-2" value={targetId} onChange={event => setTargetId(event.target.value)}>{data?.targets.map(target => <option key={target.id} value={target.id}>{target.label}</option>)}</select></label>}</> : <p className="break-words text-sm">{dialog?.connection?.name}</p>}
      {dialog?.kind !== "revoke" ? <>{!publicRepository ? <label className="block space-y-2 text-sm">{github ? "GitHub token" : "API key"}<Input type="password" autoComplete="new-password" minLength={16} maxLength={4096} required value={apiKey} onChange={event => setApiKey(event.target.value)} /></label> : null}<label className="block space-y-2 text-sm">{stash || publicRepository ? "Connection expires at" : "Expires at"}<Input type="datetime-local" required value={expiresAt} max={localDateTime(new Date(Date.now() + 90 * 86_400_000).toISOString())} onChange={event => setExpiresAt(event.target.value)} /></label></> : null}<div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" disabled={busy} onClick={close}>Cancel</Button><Button disabled={busy} type="submit" variant={dialog?.kind === "revoke" ? "destructive" : "default"}>{busy ? "Saving…" : dialog?.kind === "create" ? "Add connection" : dialog?.kind === "rotate" ? "Replace key" : "Revoke connection"}</Button></div></form></DialogContent></Dialog>
    {tools ? <ToolSelectionDialog connection={tools} path={path} bindingsPath={`${organizationPath(organizationId)}/tool-bindings`} close={() => setTools(null)} /> : null}
  </section>;
}

function ToolSelectionDialog({ connection, path, bindingsPath, close }: { connection: Connection; path: string; bindingsPath: string; close: () => void }) {
  const [catalogs, setCatalogs] = useState<CatalogCandidate[] | null>(null), [bindings, setBindings] = useState<CapabilityBinding[]>([]);
  const [transport, setTransport] = useState<"native_http" | "mcp_http">(connection.profileId === "stash-read-v1" ? "mcp_http" : "native_http"), [selected, setSelected] = useState<string[]>([]);
  const [resources, setResources] = useState<ResourceHandle[]>(connection.resources ?? []), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    Promise.all([api<{ catalogs: CatalogCandidate[] }>(`${path}/${connection.id}/catalogs`), api<{ bindings: CapabilityBinding[] }>(bindingsPath)]).then(([a, b]) => { if (live) { setCatalogs(a.catalogs); setBindings(b.bindings.filter(binding => binding.connection?.id === connection.id)); } }).catch(e => { if (live) setError(message(e)); });
    return () => { live = false; };
  }, [path, connection.id, bindingsPath]);
  const catalog = catalogs?.filter(candidate => candidate.catalog.transport === transport && candidate.credentialRevision === connection.revision && candidate.policyRevision === connection.policyRevision).sort((a, b) => b.catalog.revision - a.catalog.revision)[0];
  async function discover() {
    setBusy(true); setError("");
    try { const result = await api<{ catalog: CatalogCandidate }>(`${path}/${connection.id}/catalogs/discover`, { operationId: crypto.randomUUID(), expectedRevision: connection.revision, transport }); setCatalogs(current => [result.catalog, ...current ?? []]); setSelected([]); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!catalog) return; setBusy(true); setError("");
    try { await api(`${path}/${connection.id}/catalogs/${catalog.id}/select`, { operationId: crypto.randomUUID(), expectedRevision: connection.revision, selections: selected.map(providerOperation => ({ providerOperation, resources })) }); toast.success("Tools available for agents"); close(); }
    catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) close(); }}><DialogContent className="sm:max-w-2xl" showCloseButton={!busy}><DialogHeader><DialogTitle>{connection.name}</DialogTitle><DialogDescription>{connection.profileId === "stash-read-v1" ? "Select read tools and approved items." : "Select read tools and approved repositories."}</DialogDescription></DialogHeader><ErrorMessage value={error} />
    {!catalogs && !error ? <Loading /> : <form className="space-y-5" onSubmit={event => void save(event)}><div className="flex flex-wrap items-end gap-3"><label className="min-w-0 flex-1 space-y-2 text-sm">Tool source<select aria-label="Tool source" className="w-full min-w-0 rounded-md border border-border bg-background p-2" value={transport} disabled={busy} onChange={event => { setTransport(event.target.value as typeof transport); setSelected([]); }}>{connection.profileId === "stash-read-v1" ? <option value="mcp_http">Stash MCP</option> : <><option value="native_http">{connection.profileId === "public-repository-read-v1" ? "Public API" : "GitHub API"}</option><option value="mcp_http">{connection.profileId === "public-repository-read-v1" ? "DeepWiki MCP" : "GitHub MCP"}</option></>}</select></label><Button variant="outline" type="button" disabled={busy} onClick={() => void discover()}>{busy ? "Working…" : catalog ? "Refresh tools" : "Find tools"}</Button></div>
      {bindings.length ? <details className="text-sm"><summary className="cursor-pointer text-muted-foreground">Available for agents · {bindings.length}</summary><ul className="mt-2 list-inside list-disc space-y-1">{bindings.map(binding => <li key={binding.id}>{operationLabel(binding.definition.providerOperation)}</li>)}</ul></details> : null}
      {catalog ? <><fieldset className="space-y-3"><legend className="mb-2 text-sm font-medium">{connection.profileId === "stash-read-v1" ? "Items" : "Repositories"}</legend>{connection.resources?.map(resource => <label key={`${resource.kind}:${resource.id}`} className="flex min-w-0 items-start gap-3 text-sm"><input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-primary" checked={resources.some(item => item.kind === resource.kind && item.id === resource.id)} onChange={event => setResources(current => event.target.checked ? [...current, resource] : current.filter(item => item.kind !== resource.kind || item.id !== resource.id))} /><span className="min-w-0 break-words">{resource.id}</span></label>)}</fieldset><fieldset className="space-y-3"><legend className="mb-2 text-sm font-medium">Tools <span className="font-normal text-muted-foreground">{selected.length}/8</span></legend>{catalog.catalog.tools.filter(tool => catalog.selectableOperations.includes(tool.providerOperation)).map(tool => <label key={tool.providerOperation} className="flex min-w-0 items-start gap-3 text-sm"><input type="checkbox" className="mt-0.5 size-4 shrink-0 accent-primary" checked={selected.includes(tool.providerOperation)} disabled={!selected.includes(tool.providerOperation) && selected.length >= 8} onChange={event => setSelected(current => event.target.checked ? [...current, tool.providerOperation] : current.filter(name => name !== tool.providerOperation))} /><span className="min-w-0"><span className="font-medium">{operationLabel(tool.providerOperation)}</span>{tool.description ? <span className="mt-1 line-clamp-2 block break-words text-xs text-muted-foreground">{tool.description}</span> : null}</span></label>)}{!catalog.selectableOperations.length ? <p className="text-sm text-muted-foreground">No supported read tools</p> : null}</fieldset></> : <p className="text-sm text-muted-foreground">Find tools to choose what agents can use.</p>}
      <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" disabled={busy} onClick={close}>Close</Button><Button type="submit" disabled={busy || !catalog || !selected.length || !resources.length}>{busy ? "Saving…" : "Save tools"}</Button></div></form>}
  </DialogContent></Dialog>;
}
