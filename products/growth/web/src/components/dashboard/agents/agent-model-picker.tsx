import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AgentModelPicker, type AgentModelOption } from "@kasitek-labs/ui/agent-model-picker";
import type { GrowthAgentCommandOutputs, GrowthAgentFeatureId, GrowthAgentModelSelection } from "@kasitek-labs/contracts";
import { growthAgents } from "@/lib/growth-agents";

type Catalogue = GrowthAgentCommandOutputs["models.list"];
const optionId = (connectionId: string, modelId: string) => JSON.stringify([connectionId,modelId]);
const defaultId = "organization-default";
export function GrowthAgentModelPicker({ featureId, label, scopeKey, canConfigure, disabled, onSaved }: {
  featureId: GrowthAgentFeatureId; label: string; scopeKey: string; canConfigure: boolean; disabled?: boolean; onSaved(): Promise<unknown>;
}) {
  const [open,setOpen] = useState(false), [catalogue,setCatalogue] = useState<Catalogue | null>(null);
  const [selectedId,setSelectedId] = useState(""), [search,setSearch] = useState("");
  const [loading,setLoading] = useState(false), [saving,setSaving] = useState(false), [error,setError] = useState<string | null>(null), [reload,setReload] = useState(0);
  const epoch = useRef(0), mounted = useRef(true), busy = useRef(false);
  const request = useRef<{ signature: string; id: string } | null>(null);
  const invalidate = useCallback(() => { epoch.current++; },[]);
  useEffect(() => { mounted.current=true;return () => { mounted.current=false;invalidate(); }; },[invalidate]);
  useEffect(() => { if(!canConfigure){setOpen(false);setCatalogue(null);setSelectedId("");setError(null);} },[canConfigure]);
  useEffect(() => {
    if (!open || !canConfigure) return;
    const abort = new AbortController(), generation = ++epoch.current;
    setCatalogue(null);setLoading(true);setError(null);setSearch("");setSelectedId("");request.current=null;
    void growthAgents.models(featureId,abort.signal).then(value => {
      if (abort.signal.aborted || generation !== epoch.current) return;
      setCatalogue(value);setSelectedId(value.inherited ? defaultId : value.current ? optionId(value.current.connectionId,value.current.modelId) : "");
    }).catch(cause => { if (!abort.signal.aborted && generation === epoch.current) setError(cause instanceof Error ? cause.message : "Unable to load models."); })
      .finally(() => { if (!abort.signal.aborted && generation === epoch.current) setLoading(false); });
    return () => { invalidate();abort.abort(); };
  },[open,canConfigure,featureId,scopeKey,reload,invalidate]);
  const defaultModel = catalogue?.defaultModel;
  const details = (model: Catalogue["models"][number] | undefined) => model ? {contextWindowTokens:model.contextWindowTokens,maxOutputTokens:model.maxOutputTokens,pricing:model.pricing} : {};
  const options: AgentModelOption[] = catalogue ? [{ id: defaultId, label: defaultModel ? `${defaultModel.label} · Default` : "Default", ...details(defaultModel ?? undefined) },
    ...catalogue.models.map(model => ({id:optionId(model.connectionId,model.modelId),label:model.label,provider:model.provider,...details(model)}))] : [];
  const currentId = catalogue?.current ? optionId(catalogue.current.connectionId,catalogue.current.modelId) : "";
  if (catalogue && !catalogue.inherited && currentId && !options.some(option => option.id === currentId)) options.push({id:currentId,label,disabled:true,reason:"Current model unavailable"});
  const initialId = catalogue?.inherited ? defaultId : currentId;
  async function save() {
    if (busy.current || !catalogue || !canConfigure || !options.some(option => option.id === selectedId && !option.disabled)) return;
    let selection: GrowthAgentModelSelection;
    if (selectedId === defaultId) selection={kind:"organization_default"};
    else {
      const model=catalogue.models.find(model => optionId(model.connectionId,model.modelId) === selectedId);
      if (!model) return;
      selection={kind:"connection",connectionId:model.connectionId,modelId:model.modelId};
    }
    const payload={expectedRevision:catalogue.revision,selection},signature=JSON.stringify(payload);
    if (request.current?.signature !== signature) request.current={signature,id:crypto.randomUUID()};
    busy.current=true;setSaving(true);setError(null);const generation=epoch.current;
    try {
      await growthAgents.selectModel(featureId,payload,request.current.id);
      if (!mounted.current || generation !== epoch.current) return;
      setOpen(false);toast.success("Model updated");
      try { await onSaved(); } catch { if(mounted.current)toast.error("Unable to refresh model settings"); }
    } catch(cause) {
      if (mounted.current && generation === epoch.current) setError(cause instanceof Error ? cause.message : "Unable to save model.");
    } finally { busy.current=false;if(mounted.current)setSaving(false); }
  }
  return <AgentModelPicker label={label} readOnly={!canConfigure} disabled={disabled} open={open && canConfigure}
    onOpenChange={value => { if (!busy.current) setOpen(value); }} options={options} selectedId={selectedId} onSelect={setSelectedId}
    search={search} onSearch={setSearch} loading={loading} saving={saving} error={error} saveDisabled={!catalogue || selectedId === initialId}
    onSave={() => void save()} onReload={() => setReload(value => value+1)} />;
}
