import { Activity, ChartColumn, Coins, Wrench } from "lucide-react";
import { getSession } from "@/lib/session";
import { fetchApiJson } from "@/lib/api-client";
import { redirect } from "@/lib/navigation";
import { PageHeader, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "@/components/ui/page-header";
import { MotionReveal } from "@/components/ui/motion-reveal";

export const metadata = { title: "Agent Analytics | KasiTek" };

type OperationsSummary = {
  runs: { runsByStatus: Array<{ status: string; count: number }>; oldestQueuedAt: string | null };
  models: { inputTokens: number; outputTokens: number; totalTokens: number; estimatedCostUsd: number; failedCalls: number };
  tools: Array<{ status: string; count: number }>;
};

export default async function AgentAnalyticsPage() {
  const session = await getSession();
  if (!session?.user?.id) redirect("/login");
  const summary = await fetchApiJson<OperationsSummary>("/api/agents/operations/summary").catch(() => ({
    runs: { runsByStatus: [], oldestQueuedAt: null },
    models: { inputTokens: 0, outputTokens: 0, totalTokens: 0, estimatedCostUsd: 0, failedCalls: 0 },
    tools: [],
  }));
  const runCount = summary.runs.runsByStatus.reduce((total, entry) => total + entry.count, 0);
  const completedRuns = summary.runs.runsByStatus.find((entry) => entry.status === "completed")?.count ?? 0;
  const failedRuns = summary.runs.runsByStatus.find((entry) => entry.status === "failed")?.count ?? 0;
  const toolCalls = summary.tools.reduce((total, entry) => total + entry.count, 0);
  const metrics = [
    { label: "Total runs", value: runCount, icon: Activity },
    { label: "Completed runs", value: completedRuns, icon: ChartColumn },
    { label: "Failed runs", value: failedRuns, icon: Activity },
    { label: "Estimated model cost", value: `$${summary.models.estimatedCostUsd.toFixed(4)}`, icon: Coins },
  ];

  return (
    <div className="min-h-[100dvh] p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-[1440px]">
        <PageHeader className="max-w-3xl">
          <PageHeaderContent>
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Automation</p>
          <PageHeaderTitle>Agent analytics</PageHeaderTitle>
          <PageHeaderDescription>Run, model, and tool totals.</PageHeaderDescription>
          </PageHeaderContent>
        </PageHeader>
        <MotionReveal delay={0.08}>
        <section className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {metrics.map((metric) => (
            <article key={metric.label} className="rounded-xl border border-border bg-card p-5">
              <div className="flex items-center justify-between"><p className="text-sm text-muted-foreground">{metric.label}</p><metric.icon className="h-4 w-4 text-muted-foreground" /></div>
              <p className="mt-5 text-3xl font-semibold tracking-tight text-foreground">{metric.value}</p>
            </article>
          ))}
        </section>
        </MotionReveal>
        <MotionReveal delay={0.16}>
        <section className="mt-8 grid gap-6 lg:grid-cols-2">
          <article className="rounded-xl border border-border bg-card p-6"><h2 className="text-lg font-semibold text-foreground">Run status</h2><div className="mt-4 space-y-3">{summary.runs.runsByStatus.length === 0 ? <p className="text-sm text-muted-foreground">No runs recorded yet.</p> : summary.runs.runsByStatus.map((entry) => <div key={entry.status} className="flex justify-between text-sm"><span className="text-muted-foreground">{entry.status}</span><span className="font-medium text-foreground">{entry.count}</span></div>)}</div></article>
          <article className="rounded-xl border border-border bg-card p-6"><div className="flex items-center justify-between"><h2 className="text-lg font-semibold text-foreground">Tool outcomes</h2><Wrench className="h-4 w-4 text-muted-foreground" /></div><p className="mt-1 text-sm text-muted-foreground">{toolCalls} recorded tool proposals and executions.</p><div className="mt-4 space-y-3">{summary.tools.length === 0 ? <p className="text-sm text-muted-foreground">No tool calls recorded yet.</p> : summary.tools.map((entry) => <div key={entry.status} className="flex justify-between text-sm"><span className="text-muted-foreground">{entry.status}</span><span className="font-medium text-foreground">{entry.count}</span></div>)}</div></article>
        </section>
        </MotionReveal>
        <MotionReveal delay={0.24}>
        <section className="mt-6 rounded-xl border border-border bg-card p-5 sm:p-6"><h2 className="text-lg font-semibold text-foreground">Model usage</h2><div className="mt-4 grid gap-4 sm:grid-cols-4">{[["Input tokens", summary.models.inputTokens], ["Output tokens", summary.models.outputTokens], ["Total tokens", summary.models.totalTokens], ["Failed calls", summary.models.failedCalls]].map(([label, value]) => <div key={label as string}><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-xl font-semibold text-foreground">{Number(value).toLocaleString()}</p></div>)}</div></section>
        </MotionReveal>
      </div>
    </div>
  );
}
