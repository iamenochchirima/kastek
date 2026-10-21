import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Input } from "@/components/ui/input";
import type { Configuration } from "./api";
import { providerApi, providerError, type CachedProviderModels, type DefaultModel, type ModelProviderConnection, type ProviderModel } from "./model-provider-api";

type Choice = { connection: ModelProviderConnection; model: ProviderModel; available: boolean };
export function AgentModel({ organizationId, agentId, configuration, onChange }: {
  organizationId: string; agentId: string; configuration: Configuration; onChange(value: Configuration): void;
}) {
  const [choices, setChoices] = useState<Choice[]>([]), [defaultModel, setDefaultModel] = useState<DefaultModel | null>(null);
  const [search, setSearch] = useState(""), [loading, setLoading] = useState(true), [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setLoading(true); setError("");
    void Promise.all([providerApi<{ connections: ModelProviderConnection[] }>(organizationId), providerApi<DefaultModel>(organizationId, "/default")])
      .then(async ([list, selection]) => {
        const models = await Promise.allSettled(list.connections.filter(connection => connection.state === "active").map(async connection => {
          const cache = await providerApi<CachedProviderModels>(organizationId, `/${connection.id}/models?agentId=${encodeURIComponent(agentId)}`);
          return (cache.result?.models ?? []).map(model => ({ connection, model, available: cache.result?.kind !== "discovered" || !cache.result.unavailableModelIds?.includes(model.id) }));
        }));
        if (!active) return;
        setDefaultModel(selection); setChoices(models.flatMap(result => result.status === "fulfilled" ? result.value : []));
        if (models.some(result => result.status === "rejected")) setError("Some model lists are unavailable.");
      }).catch(cause => { if (active) setError(providerError(cause)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [organizationId, agentId]);
  const selection = configuration.model.selection ?? { kind: "organization_default" as const };
  const current = JSON.stringify(selection);
  const requiresTools = Boolean(configuration.tools?.length || configuration.connectedToolBindingIds?.length || configuration.skillIds?.length);
  const selectable = choices.filter(choice => choice.available && choice.model.lifecycle !== "retired" && choice.model.inputModalities?.includes("text") && choice.model.outputModalities?.includes("text") && (!requiresTools || choice.model.capabilities.tools.value !== false));
  const filtered = selectable.filter(choice => `${choice.connection.name} ${choice.connection.providerId} ${choice.model.id} ${choice.model.name}`.toLowerCase().includes(search.toLowerCase()));
  const selected = choices.find(choice => selection.kind === "connection" && choice.connection.id === selection.connectionId && choice.model.id === selection.modelId);
  const available = selection.kind === "organization_default" ? choices.find(choice => choice.connection.id === defaultModel?.selection?.connectionId && choice.model.id === defaultModel.selection.modelId) : selected;
  const knownOutputLimit = available?.model.maxOutputTokens.value ?? undefined;
  function update(values: Partial<Configuration["model"]>) { onChange({ ...configuration, model: { ...configuration.model, ...values } }); }
  return <div className="space-y-4">
    <label className="block space-y-2 text-sm font-medium">Model
      <Input aria-label="Search agent models" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search models" />
      <select aria-label="Agent model" className="min-h-10 w-full rounded-md border bg-background p-2 font-normal" value={current} disabled={loading}
        onChange={event => update({ selection: JSON.parse(event.target.value) as Configuration["model"]["selection"] })}>
        <option value={JSON.stringify({ kind: "organization_default" })}>Organization default{defaultModel?.selection ? ` · ${defaultModel.selection.modelId}` : ""}</option>
        {selection.kind === "connection" && !filtered.some(choice => choice.connection.id === selection.connectionId && choice.model.id === selection.modelId) &&
          <option value={current}>{selected?.connection.name ?? "Saved connection"} · {selection.modelId}</option>}
        {filtered.map(choice => <option key={`${choice.connection.id}:${choice.model.id}`} value={JSON.stringify({ kind: "connection", connectionId: choice.connection.id, modelId: choice.model.id })}>
          {choice.connection.name} · {choice.model.name} · {choice.model.id}
        </option>)}
      </select>
    </label>
    {available && (!available.available || available.model.lifecycle === "retired") && <p role="status" className="text-sm text-muted-foreground">Saved model unavailable. Choose another model.</p>}
    {error && <p role="status" className="text-sm text-muted-foreground">{error}</p>}
    {available && requiresTools && (available.model.capabilities.tools.value === null || available.model.capabilities.tools.evidence === "declared") && <p className="text-xs text-muted-foreground">Test this model's tool support before running the agent.</p>}
    <Link to="/app/settings" className="inline-block text-sm underline underline-offset-4">Manage model providers</Link>
    <details className="rounded-md border border-border p-4 text-sm"><summary className="cursor-pointer font-medium">Model limits</summary><div className="mt-4 grid gap-4 sm:grid-cols-2">
      <label className="block space-y-2">Maximum reply tokens<Input type="number" min={1} max={knownOutputLimit} required value={configuration.model.maxOutputTokens} onChange={event => update({ maxOutputTokens: Number(event.target.value) })} /></label>
      <label className="block space-y-2">Call timeout in seconds<Input type="number" min={1} required value={configuration.model.maxDurationSeconds} onChange={event => update({ maxDurationSeconds: Number(event.target.value) })} /></label>
      <label className="block space-y-2">Input context tokens<Input type="number" min={1} required value={configuration.context?.maxInputTokens ?? 8192} onChange={event => onChange({ ...configuration, context: { maxInputTokens: Number(event.target.value), compactAtTokens: configuration.context?.compactAtTokens ?? 6144 } })} /></label>
      <label className="block space-y-2">Compact at tokens<Input type="number" min={1} required value={configuration.context?.compactAtTokens ?? 6144} onChange={event => onChange({ ...configuration, context: { maxInputTokens: configuration.context?.maxInputTokens ?? 8192, compactAtTokens: Number(event.target.value) } })} /></label>
    </div></details>
  </div>;
}
