import { useEffect, useId, useState } from "react";
import { Link } from "react-router-dom";
import { AgentModelPicker } from "@kasitek-labs/ui/agent-model-picker";
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
  const [paidModelsAllowed, setPaidModelsAllowed] = useState(true);
  const [loading, setLoading] = useState(true), [error, setError] = useState(""), [reloadKey,setReloadKey]=useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setError("");
    void Promise.all([providerApi<{ connections: ModelProviderConnection[] }>(organizationId), providerApi<DefaultModel>(organizationId, "/default")])
      .then(async ([list, selection]) => {
        const models = await Promise.allSettled(list.connections.filter(connection => connection.state === "active").map(async connection => {
          const cache = await providerApi<CachedProviderModels>(organizationId, `/${connection.id}/models?agentId=${encodeURIComponent(agentId)}`);
          return { paidModelsAllowed: cache.paidModelsAllowed !== false,
            choices: (cache.result?.models ?? []).map(model => ({ connection, model, toolSupport: cache.toolSupport?.[model.id] ?? (model.capabilities.tools.value === false ? "unsupported" : cache.modelVerifications?.[model.id] === "tools_verified" || model.capabilities.tools.value === true && (model.capabilities.tools.source?.kind !== "operator" || model.capabilities.tools.evidence === "verified") ? "supported" : "needs_verification" as const), available: cache.result?.kind !== "discovered" || !cache.result.unavailableModelIds?.includes(model.id) })) };
        }));
        if (!active) return;
        setDefaultModel(selection);
        setChoices(models.flatMap(result => result.status === "fulfilled" ? result.value.choices : []));
        setPaidModelsAllowed(!models.some(result => result.status === "fulfilled" && !result.value.paidModelsAllowed));
        if (models.some(result => result.status === "rejected")) setError("Some model lists are unavailable.");
      }).catch(cause => { if (active) setError(providerError(cause)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [organizationId, agentId,reloadKey]);
  return { choices, defaultModel, paidModelsAllowed, loading, error,reload:()=>setReloadKey(value=>value+1) };
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
  const { choices, defaultModel, paidModelsAllowed, loading, error,reload } = useAgentModels(organizationId, agentId);
  const active = configuration.model.selection ?? { kind: "organization_default" as const };
  const activeKey = JSON.stringify(active);
  const [open, setOpen] = useState(false), [search, setSearch] = useState(""), [pending, setPending] = useState(activeKey), [saveError, setSaveError] = useState("");
  const requiresTools = Boolean(configuration.tools?.length || configuration.connectedToolBindingIds?.length || configuration.skillIds?.length || configuration.procedures?.length);
  const resolved = active.kind === "organization_default" ? defaultModel?.selection : active;
  const selected = choices.find(choice => choice.connection.id === resolved?.connectionId && choice.model.id === resolved.modelId);
  const label = selected ? `${selected.connection.name} · ${selected.model.name}` : resolved ? resolved.modelId : loading ? "Loading model…" : "Choose model";
  const defaultChoice = choices.find(choice => choice.connection.id === defaultModel?.selection?.connectionId && choice.model.id === defaultModel.selection.modelId);
  const defaultReason = defaultChoice ? modelIncompatibility(defaultChoice, requiresTools) : "No available default model";
  const details = (choice: Choice | undefined) => choice ? {contextWindowTokens:choice.model.contextTokens.value,maxOutputTokens:choice.model.maxOutputTokens.value,
    pricing:choice.model.pricing?{...choice.model.pricing,currency:"USD" as const}:null} : {};
  async function apply() {
    if (saving || dirty) return;
    setSaveError("");
    try { if (await onSelect(JSON.parse(pending) as Selection)) setOpen(false); }
    catch (cause) { setSaveError(message(cause)); }
  }
  return <AgentModelPicker label={label} disabled={saving} open={open} onOpenChange={value=>{
    if(value){setPending(activeKey);setSearch("");setSaveError("");}setOpen(value);
  }} search={search} onSearch={setSearch} selectedId={pending} onSelect={setPending}
    options={[{id:JSON.stringify({kind:"organization_default"}),label:defaultChoice?`${defaultChoice.model.name} · Default`:"Default",...details(defaultChoice),disabled:Boolean(defaultReason),reason:defaultReason??undefined},
      ...choices.map(choice=>({id:JSON.stringify({kind:"connection",connectionId:choice.connection.id,modelId:choice.model.id}),
        label:choice.model.name,provider:`${choice.connection.name} · ${choice.model.id}`,...details(choice),disabled:Boolean(modelIncompatibility(choice,requiresTools)),reason:modelIncompatibility(choice,requiresTools)??undefined}))]}
    loading={loading} saving={saving} error={saveError||error} saveDisabled={dirty||pending===activeKey}
    onSave={()=>void apply()} onReload={reload} footer={<>
      {!paidModelsAllowed?<p role="status" className="text-sm text-muted-foreground">AI allowance used up. Free managed models only. <Link className="underline underline-offset-4" to="/app/upgrade">Upgrade</Link></p>:null}
      {dirty?<p role="status" className="text-sm text-muted-foreground">Save configuration changes before switching models.</p>:null}
      <Link to="/app/settings" className="text-sm underline underline-offset-4">Manage model providers</Link>
    </>} />;
}
export function AgentModel({ organizationId, agentId, configuration, onChange }: {
  organizationId: string; agentId: string; configuration: Configuration; onChange(value: Configuration): void;
}) {
  const { choices, defaultModel, paidModelsAllowed, loading, error, reload } = useAgentModels(organizationId, agentId);
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
  const [pickerOpen, setPickerOpen] = useState(false), [modelSearch, setModelSearch] = useState(""), [pending, setPending] = useState(JSON.stringify(selection));
  const current = JSON.stringify(selection);
  const requiresTools = Boolean(configuration.tools?.length || configuration.connectedToolBindingIds?.length || configuration.skillIds?.length || configuration.procedures?.length);
  const incompatibility = (choice: Choice) => modelIncompatibility(choice, requiresTools);
  const selected = choices.find(choice => selection.kind === "connection" && choice.connection.id === selection.connectionId && choice.model.id === selection.modelId);
  const defaultChoice = choices.find(choice => choice.connection.id === defaultModel?.selection?.connectionId && choice.model.id === defaultModel.selection.modelId);
  const defaultReason = defaultChoice ? incompatibility(defaultChoice) : "No available default model";
  const selectedLabel = selection.kind === "organization_default" ? defaultChoice?.model.name ?? "Choose model" : selected?.model.name ?? selection.modelId;
  const modelMetrics = (choice: Choice | undefined) => choice ? { contextWindowTokens: choice.model.contextTokens.value, maxOutputTokens: choice.model.maxOutputTokens.value,
    pricing: choice.model.pricing ? { ...choice.model.pricing, currency: "USD" as const } : null } : {};
  const modelOptions = [
    { id: JSON.stringify({ kind: "organization_default" }), label: defaultChoice ? `${defaultChoice.model.name} · Default` : "Default", ...modelMetrics(defaultChoice), disabled: Boolean(defaultReason), reason: defaultReason ?? undefined },
    ...choices.map(choice => ({ id: JSON.stringify({ kind: "connection", connectionId: choice.connection.id, modelId: choice.model.id }),
      label: choice.model.name, provider: choice.model.id, ...modelMetrics(choice), disabled: Boolean(incompatibility(choice)), reason: incompatibility(choice) ?? undefined })),
  ];
  const available = selection.kind === "organization_default" ? defaultChoice : selected;
  const limits = preview?.limits, controls = preview?.controls;
  const customContext=configuration.context&&!("mode" in configuration.context)?configuration.context:undefined;
  const automaticInput=preview?.effectivePolicy?.maxInputTokens,automaticThreshold=preview?.effectivePolicy?.compactAtTokens;
  const canSetContext=typeof automaticInput==="number"&&typeof automaticThreshold==="number";
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
  function applyModel() {
    if (pending === current) { setPickerOpen(false); return; }
    update({ selection: JSON.parse(pending) as Configuration["model"]["selection"] });
    setPickerOpen(false);
  }
  function updateGeneration(values: Partial<NonNullable<Configuration["model"]["generation"]>>) {
    const next = { ...generation, ...values };
    if (next.temperature === undefined) delete next.temperature;
    if (next.reasoning === undefined) delete next.reasoning;
    update({ generation: Object.keys(next).length ? next : undefined });
  }
  return <div className="agent-model-section space-y-4">
    <div className="space-y-2">
      <span className="agent-model-heading">Model</span>
      <AgentModelPicker label={`${selectedLabel}${selection.kind === "organization_default" ? " · Default" : ""}`}
        ariaLabel={`Agent model: ${selectedLabel}`} open={pickerOpen}
        onOpenChange={value => { if (value) { setPending(current); setModelSearch(""); } setPickerOpen(value); }}
        options={modelOptions} selectedId={pending} onSelect={setPending} search={modelSearch} onSearch={setModelSearch}
        loading={loading} error={error} saveDisabled={pending === current || !modelOptions.some(option => option.id === pending && !option.disabled)}
        onSave={applyModel} onReload={reload} description="Applies to this agent after saving changes."
        footer={<div className="space-y-2">
          {!paidModelsAllowed ? <p role="status" className="text-sm text-muted-foreground">AI allowance used up. Free managed models only. <Link className="underline underline-offset-4" to="/app/upgrade">Upgrade</Link></p> : null}
          <p className="text-xs text-muted-foreground">Save changes to apply.</p>
          <Link to="/app/settings" className="text-sm underline underline-offset-4">Manage model providers</Link>
        </div>} />
    </div>
    {!paidModelsAllowed ? <p role="status" className="text-sm text-muted-foreground">AI allowance used up. Free managed models only. <Link className="underline underline-offset-4" to="/app/upgrade">Upgrade</Link></p> : null}
    {available && (!available.available || available.model.lifecycle === "retired") && <p role="status" className="text-sm text-muted-foreground">Saved model unavailable. Choose another model.</p>}
    {error && <p role="status" className="text-sm text-muted-foreground">{error}</p>}
    {available && incompatibility(available) && available.available && available.model.lifecycle !== "retired" && <p role="status" className="text-sm text-muted-foreground">{incompatibility(available)}. {requiresTools && available.toolSupport === "needs_verification" ? "Test tool support in Model providers." : "Choose a compatible model."}</p>}
    {available && <details className="text-xs text-muted-foreground"><summary className="min-h-10 cursor-pointer content-center">Model details</summary><dl className="space-y-2 break-words">
      <div><dt className="font-medium text-foreground">Provider route</dt><dd>{available.connection.providerId} · {available.model.id}</dd></div>
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
          <label className="block space-y-2">Context<select aria-label="Context mode" className="min-h-10 w-full rounded-md border bg-background p-2 font-normal" value={customContext?"custom":"automatic"}
            onChange={event=>{if(event.target.value==="automatic")onChange({...configuration,context:{mode:"automatic"}});else if(canSetContext)onChange({...configuration,context:{maxInputTokens:automaticInput,compactAtTokens:automaticThreshold}});}}>
            <option value="automatic">Automatic</option><option value="custom" disabled={!canSetContext&&!customContext}>Custom limit</option>
          </select></label>
          {customContext?<><label className="block space-y-2">Input context tokens<Input type="number" min={1} max={limits?.maxInputTokens ?? undefined} required {...field("maxInputTokens")} value={customContext.maxInputTokens} onChange={event => onChange({ ...configuration, context: { ...customContext,maxInputTokens:Number(event.target.value) } })} /></label>
          <label className="block space-y-2">Compact at tokens<Input type="number" min={1} max={customContext.maxInputTokens-1} required {...field("compactAtTokens")} value={customContext.compactAtTokens} onChange={event => onChange({ ...configuration, context: { ...customContext,compactAtTokens:Number(event.target.value) } })} /></label></>:null}
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
