import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Plus, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useConfirmationDialog } from "@/components/ui/confirmation-provider";
import { ApiError } from "./api";
import { providerApi, providerError, type ModelProvider, type ModelProviderConnection, type ProviderModels, type CachedProviderModels, type DefaultModel, type ModelProbe, type ProviderModel, type ProviderDependencies } from "./model-provider-api";

const statusLabels = { saved: "Key saved", discovered: "Models listed", inference_verified: "Model tested", tools_verified: "Tools tested" };
function InlineError({ value }: { value: string }) { return value ? <p role="alert" className="text-sm text-destructive">{value}</p> : null; }

export function ModelProvidersSettings({ organizationId, owner }: { organizationId: string; owner: boolean }) {
  const [providers, setProviders] = useState<ModelProvider[]>([]), [connections, setConnections] = useState<ModelProviderConnection[]>([]);
  const [defaultModel, setDefaultModel] = useState<DefaultModel | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(""), [busy] = useState(false);
  const [editor, setEditor] = useState<ModelProviderConnection | "new" | null>(null), [viewing, setViewing] = useState<ModelProviderConnection | null>(null);
  const [dependencies, setDependencies] = useState<{ connection: ModelProviderConnection; action?: "remove" | "revoke" } | null>(null);
  async function reload() {
    setLoading(true); setError("");
    try {
      const [catalogue, list, selection] = await Promise.all([providerApi<{ providers: ModelProvider[] }>(organizationId, "/catalogue"), providerApi<{ connections: ModelProviderConnection[] }>(organizationId), providerApi<DefaultModel>(organizationId, "/default")]);
      setProviders(catalogue.providers); setConnections(list.connections.filter(item => item.state !== "removed")); setDefaultModel(selection);
    } catch (cause) { setError(providerError(cause)); } finally { setLoading(false); }
  }
  useEffect(() => { if (owner) void reload(); else setLoading(false); }, [organizationId, owner]); // eslint-disable-line react-hooks/exhaustive-deps
  return <section className="settings-group" aria-labelledby="settings-model-providers">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="settings-model-providers">Model providers</h2>{owner && <Button size="sm" variant="outline" disabled={loading || busy} onClick={() => setEditor("new")}><Plus className="size-4" />Add provider</Button>}</div>
    {!owner ? <p className="text-sm text-muted-foreground">Workspace owner access required.</p> : <div className="space-y-4">
      <InlineError value={error} />{error && <Button size="sm" variant="outline" onClick={() => void reload()}>Reload</Button>}
      {loading ? <div className="space-y-3" aria-label="Loading model providers"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div> : <>
        <p className="text-sm text-muted-foreground">Default model: <span className="break-all text-foreground">{defaultModel?.selection ? `${connections.find(item => item.id === defaultModel.selection?.connectionId)?.name ?? "Unavailable connection"} / ${defaultModel.selection.modelId}` : "None"}</span></p>
        {!connections.length && !error && <p className="py-4 text-sm text-muted-foreground">No model providers</p>}
        <ul className="divide-y divide-border">{connections.map(connection => <li key={connection.id} className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0"><h3 className="break-words text-sm font-medium">{connection.name}</h3><p className="mt-1 text-xs text-muted-foreground">{providers.find(item => item.id === connection.providerId)?.name ?? connection.providerId} · {connection.state === "revoked" ? "Revoked" : statusLabels[connection.verification]}</p></div>
          <div className="flex flex-wrap gap-2">{connection.state === "active" && <Button size="sm" variant="outline" disabled={busy} onClick={() => setViewing(connection)}>Models</Button>}<Button size="sm" variant="outline" disabled={busy} onClick={() => setDependencies({ connection })}>Access</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => setEditor(connection)}>{connection.state === "revoked" ? "Reconnect" : "Edit key"}</Button>{connection.state === "active" && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDependencies({ connection, action: "revoke" })}>Revoke</Button>}<Button size="sm" variant="ghost" disabled={busy} onClick={() => setDependencies({ connection, action: "remove" })}>Remove</Button></div>
        </li>)}</ul>
      </>}
    </div>}
    {editor && <ProviderEditor key={editor === "new" ? "new" : editor.id} organizationId={organizationId} providers={providers} connection={editor === "new" ? null : editor} onClose={() => setEditor(null)} onSaved={() => { if (editor !== "new" && editor.state === "revoked") setDependencies({ connection: editor }); setEditor(null); void reload(); }} />}
    {dependencies && <DependenciesDialog organizationId={organizationId} {...dependencies} onClose={() => setDependencies(null)} onChanged={() => { setDependencies(null); void reload(); }} />}
    {viewing && <ModelsDialog organizationId={organizationId} connection={viewing} defaultModel={defaultModel} onDefault={setDefaultModel} onClose={() => { setViewing(null); void reload(); }} />}
  </section>;
}

