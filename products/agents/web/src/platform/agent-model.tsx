import { useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import { PiCaretDown as ChevronDown, PiCheck as Check, PiMagnifyingGlass } from "react-icons/pi";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api, message, organizationPath, type Configuration } from "./api";
import { providerApi, providerError, type CachedProviderModels, type DefaultModel, type ModelProviderConnection, type ProviderModel } from "./model-provider-api";

type ModelPolicyPreview = {
  modelId: string | null; modelRevision: string | null;
  limits: { contextTokens: number | null; maxInputTokens: number | null; maxOutputTokens: number | null;
    maxCallDurationMs: number | null; maxRootTokens: number | null; safetyTokens: number | null };
  effectivePolicy: Record<string, unknown> | null; errors: { field: string; message: string }[];
  controls: { temperature: { min: number; max: number; source: string } | null;
    reasoning: { kind: "effort" | "budget" | "level"; values?: string[]; minTokens?: number; maxTokens?: number; source: string } | null };
};
type Choice = { connection: ModelProviderConnection; model: ProviderModel; available: boolean; toolSupport: "supported" | "needs_verification" | "unsupported" };
function useAgentModels(organizationId: string, agentId: string) {
  const [choices, setChoices] = useState<Choice[]>([]), [defaultModel, setDefaultModel] = useState<DefaultModel | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setLoading(true); setError("");
    void Promise.all([providerApi<{ connections: ModelProviderConnection[] }>(organizationId), providerApi<DefaultModel>(organizationId, "/default")])
      .then(async ([list, selection]) => {
        const models = await Promise.allSettled(list.connections.filter(connection => connection.state === "active").map(async connection => {
          const cache = await providerApi<CachedProviderModels>(organizationId, `/${connection.id}/models?agentId=${encodeURIComponent(agentId)}`);
          return (cache.result?.models ?? []).map(model => ({ connection, model, toolSupport: cache.toolSupport?.[model.id] ?? (model.capabilities.tools.value === false ? "unsupported" : cache.modelVerifications?.[model.id] === "tools_verified" || model.capabilities.tools.value === true && (model.capabilities.tools.source?.kind !== "operator" || model.capabilities.tools.evidence === "verified") ? "supported" : "needs_verification" as const), available: cache.result?.kind !== "discovered" || !cache.result.unavailableModelIds?.includes(model.id) }));
        }));
        if (!active) return;
        setDefaultModel(selection); setChoices(models.flatMap(result => result.status === "fulfilled" ? result.value : []));
        if (models.some(result => result.status === "rejected")) setError("Some model lists are unavailable.");
      }).catch(cause => { if (active) setError(providerError(cause)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [organizationId, agentId]);
  return { choices, defaultModel, loading, error };
}
function modelIncompatibility(choice: Choice, requiresTools: boolean): string | null {
  if (!choice.available || choice.model.lifecycle === "retired") return "Unavailable";
  if (!choice.model.inputModalities?.includes("text") || !choice.model.outputModalities?.includes("text")) return "Text support unconfirmed";
  if (requiresTools && choice.toolSupport === "unsupported") return "Tools unsupported";
  if (requiresTools && choice.toolSupport === "needs_verification") return "Tool test required";
  return null;
}
type Selection = NonNullable<Configuration["model"]["selection"]>;
export function ChatModelPicker({ organizationId, agentId, configuration, dirty, saving, onSelect }: {
  organizationId: string; agentId: string; configuration: Configuration; dirty: boolean; saving: boolean;
  onSelect(selection: Selection): Promise<boolean>;
}) {
  const { choices, defaultModel, loading, error } = useAgentModels(organizationId, agentId);
  const active = configuration.model.selection ?? { kind: "organization_default" as const };
  const activeKey = JSON.stringify(active);
  const [open, setOpen] = useState(false), [search, setSearch] = useState(""), [pending, setPending] = useState(activeKey), [saveError, setSaveError] = useState("");
  const requiresTools = Boolean(configuration.tools?.length || configuration.connectedToolBindingIds?.length || configuration.skillIds?.length);
  const resolved = active.kind === "organization_default" ? defaultModel?.selection : active;
  const selected = choices.find(choice => choice.connection.id === resolved?.connectionId && choice.model.id === resolved.modelId);
  const label = selected ? `${selected.connection.name} · ${selected.model.name}` : resolved ? resolved.modelId : loading ? "Loading model…" : "Choose model";
  const matching = choices.filter(choice => `${choice.connection.name} ${choice.connection.providerId} ${choice.model.id} ${choice.model.name}`.toLowerCase().includes(search.toLowerCase()));
  const defaultChoice = choices.find(choice => choice.connection.id === defaultModel?.selection?.connectionId && choice.model.id === defaultModel.selection.modelId);
  const defaultReason = defaultChoice ? modelIncompatibility(defaultChoice, requiresTools) : "No available default model";
  async function apply() {
    if (saving || dirty) return;
    setSaveError("");
    try { if (await onSelect(JSON.parse(pending) as Selection)) setOpen(false); }
    catch (cause) { setSaveError(message(cause)); }
  }
  return <>
    <Button size="sm" variant="ghost" className="max-w-full min-w-0" aria-label={`Chat model: ${label}`} disabled={saving} onClick={() => { setPending(activeKey); setSearch(""); setSaveError(""); setOpen(true); }}><span className="truncate">{label}</span><ChevronDown className="size-3 shrink-0" /></Button>
    <Dialog open={open} onOpenChange={value => { if (!saving) setOpen(value); }}><DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>Choose model</DialogTitle><DialogDescription>New messages use the saved model.</DialogDescription></DialogHeader>
      {dirty && <p role="status" className="text-sm text-muted-foreground">Save configuration changes in Configure before switching models.</p>}
      {error && <p role="status" className="text-sm text-muted-foreground">{error}</p>}
      {saveError && <p role="alert" className="text-sm text-destructive">{saveError}</p>}
      <Input aria-label="Search chat models" placeholder="Search models" value={search} disabled={saving} onChange={event => setSearch(event.target.value)} />
      <div className="max-h-[50vh] space-y-1 overflow-auto" aria-label="Chat models" aria-busy={loading}>
        <button type="button" disabled={saving || Boolean(defaultReason)} title={defaultReason ?? undefined} aria-pressed={pending === JSON.stringify({ kind: "organization_default" })} className="flex min-h-12 w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left hover:bg-muted aria-pressed:bg-muted disabled:opacity-50" onClick={() => setPending(JSON.stringify({ kind: "organization_default" }))}>
          <span className="min-w-0 text-sm font-medium">Organization default</span>{pending === JSON.stringify({ kind: "organization_default" }) && <Check className="size-4 shrink-0" />}
        </button>
        {matching.map(choice => {
          const key = JSON.stringify({ kind: "connection", connectionId: choice.connection.id, modelId: choice.model.id });
          const reason = modelIncompatibility(choice, requiresTools);
          return <button type="button" key={key} disabled={saving || Boolean(reason)} title={reason ?? undefined} aria-pressed={pending === key} className="flex min-h-12 w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left hover:bg-muted aria-pressed:bg-muted disabled:opacity-50" onClick={() => setPending(key)}><span className="min-w-0 break-words text-sm font-medium">{choice.model.name}</span>{pending === key && <Check className="size-4 shrink-0" />}</button>;
        })}
        {!loading && !matching.length && <p className="px-3 py-2 text-sm text-muted-foreground">{choices.length ? "No matching models" : "No available models"}</p>}
      </div>
      <Link to="/app/settings" className="text-sm underline underline-offset-4">Manage model providers</Link>
      <DialogFooter><Button variant="outline" disabled={saving} onClick={() => setOpen(false)}>Cancel</Button><Button disabled={saving || dirty || pending === activeKey || loading} onClick={() => void apply()}>{saving ? "Saving…" : "Use model"}</Button></DialogFooter>
    </DialogContent></Dialog>
  </>;
}
export function AgentModel({ organizationId, agentId, configuration, onChange }: {
  organizationId: string; agentId: string; configuration: Configuration; onChange(value: Configuration): void;
}) {
  const { choices, defaultModel, loading, error } = useAgentModels(organizationId, agentId);
  const [policy, setPolicy] = useState<{ routeKey: string; value: ModelPolicyPreview } | null>(null), [previewError, setPreviewError] = useState("");
  const selection = configuration.model.selection ?? { kind: "organization_default" as const };
  const routeKey = JSON.stringify(selection), preview = policy && policy.routeKey === routeKey ? policy.value : null;
  const [checkingPolicy, setCheckingPolicy] = useState(false);
  const errorsId = useId(), configurationKey = JSON.stringify(configuration);
  useEffect(() => {
    const cancel = new AbortController(); let active = true;
    setPreviewError(""); setCheckingPolicy(true);
    const timer = setTimeout(() => {
      void api<ModelPolicyPreview>(`${organizationPath(organizationId)}/agents/${encodeURIComponent(agentId)}/model-policy`,
        { configuration: JSON.parse(configurationKey) }, "POST", undefined, cancel.signal)
        .then(result => { if (active) setPolicy({ routeKey, value: result }); })
        .catch(error => { if (active && !cancel.signal.aborted) setPreviewError(message(error)); })
        .finally(() => { if (active) setCheckingPolicy(false); });
    }, 250);
    return () => { active = false; clearTimeout(timer); cancel.abort(); };
  }, [organizationId, agentId, configurationKey, routeKey]);
  const [search, setSearch] = useState("");
  const current = JSON.stringify(selection);
  const requiresTools = Boolean(configuration.tools?.length || configuration.connectedToolBindingIds?.length || configuration.skillIds?.length);
  const incompatibility = (choice: Choice) => modelIncompatibility(choice, requiresTools);
  const filtered = choices.filter(choice => `${choice.connection.name} ${choice.connection.providerId} ${choice.model.id} ${choice.model.name}`.toLowerCase().includes(search.toLowerCase()));
  const selected = choices.find(choice => selection.kind === "connection" && choice.connection.id === selection.connectionId && choice.model.id === selection.modelId);
  const available = selection.kind === "organization_default" ? choices.find(choice => choice.connection.id === defaultModel?.selection?.connectionId && choice.model.id === defaultModel.selection.modelId) : selected;
  const limits = preview?.limits, controls = preview?.controls;
  const generation = configuration.model.generation, reasoning = generation?.reasoning;
  const reasoningControl = controls?.reasoning;
  const reasonValue = reasoning ? reasoning.kind === "budget" ? "budget" : reasoning.value : "provider_default";
  const reasonSupported = !reasoning || reasoningControl?.kind === reasoning.kind && (reasoning.kind === "budget"
    ? (reasoningControl.minTokens === undefined || reasoning.tokens >= reasoningControl.minTokens) && (reasoningControl.maxTokens === undefined || reasoning.tokens <= reasoningControl.maxTokens)
    : Boolean(reasoningControl.values?.includes(reasoning.value)));
  const unavailableGeneration = preview && generation && ((generation.temperature !== undefined && !controls?.temperature) || !reasonSupported);
  const fieldError = (name: string) => preview?.errors.filter(error => error.field === name || error.field.endsWith(`.${name}`) || error.field === "model.generation" && ["temperature", "reasoning"].includes(name)).map(error => error.message).join(" ") ?? "";
  const field = (name: string) => ({ "aria-invalid": Boolean(fieldError(name)), "aria-describedby": fieldError(name) ? errorsId : undefined });
  const effective = (name: string) => typeof preview?.effectivePolicy?.[name] === "number" ? Number(preview.effectivePolicy[name]).toLocaleString() : "Unknown";
  function update(values: Partial<Configuration["model"]>) { onChange({ ...configuration, model: { ...configuration.model, ...values } }); }
  function updateGeneration(values: Partial<NonNullable<Configuration["model"]["generation"]>>) {
    const next = { ...generation, ...values };
    if (next.temperature === undefined) delete next.temperature;
    if (next.reasoning === undefined) delete next.reasoning;
    update({ generation: Object.keys(next).length ? next : undefined });
  }
  return <div className="agent-model-section space-y-4">
    <label className="block space-y-2 text-sm font-medium"><span className="agent-model-heading">Model</span>
      <span className="agent-model-search"><PiMagnifyingGlass size={16} aria-hidden="true" /><Input aria-label="Search agent models" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search models" /></span>
      <select aria-label="Agent model" className="min-h-10 w-full rounded-md border bg-background p-2 font-normal" value={current} disabled={loading}
        onChange={event => update({ selection: JSON.parse(event.target.value) as Configuration["model"]["selection"] })}>
        <option value={JSON.stringify({ kind: "organization_default" })}>Organization default{defaultModel?.selection ? ` · ${defaultModel.selection.modelId}` : ""}</option>
        {selection.kind === "connection" && !filtered.some(choice => choice.connection.id === selection.connectionId && choice.model.id === selection.modelId) &&
          <option value={current}>{selected?.connection.name ?? "Saved connection"} · {selection.modelId}</option>}
        {filtered.map(choice => <option disabled={Boolean(incompatibility(choice))} key={`${choice.connection.id}:${choice.model.id}`} value={JSON.stringify({ kind: "connection", connectionId: choice.connection.id, modelId: choice.model.id })}>
          {choice.connection.name} · {choice.model.name} · {choice.model.id}{incompatibility(choice) ? ` · ${incompatibility(choice)}` : ""}
        </option>)}
      </select>
    </label>
    {available && (!available.available || available.model.lifecycle === "retired") && <p role="status" className="text-sm text-muted-foreground">Saved model unavailable. Choose another model.</p>}
    {error && <p role="status" className="text-sm text-muted-foreground">{error}</p>}
    {available && incompatibility(available) && available.available && available.model.lifecycle !== "retired" && <p role="status" className="text-sm text-muted-foreground">{incompatibility(available)}. {requiresTools && available.toolSupport === "needs_verification" ? "Test tool support in Model providers." : "Choose a compatible model."}</p>}
    {available && <details className="text-xs text-muted-foreground"><summary className="min-h-10 cursor-pointer content-center">Model details</summary><dl className="space-y-2 break-words">
      <div><dt className="font-medium text-foreground">Provider route</dt><dd>{available.connection.providerId} · {available.connection.name} · {available.model.id}</dd></div>
      <div><dt className="font-medium text-foreground">Modalities</dt><dd>Input: {available.model.inputModalities?.join(", ") || "Unknown"} · Output: {available.model.outputModalities?.join(", ") || "Unknown"}</dd></div>
    </dl></details>}
    <Link to="/app/settings" className="inline-block text-sm underline underline-offset-4">Manage model providers</Link>
    <details className="rounded-md border border-border p-4 text-sm"><summary className="cursor-pointer font-medium">Model limits</summary>
      <div className="mt-4 space-y-4" aria-busy={checkingPolicy}>
        {checkingPolicy && <p role="status" className="text-xs text-muted-foreground">Checking model settings…</p>}
        {previewError && <p role="alert" className="text-sm text-destructive">{previewError}</p>}
        {preview?.effectivePolicy && <div className="text-xs text-muted-foreground" aria-label="Effective model limits">
          <p className="font-medium text-foreground">Effective limits</p>
          <p className="mt-1 break-words">Context {effective("contextTokens")} · Reply {effective("maxOutputTokens")} · Task {effective("maxRootTokens")} tokens</p>
        </div>}
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block space-y-2">Maximum reply tokens<Input type="number" min={1} max={limits?.maxOutputTokens ?? undefined} required {...field("maxOutputTokens")} value={configuration.model.maxOutputTokens} onChange={event => update({ maxOutputTokens: Number(event.target.value) })} /></label>
          <label className="block space-y-2">Call timeout in seconds<Input type="number" min={1} max={limits?.maxCallDurationMs === null || limits?.maxCallDurationMs === undefined ? undefined : Math.floor(limits.maxCallDurationMs / 1000)} required {...field("maxDurationSeconds")} value={configuration.model.maxDurationSeconds} onChange={event => update({ maxDurationSeconds: Number(event.target.value) })} /></label>
          <label className="block space-y-2">Input context tokens<Input type="number" min={1} max={limits?.maxInputTokens ?? undefined} required {...field("maxInputTokens")} value={configuration.context?.maxInputTokens ?? ""} onChange={event => onChange({ ...configuration, context: { maxInputTokens: Number(event.target.value), compactAtTokens: configuration.context?.compactAtTokens ?? 1 } })} /></label>
          <label className="block space-y-2">Compact at tokens<Input type="number" min={1} max={configuration.context?.maxInputTokens === undefined ? undefined : configuration.context.maxInputTokens - 1} required {...field("compactAtTokens")} value={configuration.context?.compactAtTokens ?? ""} onChange={event => onChange({ ...configuration, context: { maxInputTokens: configuration.context?.maxInputTokens ?? Number(event.target.value) + 1, compactAtTokens: Number(event.target.value) } })} /></label>
          {controls?.temperature && <label className="block space-y-2">Temperature<Input aria-label="Temperature" type="number" step="any" min={controls.temperature.min} max={controls.temperature.max} placeholder="Provider default" {...field("temperature")}
            value={generation?.temperature ?? ""} onChange={event => updateGeneration({ temperature: event.target.value === "" ? undefined : Number(event.target.value) })} /></label>}
          {reasoningControl && <label className="block space-y-2">Reasoning<select aria-label="Reasoning" className="min-h-10 w-full rounded-md border bg-background p-2 font-normal" {...field("reasoning")} value={reasonValue}
            onChange={event => updateGeneration({ reasoning: event.target.value === "provider_default" ? undefined : reasoningControl.kind === "budget" ? { kind: "budget", tokens: reasoningControl.minTokens ?? 1 } : { kind: reasoningControl.kind, value: event.target.value } })}>
            <option value="provider_default">Provider default</option>
            {reasoning && !reasonSupported && <option value={reasonValue}>Saved: {reasonValue} (unavailable)</option>}
            {reasoningControl.kind === "budget" ? <option value="budget">Token budget</option> : reasoningControl.values?.map(value => <option value={value} key={value}>{value}</option>)}
          </select></label>}
          {reasoningControl?.kind === "budget" && reasoning?.kind === "budget" && <label className="block space-y-2">Reasoning tokens<Input aria-label="Reasoning tokens" type="number" min={reasoningControl.minTokens} max={reasoningControl.maxTokens} {...field("reasoning")} value={reasoning.tokens}
            onChange={event => updateGeneration({ reasoning: { kind: "budget", tokens: Number(event.target.value) } })} /></label>}
        </div>
        {unavailableGeneration && <p role="alert" className="text-sm text-destructive">Saved generation settings are unavailable for this model.</p>}
        {generation && Object.keys(generation).length > 0 && <button type="button" className="min-h-10 text-sm underline underline-offset-4" onClick={() => update({ generation: undefined })}>Reset provider defaults</button>}
        {preview?.errors.length ? <ul id={errorsId} className="space-y-1 text-sm text-destructive" role="alert">{preview.errors.map((error, index) => <li key={`${error.field}:${index}`}>{error.message}</li>)}</ul> : null}
      </div>
    </details>
  </div>;
}
