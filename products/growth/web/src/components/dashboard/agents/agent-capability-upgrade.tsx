import { useCallback, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import type { GrowthAgentCapabilityUpgradeApply, GrowthAgentCapabilityUpgradePreview, GrowthAgentFeatureId } from "@kasitek-labs/contracts";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { growthAgents, GrowthAgentRequestError } from "@/lib/growth-agents";

export function AgentCapabilityUpgrade({ featureId, name, open, onOpenChange, onSaved }: {
  featureId: GrowthAgentFeatureId; name: string; open: boolean; onOpenChange(open: boolean): void; onSaved(): Promise<unknown>;
}) {
  const [preview, setPreview] = useState<GrowthAgentCapabilityUpgradePreview | null>(null);
  const [resolutions, setResolutions] = useState<GrowthAgentCapabilityUpgradeApply["resolutions"]>({});
  const [loading, setLoading] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState<string | null>(null), [stale, setStale] = useState(false);
  const epoch = useRef(0), controller = useRef<AbortController | null>(null), busy = useRef(false), mounted = useRef(true);
  const request = useRef<{signature: string; id: string} | null>(null), id = useId();
  const invalidate = useCallback(() => { epoch.current++; controller.current?.abort(); }, []);
  const refresh = useCallback(async () => {
    if (busy.current) return;
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort; const generation = ++epoch.current;
    setPreview(null); setResolutions({}); setLoading(true); setError(null); setStale(false); request.current = null;
    try {
      const value = await growthAgents.previewCapabilityUpgrade(featureId, abort.signal);
      if (!abort.signal.aborted && epoch.current === generation) setPreview(value);
    } catch (cause) {
      if (!abort.signal.aborted && epoch.current === generation) setError(cause instanceof Error ? cause.message : "Unable to load update.");
    } finally { if (!abort.signal.aborted && epoch.current === generation) setLoading(false); }
  }, [featureId]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; invalidate(); }; }, [invalidate]);
  useEffect(() => {
    if (open) void refresh();
    return invalidate;
  }, [open, refresh, invalidate]);
  const unresolved = preview?.conflicts.some(conflict => !resolutions[conflict.id]) ?? false;
  async function apply() {
    if (busy.current || !preview?.canApply || unresolved || stale) return;
    const payload: GrowthAgentCapabilityUpgradeApply = { targetPublicationDigest: preview.targetPublicationDigest, diffDigest: preview.diffDigest,
      expectedRevisions: preview.expectedRevisions, resolutions: Object.fromEntries(preview.conflicts.map(conflict => [conflict.id, resolutions[conflict.id]!])) };
    const signature = JSON.stringify(payload);
    if (request.current?.signature !== signature) request.current = { signature, id: crypto.randomUUID() };
    const generation = epoch.current; busy.current = true; setSaving(true); setError(null);
    try {
      await growthAgents.applyCapabilityUpgrade(featureId, payload, request.current.id);
      if (!mounted.current || epoch.current !== generation) return;
      onOpenChange(false); toast.success("Capabilities updated");
      try { await onSaved(); } catch { if (mounted.current) toast.error("Unable to refresh agent settings"); }
    } catch (cause) {
      if (!mounted.current || epoch.current !== generation) return;
      if (cause instanceof GrowthAgentRequestError && [401, 403, 404, 409].includes(cause.status)) setStale(true);
      setError(cause instanceof Error ? cause.message : "Unable to apply update.");
    } finally { busy.current = false; if (mounted.current) setSaving(false); }
  }
  return <Dialog open={open} onOpenChange={value => { if (!busy.current) onOpenChange(value); }}><DialogContent className="flex max-h-[85dvh] flex-col sm:max-w-xl">
    <DialogHeader><DialogTitle>Review capability update</DialogTitle><DialogDescription>{name}</DialogDescription></DialogHeader>
    <div className="min-h-0 space-y-5 overflow-y-auto">
      {loading ? <div role="status" aria-label="Loading capability update" className="space-y-3"><Skeleton className="h-20 w-full" /><Skeleton className="h-20 w-full" /></div> : null}
      {preview ? <>
        {preview.features.map(feature => <section key={feature.featureId} className="space-y-2"><h3 className="text-sm font-medium">{feature.name}{!feature.enabled ? <span className="ml-2 text-xs text-muted-foreground">Disabled</span> : null}</h3>
          {feature.changes.length ? <ul className="divide-y rounded-md border px-3">{feature.changes.map(change => <li key={change.id} className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1 py-2 text-sm"><span className="w-14 shrink-0 text-xs text-muted-foreground">{{add:"Add",remove:"Remove",change:"Change"}[change.action]}</span><div className="min-w-0 flex-1 break-words">{change.label}{change.before || change.after ? change.kind === "operation" ? <p className="mt-0.5 text-xs text-muted-foreground">{change.before ?? "None"} → {change.after ?? "None"}</p> : <details className="mt-0.5 text-xs text-muted-foreground"><summary className="min-h-9 cursor-pointer py-2">Technical details</summary><p className="break-all">{change.before ?? "None"} → {change.after ?? "None"}</p></details> : null}</div></li>)}</ul> : <p className="text-sm text-muted-foreground">Up to date</p>}
          {feature.preserved.length ? <details className="text-xs text-muted-foreground"><summary className="min-h-9 cursor-pointer py-2">Preserved settings</summary><ul className="list-disc space-y-1 pl-4">{feature.preserved.map(setting => <li key={setting}>{setting}</li>)}</ul></details> : null}
        </section>)}
        {preview.conflicts.length ? <section className="space-y-3"><h3 className="text-sm font-medium">Conflicts</h3>{preview.conflicts.map((conflict,index) => <div key={conflict.id} className="space-y-2"><label className="block text-sm" htmlFor={`${id}-${index}`}>{preview.features.find(feature => feature.featureId === conflict.featureId)?.name}: {conflict.label}</label><Select value={resolutions[conflict.id] ?? ""} onValueChange={value => setResolutions(previous => ({...previous,[conflict.id]:value as "keep_current"|"use_update"}))} disabled={saving}><SelectTrigger id={`${id}-${index}`} className="min-h-11"><SelectValue placeholder="Choose" /></SelectTrigger><SelectContent><SelectItem value="keep_current">Keep current</SelectItem><SelectItem value="use_update">Use update</SelectItem></SelectContent></Select></div>)}</section> : null}
        {preview.unavailable.length ? <ul role="alert" className="space-y-2 text-sm text-destructive">{preview.unavailable.map((item,index) => <li key={`${item.code}:${index}`}>{item.message}</li>)}</ul> : null}
      </> : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </div>
    <DialogFooter className="shrink-0"><Button type="button" variant="ghost" className="min-h-11 sm:min-h-9" disabled={saving || loading} onClick={() => void refresh()}>Refresh</Button><Button type="button" variant="outline" className="min-h-11 sm:min-h-9" disabled={saving} onClick={() => onOpenChange(false)}>Cancel</Button><Button type="button" className="min-h-11 sm:min-h-9" disabled={loading || saving || !preview?.canApply || unresolved || stale} onClick={() => void apply()}>{saving ? "Applying…" : "Apply update"}</Button></DialogFooter>
  </DialogContent></Dialog>;
}
