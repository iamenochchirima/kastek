import { History } from "lucide-react";
import { getRustSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";
import { redirect } from "next/navigation";

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

export default async function AgentActivityPage() {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");
  const [audit, summary] = await Promise.all([
    fetchRustJson<{ records: AuditRecord[] }>("/api/agents/audit?limit=100").catch(() => ({ records: [] })),
    fetchRustJson<OperationsSummary>("/api/agents/operations/summary").catch(() => ({ runs: { runsByStatus: [], oldestQueuedAt: null } })),
  ]);
  const totalRuns = summary.runs.runsByStatus.reduce((total, entry) => total + entry.count, 0);

  return (
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1400px]">
        <header className="max-w-3xl">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Automation</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight text-foreground">Agent activity</h1>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">Recent Agent Platform changes and durable run status for this workspace.</p>
        </header>
        <section className="mt-8 grid gap-4 sm:grid-cols-3">
          <article className="rounded-xl border border-border bg-card p-5"><p className="text-sm text-muted-foreground">Recorded runs</p><p className="mt-3 text-3xl font-semibold text-foreground">{totalRuns}</p></article>
          <article className="rounded-xl border border-border bg-card p-5"><p className="text-sm text-muted-foreground">Audit records</p><p className="mt-3 text-3xl font-semibold text-foreground">{audit.records.length}</p></article>
          <article className="rounded-xl border border-border bg-card p-5"><p className="text-sm text-muted-foreground">Oldest queued run</p><p className="mt-3 text-sm font-medium text-foreground">{summary.runs.oldestQueuedAt ? new Date(summary.runs.oldestQueuedAt).toLocaleString() : "None"}</p></article>
        </section>
        <section className="mt-8 rounded-xl border border-border bg-card p-6">
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
      </div>
    </div>
  );
}
