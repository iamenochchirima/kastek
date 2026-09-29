import Link from "next/link";
import { History, ListChecks, ShieldAlert } from "lucide-react";
import { getRustSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";
import type { AgentEffectReceipt, AgentKillSwitch, AgentOperationRun } from "@/lib/agent-platform";
import { AgentKillSwitchControls } from "@/components/dashboard/agents/agent-kill-switch-controls";
import { AgentReconciliationActions } from "@/components/dashboard/agents/agent-reconciliation-actions";
import { PageHeader, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "@/components/ui/page-header";
import { redirect } from "next/navigation";
import { MotionReveal } from "@/components/ui/motion-reveal";

export const metadata = { title: "Agent Activity | KasiTek" };

type AuditRecord = {
  id: string;
  action: string;
  resource_type: string;
  resource_id: string;
  actor_type: string;
  created_at: string;
  metadata: Record<string, unknown>;
};

type OperationsSummary = {
  runs: { runsByStatus: Array<{ status: string; count: number }>; oldestQueuedAt: string | null };
};

type OperationsHealth = {
  status: string;
  database: { status: string; latencyMs?: number };
  temporal: { enabled: boolean; mode?: string; namespace?: string; taskQueue?: string };
  model: { provider: string; model: string; credentialConfigured: boolean };
};

export default async function AgentActivityPage() {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");
  const [audit, summary, health, operations, reconciliation, killSwitches] = await Promise.all([
    fetchRustJson<{ records: AuditRecord[] }>("/api/agents/audit?limit=100").catch(() => ({ records: [] })),
    fetchRustJson<OperationsSummary>("/api/agents/operations/summary").catch(() => ({ runs: { runsByStatus: [], oldestQueuedAt: null } })),
    fetchRustJson<OperationsHealth>("/api/agents/operations/health").catch((): OperationsHealth => ({ status: "unavailable", database: { status: "unavailable" }, temporal: { enabled: false }, model: { provider: "unknown", model: "unknown", credentialConfigured: false } })),
    fetchRustJson<{ runs: AgentOperationRun[] }>("/api/agents/operations/runs?limit=100").catch(() => ({ runs: [] })),
    fetchRustJson<{ effects: AgentEffectReceipt[] }>("/api/agents/operations/effects/reconciliation?limit=100").catch(() => ({ effects: [] })),
    fetchRustJson<{ killSwitches: AgentKillSwitch[] }>("/api/agents/operations/kill-switches").catch(() => ({ killSwitches: [] })),
  ]);
  const totalRuns = summary.runs.runsByStatus.reduce((total, entry) => total + entry.count, 0);

  return (
    <div className="min-h-[100dvh] p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-[1440px]">
        <PageHeader className="max-w-3xl">
          <PageHeaderContent>
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Automation</p>
          <PageHeaderTitle>Agent activity</PageHeaderTitle>
          <PageHeaderDescription>Recent agent runs and recovery actions.</PageHeaderDescription>
          </PageHeaderContent>
        </PageHeader>
        <MotionReveal delay={0.08}>
        <section className="mt-8 grid gap-4 sm:grid-cols-3">
          <article className="rounded-xl border border-border bg-card p-5"><p className="text-sm text-muted-foreground">Recorded runs</p><p className="mt-3 text-3xl font-semibold text-foreground">{totalRuns}</p></article>
          <article className="rounded-xl border border-border bg-card p-5"><p className="text-sm text-muted-foreground">Audit records</p><p className="mt-3 text-3xl font-semibold text-foreground">{audit.records.length}</p></article>
          <article className="rounded-xl border border-border bg-card p-5"><p className="text-sm text-muted-foreground">Oldest queued run</p><p className="mt-3 text-sm font-medium text-foreground">{summary.runs.oldestQueuedAt ? new Date(summary.runs.oldestQueuedAt).toLocaleString() : "None"}</p></article>
        </section>
        </MotionReveal>
        <MotionReveal delay={0.16}>
        <section className="mt-8 rounded-xl border border-border bg-card p-5 sm:p-6" aria-labelledby="recent-runs-heading">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-3"><ListChecks className="h-5 w-5 text-primary" /><div><h2 id="recent-runs-heading" className="text-lg font-semibold text-foreground">Recent runs</h2><p className="mt-1 text-sm text-muted-foreground">Open a run to inspect its durable timeline, output, and recovery actions.</p></div></div>
            <span className="text-xs text-muted-foreground">{operations.runs.length} shown</span>
          </div>
          {operations.runs.length === 0 ? (
            <p className="mt-5 text-sm text-muted-foreground">No Agent Platform runs have been recorded for this workspace.</p>
          ) : (
            <div className="mt-5 divide-y divide-border">
              {operations.runs.map((run) => (
                <Link key={run.id} href={`/agents/activity/${encodeURIComponent(run.id)}`} className="flex flex-col gap-2 py-4 transition-colors first:pt-0 last:pb-0 hover:bg-secondary/30 sm:flex-row sm:items-center sm:justify-between sm:px-2">
                  <div className="min-w-0"><p className="truncate font-medium text-foreground">{run.agent_name || run.agent_slug || "Agent run"}</p><p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">{run.id}</p><p className="mt-1 text-xs text-muted-foreground">{run.trigger_type || "manual"}{run.created_at ? ` · ${new Date(run.created_at).toLocaleString()}` : ""}</p>{run.error?.message ? <p className="mt-1 text-xs text-destructive">{run.error.message}</p> : null}</div>
                  <span className={`w-fit rounded-full border px-2.5 py-1 text-xs font-medium capitalize ${run.status === "completed" ? "border-status-success/30 bg-status-success-soft text-status-success" : run.status === "failed" ? "border-destructive/30 bg-destructive/10 text-destructive" : run.status === "cancelled" ? "border-border bg-secondary text-muted-foreground" : "border-status-attention/30 bg-status-attention-soft text-status-attention"}`}>{run.status.replaceAll("_", " ")}</span>
                </Link>
              ))}
            </div>
          )}
        </section>
        </MotionReveal>
        <MotionReveal delay={0.24}>
        <section className="mt-8 rounded-xl border border-status-attention/40 bg-status-attention-soft p-5 sm:p-6" aria-labelledby="reconciliation-heading">
          <div className="flex items-start gap-3"><ShieldAlert className="mt-0.5 h-5 w-5 text-status-attention" /><div><h2 id="reconciliation-heading" className="text-lg font-semibold text-foreground">Effects needing reconciliation</h2><p className="mt-1 text-sm leading-6 text-muted-foreground">These provider calls may have reached an external system without a recorded terminal result. Resolve each one after checking the provider; the decision is audited and cannot be changed twice.</p></div><span className="ml-auto rounded-full border border-status-attention/40 px-2.5 py-1 text-xs font-medium text-status-attention">{reconciliation.effects.length}</span></div>
          {reconciliation.effects.length ? <div className="mt-5 space-y-3">{reconciliation.effects.map((effect) => <div key={effect.id} className="rounded-lg border border-status-attention/30 bg-card p-4"><div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div className="min-w-0"><p className="break-all font-medium text-foreground">{effect.capability || "External effect"}</p><p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{effect.id}{effect.run_id ? ` · run ${effect.run_id}` : ""}</p><p className="mt-1 text-xs text-muted-foreground">Status: {effect.status}{effect.updated_at ? ` · updated ${new Date(effect.updated_at).toLocaleString()}` : ""}</p></div><AgentReconciliationActions effect={effect} /></div></div>)}</div> : <p className="mt-5 text-sm text-muted-foreground">No provider effects are waiting for reconciliation.</p>}
        </section>
        </MotionReveal>
        <AgentKillSwitchControls initial={killSwitches.killSwitches} />
        <MotionReveal delay={0.32}>
        <section className="mt-8 rounded-xl border border-border bg-card p-5 sm:p-6">
          <div className="flex items-center gap-3"><History className="h-5 w-5 text-primary" /><h2 className="text-lg font-semibold text-foreground">Audit timeline</h2></div>
          {audit.records.length === 0 ? (
            <p className="mt-5 text-sm text-muted-foreground">No Agent Platform activity has been recorded yet.</p>
          ) : (
            <div className="mt-5 divide-y divide-border">
              {audit.records.map((record) => (
                <div key={record.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                  <div><p className="font-medium text-foreground">{record.action}</p><p className="text-xs text-muted-foreground">{record.resource_type} · {record.resource_id} · {record.actor_type}</p></div>
                  <time className="text-xs text-muted-foreground" dateTime={record.created_at}>{new Date(record.created_at).toLocaleString()}</time>
                </div>
              ))}
            </div>
          )}
        </section>
        </MotionReveal>
        <MotionReveal delay={0.4}>
        <section className="mt-6 rounded-xl border border-border bg-card p-5 sm:p-6" aria-labelledby="agent-health-heading">
          <div className="flex items-center justify-between gap-4"><div><h2 id="agent-health-heading" className="text-lg font-semibold text-foreground">Runtime health</h2><p className="mt-1 text-sm text-muted-foreground">Dependency status for the Agent Platform serving this workspace.</p></div><span className="rounded-full border border-border px-2.5 py-1 text-xs font-medium capitalize text-foreground">{health.status}</span></div>
          <div className="mt-5 grid gap-4 sm:grid-cols-3">
            <div><p className="text-xs text-muted-foreground">Database</p><p className="mt-1 text-sm font-medium text-foreground">{health.database.status}{health.database.latencyMs !== undefined ? ` · ${health.database.latencyMs}ms` : ""}</p></div>
            <div><p className="text-xs text-muted-foreground">Temporal</p><p className="mt-1 text-sm font-medium text-foreground">{health.temporal.enabled ? `${health.temporal.mode ?? "configured"} · ${health.temporal.taskQueue ?? "task queue pending"}` : "Disabled locally"}</p></div>
            <div><p className="text-xs text-muted-foreground">Model provider</p><p className="mt-1 text-sm font-medium text-foreground">{health.model.provider} · {health.model.credentialConfigured ? "credential configured" : "credential missing"}</p></div>
          </div>
        </section>
        </MotionReveal>
      </div>
    </div>
  );
}
