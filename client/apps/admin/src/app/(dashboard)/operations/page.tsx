import { fetchFromCore, requireAdminSession } from "@/lib/admin-auth";
import { AdminMetric, AdminPageHeader } from "@/components/admin/page-header";
import { StatusBadge } from "@/components/admin/status-badge";
import { OperatorReconcileButton } from "@/components/admin/operator-command-button";

type Summary = {
  scope: string;
  generatedAt: string;
  runs: Record<string, number>;
  installations: Record<string, number>;
  definitions: Record<string, number>;
  effects: Array<{ status: string; count: number; reconciliationRequired: boolean }>;
  auditRecords: number;
  estimatedModelCostUsd: string;
};
type Health = { status: string; database?: { status: string; latencyMs: number }; temporal?: { enabled: boolean; mode: string; address?: string; namespace?: string; taskQueue?: string }; model?: { provider: string; model: string; credentialConfigured: boolean } };
type Run = { id: string; organization_id: string; installation_id: string; status: string; trigger_type: string; created_at: string; correlation_id: string };
type Effect = { id: string; organization_id: string; run_id: string; capability: string; status: string; updated_at: string };

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const response = await fetchFromCore(path);
    return response.ok ? await response.json() as T : fallback;
  } catch {
    return fallback;
  }
}

export default async function OperationsPage() {
  await requireAdminSession();
  const [summary, health, runs, effects] = await Promise.all([
    readJson<Summary>("/api/admin/operations/summary", { scope: "platform", generatedAt: "", runs: {}, installations: {}, definitions: {}, effects: [], auditRecords: 0, estimatedModelCostUsd: "0" }),
    readJson<Health>("/api/admin/operations/health", { status: "unavailable" }),
    readJson<{ runs: Run[] }>("/api/admin/operations/runs?limit=12", { runs: [] }),
    readJson<{ effects: Effect[] }>("/api/admin/operations/effects/reconciliation?limit=8", { effects: [] }),
  ]);
  const activeRuns = (summary.runs.running ?? 0) + (summary.runs.awaiting_approval ?? 0) + (summary.runs.awaiting_human ?? 0) + (summary.runs.awaiting_external_event ?? 0);
  const failedRuns = summary.runs.failed ?? 0;
  const activeInstallations = summary.installations.active ?? 0;
  return <div className="admin-page">
    <AdminPageHeader eyebrow="Platform operations" title="Agent operations" description="Safe, platform-scoped health and recovery evidence. Customer secrets, prompts, and provider receipts stay behind the service boundary." />
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <AdminMetric label="Active installations" value={activeInstallations} detail="Across all organizations" tone="info" />
      <AdminMetric label="Runs needing attention" value={activeRuns} detail="Running or awaiting a decision" tone={activeRuns ? "attention" : "default"} />
      <AdminMetric label="Failed runs" value={failedRuns} detail="Durable terminal failures" tone={failedRuns ? "danger" : "default"} />
      <AdminMetric label="Reconciliation" value={effects.effects.length} detail="Ambiguous effects awaiting review" tone={effects.effects.length ? "attention" : "success"} />
      <AdminMetric label="Model cost" value={`$${summary.estimatedModelCostUsd}`} detail="Recorded Agent usage" />
    </section>
    <section className="grid gap-5 lg:grid-cols-[0.8fr_1.2fr]">
      <article className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-5 py-4"><h2 className="text-sm font-semibold text-foreground">Service readiness</h2><p className="mt-1 text-xs text-muted-foreground">Checked by the protected core operator proxy.</p></div>
        <div className="space-y-4 px-5 py-5 text-sm">
          <div className="flex items-center justify-between"><span className="text-muted-foreground">Agent service</span><StatusBadge value={health.status} /></div>
          <div className="flex items-center justify-between"><span className="text-muted-foreground">Database</span><StatusBadge value={health.database?.status ?? "unknown"} /></div>
          <div className="flex items-center justify-between"><span className="text-muted-foreground">Temporal</span><span className="text-foreground">{health.temporal?.enabled ? `${health.temporal.mode} · ${health.temporal.address ?? "configured"}` : "disabled"}</span></div>
          <div className="flex items-center justify-between"><span className="text-muted-foreground">Model credential</span><StatusBadge value={health.model?.credentialConfigured ? "configured" : "missing"} /></div>
        </div>
      </article>
      <article className="rounded-lg border border-border bg-card">
        <div className="border-b border-border px-5 py-4"><h2 className="text-sm font-semibold text-foreground">Effect reconciliation queue</h2><p className="mt-1 text-xs text-muted-foreground">Provider outcome is withheld from this projection; operators see only safe identifiers and state.</p></div>
        {effects.effects.length === 0 ? <p className="px-5 py-10 text-sm text-muted-foreground">No effects currently require reconciliation.</p> : <div className="divide-y divide-border">{effects.effects.map((effect) => <div key={effect.id} className="flex items-center justify-between gap-4 px-5 py-3"><div className="min-w-0"><p className="truncate text-sm font-medium text-foreground">{effect.capability}</p><p className="truncate text-xs text-muted-foreground">{effect.organization_id} · run {effect.run_id}</p></div><div className="flex items-center gap-3"><StatusBadge value={effect.status} /><OperatorReconcileButton effectId={effect.id} /></div></div>)}</div>}
      </article>
    </section>
    <article className="rounded-lg border border-border bg-card">
      <div className="border-b border-border px-5 py-4"><h2 className="text-sm font-semibold text-foreground">Recent platform runs</h2><p className="mt-1 text-xs text-muted-foreground">Organization and correlation identifiers support incident investigation without exposing customer content.</p></div>
      {runs.runs.length === 0 ? <p className="px-5 py-10 text-sm text-muted-foreground">No Agent runs have been recorded.</p> : <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="border-b border-border text-xs text-muted-foreground"><tr><th className="px-5 py-3 font-medium">Run</th><th className="px-5 py-3 font-medium">Organization</th><th className="px-5 py-3 font-medium">Trigger</th><th className="px-5 py-3 font-medium">Status</th><th className="px-5 py-3 font-medium">Created</th></tr></thead><tbody className="divide-y divide-border">{runs.runs.map((run) => <tr key={run.id}><td className="max-w-52 truncate px-5 py-3 font-mono text-xs text-foreground">{run.id}</td><td className="px-5 py-3 text-xs text-muted-foreground">{run.organization_id}</td><td className="px-5 py-3 capitalize text-xs text-muted-foreground">{run.trigger_type}</td><td className="px-5 py-3"><StatusBadge value={run.status} /></td><td className="px-5 py-3 text-xs text-muted-foreground">{new Date(run.created_at).toLocaleString()}</td></tr>)}</tbody></table></div>}
    </article>
  </div>;
}
