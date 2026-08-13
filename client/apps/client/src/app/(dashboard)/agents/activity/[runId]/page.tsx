import Link from "next/link";
import { ArrowLeft, Clock3, ListChecks } from "lucide-react";
import { notFound, redirect } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { getRustSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";
import type { AgentOperationEvent, AgentRun } from "@/lib/agent-platform";
import { AgentRunActions } from "@/components/dashboard/agents/agent-run-actions";

export const metadata = { title: "Agent run | KasiTek" };

function formatValue(value: unknown) {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

export default async function AgentRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");
  const { runId } = await params;
  const response = await fetchRustJson<{ run: AgentRun; events: AgentOperationEvent[] }>(`/api/agents/runs/${encodeURIComponent(runId)}`).catch(() => null);
  if (!response?.run) notFound();
  const { run, events } = response;
  const terminal = ["completed", "failed", "cancelled", "expired"].includes(run.status);

  return (
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1100px] space-y-6">
        <Link href="/agents/activity" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" />Back to activity</Link>
        <Card><CardContent className="space-y-5 p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between"><div><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Agent operation</p><h1 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">{run.agent_name || run.agent_slug || "Agent run"}</h1><p className="mt-2 break-all font-mono text-xs text-muted-foreground">{run.id}</p></div><div className="flex items-center gap-3"><span className={`rounded-full border px-2.5 py-1 text-xs font-medium capitalize ${run.status === "completed" ? "border-accent/30 bg-accent/10 text-accent" : run.status === "failed" ? "border-destructive/30 bg-destructive/10 text-destructive" : "border-status-attention/30 bg-status-attention-soft text-status-attention"}`}>{run.status.replaceAll("_", " ")}</span><AgentRunActions runId={run.id} status={run.status} /></div></div>
          <div className="grid gap-3 text-sm sm:grid-cols-3"><div className="rounded-lg bg-secondary/50 p-3"><p className="text-xs text-muted-foreground">Trigger</p><p className="mt-1 font-medium capitalize text-foreground">{run.trigger_type || "manual"}</p></div><div className="rounded-lg bg-secondary/50 p-3"><p className="text-xs text-muted-foreground">Created</p><p className="mt-1 font-medium text-foreground">{run.created_at ? new Date(run.created_at).toLocaleString() : "Unknown"}</p></div><div className="rounded-lg bg-secondary/50 p-3"><p className="text-xs text-muted-foreground">Finished</p><p className="mt-1 font-medium text-foreground">{run.finished_at ? new Date(run.finished_at).toLocaleString() : terminal ? "Not recorded" : "Still running"}</p></div></div>
          {run.error ? <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4"><p className="text-sm font-semibold text-destructive">Run error</p><pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap text-xs text-destructive">{formatValue(run.error)}</pre></div> : null}
          {run.output ? <div className="rounded-lg border border-border bg-secondary/20 p-4"><p className="text-sm font-semibold text-foreground">Run output</p><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">{formatValue(run.output)}</pre></div> : null}
        </CardContent></Card>
        <Card><CardContent className="p-6"><div className="flex items-center gap-3"><ListChecks className="h-5 w-5 text-primary" /><div><h2 className="text-lg font-semibold text-foreground">Durable timeline</h2><p className="mt-1 text-sm text-muted-foreground">Events are persisted by the Agent Platform and remain available after refresh.</p></div></div>{events.length === 0 ? <p className="mt-5 text-sm text-muted-foreground">No events have been recorded for this run.</p> : <div className="mt-5 space-y-3">{events.map((event, index) => <div key={String(event.id || event.sequence_number || index)} className="flex gap-3 rounded-lg border border-border p-3"><div className="mt-0.5 shrink-0 text-muted-foreground"><Clock3 className="h-4 w-4" /></div><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="font-medium text-foreground">{(event.event_type || "run event").replaceAll(".", " · ")}</p>{event.created_at ? <time className="text-xs text-muted-foreground" dateTime={event.created_at}>{new Date(event.created_at).toLocaleString()}</time> : null}</div>{event.payload ? <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">{formatValue(event.payload)}</pre> : null}</div></div>)}</div>}</CardContent></Card>
      </div>
    </div>
  );
}
