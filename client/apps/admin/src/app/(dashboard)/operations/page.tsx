import { fetchFromCore, requireAdminSession } from "@/lib/admin-auth";
import { AdminMetric, AdminPageHeader } from "@/components/admin/page-header";
import { StatusBadge } from "@/components/admin/status-badge";
import { OperatorDeliveryReplayButton, OperatorInstallationButton, OperatorReconcileButton, OperatorRetryButton } from "@/components/admin/operator-command-button";
import { SupportAccessPanel } from "@/components/admin/support-access-panel";
import { ProjectionRebuildButton } from "@/components/admin/projection-rebuild-button";
import { OperatorSearch } from "@/components/admin/operator-search";
import { OperatorNotifications } from "@/components/admin/operator-notifications";
import { OperatorRunbooks } from "@/components/admin/operator-runbooks";

type Summary = {
  scope: string;
  generatedAt: string;
  runs: Record<string, number>;
  installations: Record<string, number>;
  definitions: Record<string, number>;
  effects: Array<{ status: string; count: number; reconciliationRequired: boolean }>;
  auditRecords: number;
  estimatedModelCostUsd: string;
  conversations?: number;
  channels?: number;
  approvals?: Record<string, number>;
};
type Health = { status: string; database?: { status: string; latencyMs: number }; temporal?: { enabled: boolean; mode: string; address?: string; namespace?: string; taskQueue?: string }; model?: { provider: string; model: string; credentialConfigured: boolean } };
type Run = { id: string; organization_id: string; installation_id: string; status: string; trigger_type: string; created_at: string; correlation_id: string };
type Effect = { id: string; organization_id: string; run_id: string; capability: string; status: string; updated_at: string };
type Grant = { id: string; adminId: string; organizationId: string; resourceType: string; resourceId?: string | null; reason: string; expiresAt: string; revokedAt?: string | null };
type Projection = { projectionKey: string; revision: number; payload: Record<string, unknown>; updatedAt: string };
type FailedDeliveryAttempt = { id: string; organizationId: string; status: "failed" | "unknown"; attemptNumber: number; createdAt: string };
type Notification = { id: string; eventKey: string; severity: string; kind: string; title: string; body: string; status: string; createdAt: string };
type AuditRecord = { id: string; organization_id?: string | null; actor_type: string; actor_id?: string | null; action: string; resource_type: string; resource_id: string; correlation_id?: string | null; created_at: string };

function countValue(payload: Record<string, unknown>, key: string): number {
  const value = payload[key];
  return typeof value === "number" ? value : 0;
}

function countEntries(value: unknown): Array<[string, number]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).map(([key, entry]) => [key, typeof entry === "number" ? entry : 0]);
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    const response = await fetchFromCore(path);
    return response.ok ? await response.json() as T : fallback;
  } catch {
    return fallback;
  }
}

