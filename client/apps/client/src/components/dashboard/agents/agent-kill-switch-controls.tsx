"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useConfirmationDialog } from "@/components/ui/confirmation-provider";
import { createAgentKillSwitch, disableAgentKillSwitch, type AgentKillSwitch } from "@/lib/agent-platform";

export function AgentKillSwitchControls({ initial }: { initial: AgentKillSwitch[] }) {
  const router = useRouter();
  const [switches, setSwitches] = useState(initial);
  const [scopeType, setScopeType] = useState<"organization" | "agent" | "installation" | "tool">("organization");
  const [scopeId, setScopeId] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { confirm } = useConfirmationDialog();

  const create = async () => {
    if (busy || !scopeId.trim() || !reason.trim()) return;
    setBusy(true); setError(null);
    try {
      const created = await createAgentKillSwitch({ scopeType, scopeId: scopeId.trim(), reason: reason.trim() });
      setSwitches((current) => [created, ...current.filter((entry) => entry.id !== created.id)]);
      setScopeId(""); setReason("");
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to enable kill switch");
    } finally { setBusy(false); }
  };

  const disable = async (entry: AgentKillSwitch) => {
    if (busy || !await confirm({ title: `Disable ${entry.scope_type} kill switch?`, confirmLabel: "Disable", variant: "destructive" })) return;
    setBusy(true); setError(null);
    try {
      await disableAgentKillSwitch(entry.id);
      setSwitches((current) => current.map((item) => item.id === entry.id ? { ...item, enabled: false, disabled_at: new Date().toISOString() } : item));
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to disable kill switch");
    } finally { setBusy(false); }
  };

  return <section className="mt-8 rounded-xl border border-destructive/30 bg-destructive/5 p-6" aria-labelledby="kill-switch-heading">
    <div><h2 id="kill-switch-heading" className="text-lg font-semibold text-foreground">Execution kill switches</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">Stop new capability execution for this organization or a specific agent, installation, or tool. Existing provider calls are not rolled back.</p></div>
    <div className="mt-4 grid gap-2 sm:grid-cols-[0.8fr_1fr_1.5fr_auto] sm:items-end"><label className="text-xs font-medium text-foreground">Scope<select value={scopeType} onChange={(event) => setScopeType(event.target.value as typeof scopeType)} className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"><option value="organization">Organization</option><option value="agent">Agent</option><option value="installation">Installation</option><option value="tool">Tool</option></select></label><label className="text-xs font-medium text-foreground">Scope ID<input value={scopeId} onChange={(event) => setScopeId(event.target.value)} placeholder={scopeType === "organization" ? "organization id" : `${scopeType} id`} className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" /></label><label className="text-xs font-medium text-foreground">Reason<input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} placeholder="Provider incident or safety pause" className="mt-1 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" /></label><Button type="button" variant="destructive" disabled={busy || !scopeId.trim() || !reason.trim()} onClick={() => void create()}>{busy ? "Saving…" : "Enable"}</Button></div>
    {error ? <p className="mt-3 text-sm text-destructive" role="alert">{error}</p> : null}
    <div className="mt-5 space-y-2">{switches.length ? switches.map((entry) => <div key={entry.id} className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="font-medium capitalize text-foreground">{entry.scope_type} · {entry.scope_id}</p><p className="mt-1 text-xs text-muted-foreground">{entry.reason}{entry.created_at ? ` · ${new Date(entry.created_at).toLocaleString()}` : ""}</p></div><div className="flex items-center gap-2"><span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${entry.enabled ? "border-destructive/30 bg-destructive/10 text-destructive" : "border-border bg-secondary text-muted-foreground"}`}>{entry.enabled ? "Enabled" : "Disabled"}</span>{entry.enabled ? <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void disable(entry)}>Disable</Button> : null}</div></div>) : <p className="text-sm text-muted-foreground">No kill switches configured.</p>}</div>
  </section>;
}