function ProviderEditor({ organizationId, providers, connection, onClose, onSaved }: { organizationId: string; providers: ModelProvider[]; connection: ModelProviderConnection | null; onClose(): void; onSaved(): void }) {
  const [query, setQuery] = useState(""), [providerId, setProviderId] = useState(connection?.providerId ?? "");
  const [name, setName] = useState(connection?.name ?? ""), [apiKey, setApiKey] = useState(""), [endpoint, setEndpoint] = useState(connection?.endpoint ?? "");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const provider = providers.find(item => item.id === providerId);
  async function save(event: React.FormEvent) {
    event.preventDefault(); setError(""); setBusy(true);
    try {
      const body = { name: name.trim(), ...(apiKey ? { apiKey } : {}), ...(endpoint.trim() ? { endpoint: endpoint.trim() } : {}) };
      await providerApi(organizationId, connection ? `/${connection.id}` : "", connection ? { ...body, expectedRevision: connection.revision } : { ...body, providerId }, connection ? "PATCH" : "POST");
      setApiKey(""); toast.success(connection ? "Connection updated" : "Provider saved"); onSaved();
    } catch (cause) { setError(providerError(cause)); } finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent onInteractOutside={event => { if (busy) event.preventDefault(); }}><DialogHeader><DialogTitle>{connection ? connection.state === "revoked" ? "Reconnect provider" : "Edit provider" : "Add provider"}</DialogTitle><DialogDescription>{provider?.name ?? "Choose a provider"}</DialogDescription></DialogHeader>
    {!providerId ? <div className="space-y-4"><Input aria-label="Search providers" placeholder="Search providers" value={query} onChange={event => setQuery(event.target.value)} /><ul className="max-h-80 overflow-auto divide-y divide-border">{providers.filter(item => item.name.toLowerCase().includes(query.toLowerCase())).map(item => <li key={item.id}><button type="button" disabled={item.adapter.readiness !== "installed"} className="flex min-h-12 w-full items-center justify-between gap-3 rounded px-2 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50" onClick={() => { setProviderId(item.id); setName(item.name); }}><span>{item.name}</span>{item.adapter.readiness !== "installed" && <span className="text-xs text-muted-foreground">Unavailable</span>}</button></li>)}</ul>{!providers.some(item => item.name.toLowerCase().includes(query.toLowerCase())) && <p className="text-sm text-muted-foreground">No providers found</p>}</div> : <form onSubmit={event => void save(event)} className="space-y-4">
      <label className="block space-y-2 text-sm">Connection name<Input required maxLength={120} value={name} onChange={event => setName(event.target.value)} disabled={busy} /></label>
      <label className="block space-y-2 text-sm">{connection?.state === "active" ? "Replacement API key" : "API key"}<Input type="password" autoComplete="new-password" required={!connection || connection.state === "revoked"} maxLength={4096} value={apiKey} onChange={event => setApiKey(event.target.value)} disabled={busy} placeholder={connection?.state === "active" ? "Leave blank to keep current key" : ""} /></label>
      <details><summary className="cursor-pointer text-sm">Advanced</summary><label className="mt-3 block space-y-2 text-sm">Endpoint<Input type="url" value={endpoint} placeholder={provider?.baseUrl} onChange={event => setEndpoint(event.target.value)} disabled={busy} /></label></details>
      <InlineError value={error} /><DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save connection"}</Button></DialogFooter>
    </form>}
  </DialogContent></Dialog>;
}

function modelFact(model: ProviderModel) {
  const context = model.contextTokens.value === null ? "Context unknown" : `${model.contextTokens.value.toLocaleString()} context`;
  const tools = model.capabilities.tools;
  return `${context} · ${tools.value === null ? "Tools unknown" : tools.value ? tools.evidence === "verified" ? "Tools verified" : tools.evidence === "discovered" ? "Tools discovered" : "Tools declared" : "No tools"}`;
}

function ModelsDialog({ organizationId, connection, defaultModel, onDefault, onClose }: { organizationId: string; connection: ModelProviderConnection; defaultModel: DefaultModel | null; onDefault(value: DefaultModel): void; onClose(): void }) {
  const [result, setResult] = useState<ProviderModels | null>(null), [stale, setStale] = useState(false), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [search, setSearch] = useState(""), [modelId, setModelId] = useState(defaultModel?.selection?.connectionId === connection.id ? defaultModel.selection.modelId : ""), [verifyTools, setVerifyTools] = useState(false), [probe, setProbe] = useState<ModelProbe | null>(null);
  const { confirm } = useConfirmationDialog();
  const [manual, setManual] = useState(false), [manualModels, setManualModels] = useState<ProviderModel[]>([]);
  const selectedModel = [...(result?.models ?? []), ...manualModels].find(item => item.id === modelId);
  const unavailable = selectedModel?.lifecycle === "retired" || (result?.kind === "discovered" && result.unavailableModelIds?.includes(modelId));
  const capacity = (value: number | null | undefined) => value == null ? "Unknown" : `${value.toLocaleString()} tokens`;
  const price = (value: number | null | undefined) => value == null ? "Unknown" : `$${(value / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 6 })} / 1M tokens`;
  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const cached = await providerApi<CachedProviderModels>(organizationId, `/${connection.id}/models`);
        if (!active) return; setResult(cached.result); setManualModels(cached.result?.models ?? []); setStale(cached.stale); setLoading(false);
        if (cached.errorCode) setError(providerError(new ApiError(503, "Provider refresh failed", cached.errorCode)));
        if (cached.result && cached.stale && cached.status !== "refreshing" && cached.status !== "backoff" && (!cached.retryAt || Date.parse(cached.retryAt) <= Date.now())) {
          setBusy(true);
          const refreshed = await providerApi<ProviderModels>(organizationId, `/${connection.id}/models/refresh`, { expectedRevision: connection.revision });
          if (active) { setResult(refreshed); setStale(false); setError(""); }
        }
      } catch (cause) { if (active) setError(providerError(cause)); }
      finally { if (active) { setLoading(false); setBusy(false); } }
    }
    void load(); return () => { active = false; };
  }, [organizationId, connection.id, connection.revision]);
  async function refresh() {
    setBusy(true); setError("");
    try { setResult(await providerApi<ProviderModels>(organizationId, `/${connection.id}/models/refresh`, { expectedRevision: connection.revision })); setStale(false); toast.success("Models refreshed"); }
    catch (cause) { setError(providerError(cause)); } finally { setBusy(false); }
  }
  async function testModel() {
    if (!await confirm({ title: "Test model?", description: "This sends a small request to the provider and may incur charges.", confirmLabel: "Run test" })) return;
    setBusy(true); setError(""); setProbe(null);
    try { setProbe(await providerApi<ModelProbe>(organizationId, `/${connection.id}/probe`, { expectedRevision: connection.revision, modelId: modelId.trim(), allowBillableRequest: true, verifyTools })); toast.success("Model tested"); }
    catch (cause) { setError(providerError(cause)); } finally { setBusy(false); }
  }
  async function saveDefault() {
    setBusy(true); setError("");
    try { onDefault(await providerApi<DefaultModel>(organizationId, "/default", { connectionId: connection.id, modelId: modelId.trim(), expectedRevision: defaultModel?.revision ?? null }, "PUT")); toast.success("Default model saved"); }
    catch (cause) { setError(providerError(cause)); } finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent className="sm:max-w-2xl"><DialogHeader><DialogTitle>Models</DialogTitle><DialogDescription>{connection.name}</DialogDescription></DialogHeader>
    <InlineError value={error} /><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-muted-foreground">{stale ? "Refresh needed" : result ? "Models updated" : "No models loaded"}</p><Button size="sm" variant="outline" disabled={busy || loading} onClick={() => void refresh()}><RefreshCw className={`size-4 ${busy ? "animate-spin" : ""}`} />{busy ? "Working…" : "Refresh models"}</Button><Button size="sm" variant="outline" disabled={busy || loading} onClick={() => setManual(true)}>Add model</Button></div>
    {loading ? <Skeleton className="h-32 w-full" /> : <>{result?.kind === "manual_required" ? <p className="text-sm text-muted-foreground">Enter a model ID from your provider.</p> : <><Input aria-label="Search models" placeholder="Search models" value={search} onChange={event => setSearch(event.target.value)} /><ul aria-label="Available models" className="max-h-60 overflow-auto divide-y divide-border">{result?.models.filter(item => `${item.name} ${item.id}`.toLowerCase().includes(search.toLowerCase())).map(model => <li key={model.id}><button type="button" aria-pressed={modelId === model.id} disabled={busy || model.lifecycle === "retired" || (result?.kind === "discovered" && result.unavailableModelIds?.includes(model.id))} className="w-full rounded px-2 py-3 text-left hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring aria-pressed:bg-muted disabled:opacity-50" onClick={() => { setModelId(model.id); setProbe(null); }}><span className="block break-words text-sm font-medium">{model.name}</span><span className="block break-all text-xs text-muted-foreground">{model.id}</span><span className="mt-1 block text-xs text-muted-foreground">{result?.kind === "discovered" && result.unavailableModelIds?.includes(model.id) ? "Unavailable in this account" : model.lifecycle === "retired" ? "Retired" : modelFact(model)}</span></button></li>)}</ul>{result?.kind === "discovered" && !result.models.length && <p className="text-sm text-muted-foreground">No models returned</p>}{result?.models.length && !result.models.some(item => `${item.name} ${item.id}`.toLowerCase().includes(search.toLowerCase())) ? <p className="text-sm text-muted-foreground">No matching models</p> : null}{result?.kind === "discovered" && result.visibility === "public_catalog" && <p className="text-xs text-muted-foreground">Provider catalogue. Access varies by account.</p>}{result?.kind === "discovered" && !result.complete && <p className="text-xs text-muted-foreground">Partial model list</p>}</>}
      <label className="block space-y-2 text-sm">Model ID<Input maxLength={512} disabled={busy} value={modelId} onChange={event => { setModelId(event.target.value); setProbe(null); }} /></label>
      {selectedModel && <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-xs">
        <div className="col-span-2 min-w-0"><dt className="text-muted-foreground">Provider route</dt><dd className="break-all">{connection.providerId} · {connection.endpoint}</dd></div>
        <div className="min-w-0"><dt className="text-muted-foreground">Input</dt><dd className="break-words">{selectedModel.inputModalities?.join(", ") || "Unknown"}</dd></div>
        <div className="min-w-0"><dt className="text-muted-foreground">Output</dt><dd className="break-words">{selectedModel.outputModalities?.join(", ") || "Unknown"}</dd></div>
        <div><dt className="text-muted-foreground">Context</dt><dd>{capacity(selectedModel.contextTokens.value)}</dd></div>
        <div><dt className="text-muted-foreground">Max output</dt><dd>{capacity(selectedModel.maxOutputTokens.value)}</dd></div>
        <div><dt className="text-muted-foreground">Input price</dt><dd>{price(selectedModel.pricing?.inputMicrosPerMillionTokens)}</dd></div>
        <div><dt className="text-muted-foreground">Output price</dt><dd>{price(selectedModel.pricing?.outputMicrosPerMillionTokens)}</dd></div>
      </dl>}
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={verifyTools} disabled={busy} onChange={event => { setVerifyTools(event.target.checked); setProbe(null); }} />Test tool support</label>
      {probe && <p role="status" className="text-sm">{statusLabels[probe.verification]} · {probe.usage.observed ? `${probe.usage.inputTokens ?? "?"} input / ${probe.usage.outputTokens ?? "?"} output tokens` : "Usage unavailable"}</p>}
    </>}
    {unavailable && <p role="status" className="text-sm text-muted-foreground">Saved model unavailable. Choose another model.</p>}
    <DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>Close</Button><Button variant="outline" disabled={busy || loading || unavailable || !modelId.trim()} onClick={() => void testModel()}>Test model</Button><Button disabled={busy || loading || unavailable || !modelId.trim()} onClick={() => void saveDefault()}>Set default</Button></DialogFooter>
    {manual && <ManualModelDialog organizationId={organizationId} connection={connection} initialModelId={modelId} onClose={() => setManual(false)} onSaved={model => { setManualModels(prior => [...prior.filter(item => item.id !== model.id), model]); setModelId(model.id); setProbe(null); setManual(false); }} />}
  </DialogContent></Dialog>;
}