export default async function OperationsPage() {
  const admin = await requireAdminSession();
  const [summary, health, runs, effects, grants, alerts, runHealth, deliveryHealth, providerWorkers, usageCost, projectionLag, audit, notifications] = await Promise.all([
    readJson<Summary>("/api/admin/operations/summary", { scope: "platform", generatedAt: "", runs: {}, installations: {}, definitions: {}, effects: [], auditRecords: 0, estimatedModelCostUsd: "0" }),
    readJson<Health>("/api/admin/operations/health", { status: "unavailable" }),
    readJson<{ runs: Run[] }>("/api/admin/operations/runs?limit=12", { runs: [] }),
    readJson<{ effects: Effect[] }>("/api/admin/operations/effects/reconciliation?limit=8", { effects: [] }),
    readJson<{ grants: Grant[] }>("/api/admin/operations/support-grants", { grants: [] }),
    readJson<Projection>("/api/admin/operations/projections/alerts", { projectionKey: "alerts", revision: 0, payload: {}, updatedAt: "" }),
    readJson<Projection>("/api/admin/operations/projections/run_health", { projectionKey: "run_health", revision: 0, payload: {}, updatedAt: "" }),
    readJson<Projection>("/api/admin/operations/projections/delivery_health", { projectionKey: "delivery_health", revision: 0, payload: {}, updatedAt: "" }),
    readJson<Projection>("/api/admin/operations/projections/provider_workers", { projectionKey: "provider_workers", revision: 0, payload: {}, updatedAt: "" }),
    readJson<Projection>("/api/admin/operations/projections/usage_cost", { projectionKey: "usage_cost", revision: 0, payload: {}, updatedAt: "" }),
    readJson<Projection>("/api/admin/operations/projections/projection_lag", { projectionKey: "projection_lag", revision: 0, payload: {}, updatedAt: "" }),
    readJson<{ records: AuditRecord[] }>("/api/admin/operations/audit?limit=12", { records: [] }),
    readJson<{ notifications: Notification[] }>("/api/admin/operations/notifications", { notifications: [] }),
  ]);
  const activeRuns = (summary.runs.running ?? 0) + (summary.runs.awaiting_approval ?? 0) + (summary.runs.awaiting_human ?? 0) + (summary.runs.awaiting_external_event ?? 0);
  const failedRuns = summary.runs.failed ?? 0;
  const activeInstallations = summary.installations.active ?? 0;
  const canCommand = ["operator", "admin", "superadmin", "owner"].includes(admin.role.toLowerCase());
  const runStatusEntries = countEntries(runHealth.payload.runs);
  const deliveryStatusEntries = countEntries(deliveryHealth.payload.deliveries);
  const failedDeliveryAttempts = Array.isArray(deliveryHealth.payload.failedAttempts) ? deliveryHealth.payload.failedAttempts as FailedDeliveryAttempt[] : [];
  const providerEntries = countEntries(providerWorkers.payload.providers);
  const projectionEntries = Array.isArray(projectionLag.payload.projections) ? projectionLag.payload.projections as Array<{ projectionKey?: string; ageSeconds?: number }> : [];
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
    <section className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4"><div><h2 className="text-sm font-semibold text-foreground">Rebuildable operator projections</h2><p className="mt-1 text-xs text-muted-foreground">Snapshots are generated by Agent Platform and can be rebuilt after a dependency recovery.</p></div>{["operator", "admin", "superadmin", "owner"].includes(admin.role.toLowerCase()) ? <ProjectionRebuildButton /> : <span className="text-xs text-muted-foreground">Read-only</span>}</div>
      <div className="grid gap-3 p-5 sm:grid-cols-3"><div className="rounded-md border border-border bg-background p-3"><p className="text-xs text-muted-foreground">Projection revision</p><p className="mt-1 text-lg font-semibold text-foreground">{alerts.revision || "Not built"}</p></div><div className="rounded-md border border-border bg-background p-3"><p className="text-xs text-muted-foreground">Alerts requiring attention</p><p className="mt-1 text-lg font-semibold text-foreground">{String(alerts.payload.reconciliationRequired ?? 0)}</p></div><div className="rounded-md border border-border bg-background p-3"><p className="text-xs text-muted-foreground">Last rebuilt</p><p className="mt-1 text-sm text-foreground">{alerts.updatedAt ? new Date(alerts.updatedAt).toLocaleString() : "Not built"}</p></div></div>
    </section>
    <section className="grid gap-5 lg:grid-cols-2">
      <article className="rounded-lg border border-border bg-card"><div className="border-b border-border px-5 py-4"><h2 className="text-sm font-semibold text-foreground">Organizations and agents</h2><p className="mt-1 text-xs text-muted-foreground">Safe counts across platform workspaces; no customer content is included.</p></div><div className="grid gap-3 p-5 sm:grid-cols-2"><div><p className="text-xs text-muted-foreground">Agent definitions</p>{Object.entries(summary.definitions).map(([status, count]) => <div key={status} className="mt-1 flex justify-between text-sm"><span className="capitalize text-foreground">{status}</span><span className="text-muted-foreground">{count}</span></div>)}</div><div><p className="text-xs text-muted-foreground">Installations</p>{Object.entries(summary.installations).map(([status, count]) => <div key={status} className="mt-1 flex justify-between text-sm"><span className="capitalize text-foreground">{status}</span><span className="text-muted-foreground">{count}</span></div>)}</div></div></article>
      <article className="rounded-lg border border-border bg-card"><div className="border-b border-border px-5 py-4"><h2 className="text-sm font-semibold text-foreground">Runs and workflows</h2><p className="mt-1 text-xs text-muted-foreground">Run-health read model with durable state counts.</p></div><div className="grid gap-2 p-5 sm:grid-cols-2">{runStatusEntries.length ? runStatusEntries.map(([status, count]) => <div key={status} className="flex justify-between rounded-md border border-border bg-background px-3 py-2 text-sm"><span className="capitalize text-foreground">{status.replaceAll("_", " ")}</span><span className="text-muted-foreground">{count}</span></div>) : <p className="text-sm text-muted-foreground">Projection not built.</p>}</div></article>
      <article className="rounded-lg border border-border bg-card"><div className="border-b border-border px-5 py-4"><h2 className="text-sm font-semibold text-foreground">Channels and deliveries</h2><p className="mt-1 text-xs text-muted-foreground">Delivery status only; message bodies and provider receipts remain excluded.</p></div><div className="grid gap-2 p-5 sm:grid-cols-2">{deliveryStatusEntries.length ? deliveryStatusEntries.map(([status, count]) => <div key={status} className="flex justify-between rounded-md border border-border bg-background px-3 py-2 text-sm"><span className="capitalize text-foreground">{status}</span><span className="text-muted-foreground">{count}</span></div>) : <p className="text-sm text-muted-foreground">Projection not built.</p>}</div>{failedDeliveryAttempts.length ? <div className="border-t border-border px-5 py-4"><p className="mb-3 text-xs font-medium text-foreground">Failed attempts awaiting recovery</p><div className="space-y-2">{failedDeliveryAttempts.slice(0, 8).map((attempt) => <div key={attempt.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-background px-3 py-2"><div className="min-w-0"><p className="truncate font-mono text-[11px] text-foreground">{attempt.id}</p><p className="text-[11px] text-muted-foreground">{attempt.organizationId} · attempt {attempt.attemptNumber} · {attempt.status}</p></div>{canCommand ? <OperatorDeliveryReplayButton attemptId={attempt.id} status={attempt.status} /> : <span className="text-xs text-muted-foreground">Read-only</span>}</div>)}</div></div> : null}</article>
      <article className="rounded-lg border border-border bg-card"><div className="border-b border-border px-5 py-4"><h2 className="text-sm font-semibold text-foreground">Conversations and channels</h2><p className="mt-1 text-xs text-muted-foreground">Counts and delivery states only; conversation content remains support-grant protected.</p></div><div className="grid gap-3 p-5 sm:grid-cols-2"><div><p className="text-xs text-muted-foreground">Conversations</p><p className="mt-1 text-lg font-semibold text-foreground">{summary.conversations ?? 0}</p></div><div><p className="text-xs text-muted-foreground">Active channels</p><p className="mt-1 text-lg font-semibold text-foreground">{summary.channels ?? 0}</p></div></div><div className="grid gap-2 border-t border-border p-5 sm:grid-cols-2">{deliveryStatusEntries.map(([status, count]) => <div key={status} className="flex justify-between text-xs"><span className="capitalize text-muted-foreground">{status}</span><span className="text-foreground">{count}</span></div>)}</div></article>
      <article className="rounded-lg border border-border bg-card"><div className="border-b border-border px-5 py-4"><h2 className="text-sm font-semibold text-foreground">Approvals and effects</h2><p className="mt-1 text-xs text-muted-foreground">Approval state counts and the protected reconciliation queue.</p></div><div className="grid gap-2 p-5 sm:grid-cols-2">{Object.entries(summary.approvals ?? {}).map(([status, count]) => <div key={status} className="flex justify-between rounded-md border border-border bg-background px-3 py-2 text-sm"><span className="capitalize text-foreground">{status}</span><span className="text-muted-foreground">{count}</span></div>)}<div className="flex justify-between rounded-md border border-border bg-background px-3 py-2 text-sm"><span className="text-foreground">Reconciliation</span><span className="text-muted-foreground">{effects.effects.length}</span></div></div></article>
      <article className="rounded-lg border border-border bg-card"><div className="border-b border-border px-5 py-4"><h2 className="text-sm font-semibold text-foreground">Providers and workers</h2><p className="mt-1 text-xs text-muted-foreground">Provider model-call states and effect worker states.</p></div><div className="space-y-2 p-5">{providerEntries.length ? providerEntries.map(([provider, count]) => <div key={provider} className="flex justify-between rounded-md border border-border bg-background px-3 py-2 text-sm"><span className="text-foreground">{provider}</span><span className="text-muted-foreground">{count}</span></div>) : <p className="text-sm text-muted-foreground">Provider projection not built.</p>}<div className="mt-3 flex justify-between text-xs text-muted-foreground"><span>Effects executing</span><span>{countValue(providerWorkers.payload.effects as Record<string, unknown>, "executing")}</span></div><div className="flex justify-between text-xs text-muted-foreground"><span>Effects unknown</span><span>{countValue(providerWorkers.payload.effects as Record<string, unknown>, "unknown")}</span></div></div></article>
      <article className="rounded-lg border border-border bg-card"><div className="border-b border-border px-5 py-4"><h2 className="text-sm font-semibold text-foreground">Usage and cost</h2><p className="mt-1 text-xs text-muted-foreground">Recorded model usage from the rebuildable usage projection.</p></div><div className="grid gap-3 p-5 sm:grid-cols-3"><div><p className="text-xs text-muted-foreground">Model calls</p><p className="mt-1 text-lg font-semibold text-foreground">{countValue(usageCost.payload, "modelCalls")}</p></div><div><p className="text-xs text-muted-foreground">Tokens</p><p className="mt-1 text-lg font-semibold text-foreground">{countValue(usageCost.payload, "totalTokens")}</p></div><div><p className="text-xs text-muted-foreground">Estimated cost</p><p className="mt-1 text-lg font-semibold text-foreground">${String(usageCost.payload.estimatedCostUsd ?? "0")}</p></div></div></article>
      <article className="rounded-lg border border-border bg-card"><div className="border-b border-border px-5 py-4"><h2 className="text-sm font-semibold text-foreground">Queues and projection lag</h2><p className="mt-1 text-xs text-muted-foreground">Readiness and age indicators for rebuildable operator state.</p></div><div className="space-y-2 p-5">{projectionEntries.length ? projectionEntries.map((entry) => <div key={entry.projectionKey} className="flex justify-between text-sm"><span className="text-foreground">{entry.projectionKey}</span><span className="text-muted-foreground">{entry.ageSeconds ?? 0}s old</span></div>) : <p className="text-sm text-muted-foreground">Projection lag is not available.</p>}</div></article>
    </section>
    <OperatorSearch />
    <OperatorNotifications initialNotifications={notifications.notifications} />
    <OperatorRunbooks />
    <section className="rounded-lg border border-border bg-card">
      <div className="border-b border-border px-5 py-4"><h2 className="text-sm font-semibold text-foreground">Support access</h2><p className="mt-1 text-xs text-muted-foreground">Customer content access requires a short-lived, organization or resource-scoped grant. Secrets, prompts, and tokens remain prohibited.</p></div>
      <div className="p-5"><SupportAccessPanel initialGrants={grants.grants} adminId={admin.id} canManage={["admin", "superadmin", "owner"].includes(admin.role.toLowerCase())} /></div>
    </section>
    <section className="rounded-lg border border-border bg-card"><div className="border-b border-border px-5 py-4"><h2 className="text-sm font-semibold text-foreground">Audit and security</h2><p className="mt-1 text-xs text-muted-foreground">Recent redacted operator records with stable correlation identifiers.</p></div>{audit.records.length === 0 ? <p className="px-5 py-8 text-sm text-muted-foreground">No audit records available.</p> : <div className="divide-y divide-border">{audit.records.map((record) => <div key={record.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3"><div><p className="text-sm text-foreground">{record.action}</p><p className="text-xs text-muted-foreground">{record.resource_type} · {record.resource_id} · actor {record.actor_id ?? "system"}</p></div><span className="text-xs text-muted-foreground">{new Date(record.created_at).toLocaleString()}</span></div>)}</div>}</section>
    <article className="rounded-lg border border-border bg-card">
      <div className="border-b border-border px-5 py-4"><h2 className="text-sm font-semibold text-foreground">Recent platform runs</h2><p className="mt-1 text-xs text-muted-foreground">Organization and correlation identifiers support incident investigation without exposing customer content.</p></div>
      {runs.runs.length === 0 ? <p className="px-5 py-10 text-sm text-muted-foreground">No Agent runs have been recorded.</p> : <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="border-b border-border text-xs text-muted-foreground"><tr><th className="px-5 py-3 font-medium">Run</th><th className="px-5 py-3 font-medium">Organization</th><th className="px-5 py-3 font-medium">Trigger</th><th className="px-5 py-3 font-medium">Status</th><th className="px-5 py-3 font-medium">Created</th><th className="px-5 py-3 font-medium">Actions</th></tr></thead><tbody className="divide-y divide-border">{runs.runs.map((run) => <tr key={run.id}><td className="max-w-52 truncate px-5 py-3 font-mono text-xs text-foreground">{run.id}</td><td className="px-5 py-3 text-xs text-muted-foreground">{run.organization_id}</td><td className="px-5 py-3 capitalize text-xs text-muted-foreground">{run.trigger_type}</td><td className="px-5 py-3"><StatusBadge value={run.status} /></td><td className="px-5 py-3 text-xs text-muted-foreground">{new Date(run.created_at).toLocaleString()}</td><td className="px-5 py-3">{canCommand ? <div className="flex flex-col items-end gap-2">{["failed", "cancelled", "expired"].includes(run.status) ? <OperatorRetryButton runId={run.id} /> : null}<OperatorInstallationButton installationId={run.installation_id} action="suspend" /></div> : <span className="text-xs text-muted-foreground">Read-only</span>}</td></tr>)}</tbody></table></div>}
    </article>
  </div>;
}