function DependenciesDialog({ organizationId, connection, action, onClose, onChanged }: {
  organizationId: string; connection: ModelProviderConnection; action?: "remove" | "revoke"; onClose(): void; onChanged(): void;
}) {
  const [data, setData] = useState<ProviderDependencies | null>(null), [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const { confirm } = useConfirmationDialog();
  async function load(cursor?: string) {
    setBusy(true); setError("");
    try { const next = await providerApi<ProviderDependencies>(organizationId, `/${connection.id}/dependencies${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`); setData(prior => cursor && prior ? { ...next, entries: [...prior.entries, ...next.entries] } : next); }
    catch (cause) { setError(providerError(cause)); } finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, [organizationId, connection.id]); // eslint-disable-line react-hooks/exhaustive-deps
  async function restore(agent: ProviderDependencies["entries"][number]) {
    if (!data || !await confirm({ title: "Restore agent access?", description: `${agent.name} can use ${connection.name} with its configured models.`, confirmLabel: "Restore access" })) return;
    setBusy(true); setError("");
    try { await providerApi(organizationId, `/${connection.id}/reauthorize`, { expectedRevision: data.connectionRevision, agentId: agent.id, agentRevision: agent.revision }); toast.success("Agent access restored"); await load(); }
    catch (cause) { setError(providerError(cause)); } finally { setBusy(false); }
  }
  async function disconnect() {
    if (!data || !action || !await confirm({ title: action === "revoke" ? "Revoke key?" : "Remove connection?", description: "New model calls will stop. Requests already sent may still complete or incur charges.", confirmLabel: action === "revoke" ? "Revoke key" : "Remove", variant: "destructive" })) return;
    setBusy(true); setError("");
    try { await providerApi(organizationId, `/${connection.id}${action === "revoke" ? "/revoke" : ""}`, { expectedRevision: data.connectionRevision }, action === "revoke" ? "POST" : "DELETE"); toast.success(action === "revoke" ? "Key revoked" : "Connection removed"); onChanged(); }
    catch (cause) { setError(providerError(cause)); } finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent><DialogHeader><DialogTitle>{action ? "Affected agents" : "Provider access"}</DialogTitle><DialogDescription>{connection.name}</DialogDescription></DialogHeader>
    <InlineError value={error} />{error && <Button variant="outline" size="sm" disabled={busy} onClick={() => void load()}>Reload</Button>}
    {!data ? <Skeleton className="h-24 w-full" /> : <div className="space-y-3">
      {data.defaultModel && <p className="break-all text-sm">Workspace default · {data.defaultModel.modelId}</p>}
      {data.activeTasks > 0 && <p className="text-sm">{data.activeTasks} active tasks</p>}
      {data.uncertainTasks > 0 && <p className="text-sm">{data.uncertainTasks} tasks with an uncertain provider outcome</p>}
      {!data.total && !data.defaultModel && <p className="text-sm text-muted-foreground">No dependent agents or schedules</p>}
      <ul className="max-h-72 divide-y divide-border overflow-auto">{data.entries.map(entry => <li key={entry.cursor} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm"><div className="min-w-0"><p className="break-words font-medium">{entry.name}</p><p className="text-xs text-muted-foreground">{entry.kind === "schedule" ? "Scheduled work" : "Agent"}</p></div>{!action && entry.kind === "agent" && entry.reauthorizable && !entry.authorized && data.state === "active" && <Button size="sm" variant="outline" disabled={busy} onClick={() => void restore(entry)}>Restore access</Button>}</li>)}</ul>
      {data.nextCursor && <Button size="sm" variant="outline" disabled={busy} onClick={() => void load(data.nextCursor!)}>Load more</Button>}
      {!action && data.defaultModel && <p className="text-xs text-muted-foreground">After reconnecting, select the default model again to restore default access.</p>}
    </div>}
    <DialogFooter><Button variant="outline" disabled={busy} onClick={onClose}>{action ? "Cancel" : "Close"}</Button>{action && <Button variant="destructive" disabled={busy || !data} onClick={() => void disconnect()}>{busy ? "Working…" : action === "revoke" ? "Revoke key" : "Remove"}</Button>}</DialogFooter>
  </DialogContent></Dialog>;
}

function ManualModelDialog({ organizationId, connection, initialModelId, onClose, onSaved }: {
  organizationId: string; connection: ModelProviderConnection; initialModelId: string; onClose(): void; onSaved(model: ProviderModel): void;
}) {
  const [id, setId] = useState(initialModelId), [context, setContext] = useState(""), [output, setOutput] = useState(""), [reference, setReference] = useState("");
  const [tools, setTools] = useState("unknown"), [attested, setAttested] = useState(false), [custom, setCustom] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function save(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const { model } = await providerApi<{ model: ProviderModel }>(organizationId, `/${connection.id}/models/manual`, { expectedRevision: connection.revision, modelId: id.trim(),
        ...(custom ? { confirmMetadata: attested, metadata: { reference: reference.trim(), ...(context ? { contextTokens: Number(context) } : {}), ...(output ? { maxOutputTokens: Number(output) } : {}),
          ...(tools !== "unknown" ? { tools: tools === "yes" } : {}), inputModalities: ["text"], outputModalities: ["text"] } } : {}) });
      toast.success("Model added"); onSaved(model);
    } catch (cause) { setError(providerError(cause)); } finally { setBusy(false); }
  }
  return <Dialog open onOpenChange={open => { if (!open && !busy) onClose(); }}><DialogContent><DialogHeader><DialogTitle>Add model</DialogTitle><DialogDescription>{connection.name}</DialogDescription></DialogHeader>
    <form className="space-y-4" onSubmit={event => void save(event)}><label className="block space-y-2 text-sm">Model ID<Input required maxLength={256} value={id} disabled={busy} onChange={event => setId(event.target.value)} /></label>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={custom} disabled={busy} onChange={event => setCustom(event.target.checked)} />Specify model metadata</label>
      {custom && <div className="space-y-4"><label className="block space-y-2 text-sm">Source reference<Input required maxLength={512} placeholder="Provider documentation or deployment specification" value={reference} disabled={busy} onChange={event => setReference(event.target.value)} /></label>
        <div className="grid gap-3 sm:grid-cols-2"><label className="block space-y-2 text-sm">Context tokens<Input type="number" min={1} step={1} value={context} disabled={busy} onChange={event => setContext(event.target.value)} /></label><label className="block space-y-2 text-sm">Maximum output tokens<Input type="number" min={1} step={1} value={output} disabled={busy} onChange={event => setOutput(event.target.value)} /></label></div>
        <label className="block space-y-2 text-sm">Tool support<select aria-label="Tool support" className="min-h-10 w-full rounded-md border border-input bg-background px-3" disabled={busy} value={tools} onChange={event => setTools(event.target.value)}><option value="unknown">Unknown</option><option value="yes">Supported</option><option value="no">Unsupported</option></select></label>
        <label className="flex items-start gap-2 text-sm"><input className="mt-1" type="checkbox" required checked={attested} disabled={busy} onChange={event => setAttested(event.target.checked)} /><span>I verified these limits against the source.</span></label>
      </div>}
      <InlineError value={error} /><DialogFooter><Button type="button" variant="outline" disabled={busy} onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy || (custom && !attested)}>{busy ? "Saving…" : "Add model"}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}
