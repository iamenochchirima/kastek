import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { notFound, redirect } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { getRustSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";
import type { AgentApprovalGroup, AgentOperationEvent, AgentRun, AgentRunTimeline } from "@/lib/agent-platform";
import { AgentRunActions } from "@/components/dashboard/agents/agent-run-actions";
import { AgentApprovalGroupActions } from "@/components/dashboard/agents/agent-approval-group-actions";
import { AgentRunLiveTimeline } from "@/components/dashboard/agents/agent-run-live-timeline";
import { AgentApprovalPreview } from "@/components/dashboard/agents/agent-approval-preview";
import { PageHeader, PageHeaderActions, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "@/components/ui/page-header";
import { MotionReveal } from "@/components/ui/motion-reveal";

export const metadata = { title: "Agent run | KasiTek" };

function formatValue(value: unknown) {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

export default async function AgentRunPage({ params }: { params: Promise<{ runId: string }> }) {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");
  const { runId } = await params;
  const [response, timeline] = await Promise.all([
    fetchRustJson<{ run: AgentRun; approvalGroup?: AgentApprovalGroup | null; approvalGroups?: AgentApprovalGroup[]; events: AgentOperationEvent[] }>(`/api/agents/runs/${encodeURIComponent(runId)}`).catch(() => null),
    fetchRustJson<AgentRunTimeline>(`/api/agents/runs/${encodeURIComponent(runId)}/timeline`).catch(() => null),
  ]);
  if (!response?.run) notFound();
  const { run, approvalGroup, approvalGroups, events } = response;
  const steps = timeline?.steps ?? [];
  const toolCalls = timeline?.toolCalls ?? [];
  const effects = timeline?.effects ?? [];
  const terminal = ["completed", "failed", "cancelled", "expired"].includes(run.status);

  return (
    <MotionReveal className="min-h-[100dvh] p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-[1100px] space-y-6">
        <Link href="/agents/activity" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" />Back to activity</Link>
        <Card><CardContent className="space-y-5 p-6">
          <PageHeader><PageHeaderContent><p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Agent operation</p><PageHeaderTitle>{run.agent_name || run.agent_slug || "Agent run"}</PageHeaderTitle><PageHeaderDescription className="break-all font-mono text-xs">{run.id}</PageHeaderDescription></PageHeaderContent><PageHeaderActions><span className={`rounded-full border px-2.5 py-1 text-xs font-medium capitalize ${run.status === "completed" ? "border-status-success/30 bg-status-success-soft text-status-success" : run.status === "failed" ? "border-destructive/30 bg-destructive/10 text-destructive" : "border-status-attention/30 bg-status-attention-soft text-status-attention"}`}>{run.status.replaceAll("_", " ")}</span><AgentRunActions runId={run.id} status={run.status} waitingFor={typeof run.output?.waitingFor === "string" ? run.output.waitingFor : undefined} /></PageHeaderActions></PageHeader>
          <div className="grid gap-3 text-sm sm:grid-cols-3"><div className="rounded-lg bg-secondary/50 p-3"><p className="text-xs text-muted-foreground">Trigger</p><p className="mt-1 font-medium capitalize text-foreground">{run.trigger_type || "manual"}</p></div><div className="rounded-lg bg-secondary/50 p-3"><p className="text-xs text-muted-foreground">Created</p><p className="mt-1 font-medium text-foreground">{run.created_at ? new Date(run.created_at).toLocaleString() : "Unknown"}</p></div><div className="rounded-lg bg-secondary/50 p-3"><p className="text-xs text-muted-foreground">Finished</p><p className="mt-1 font-medium text-foreground">{run.finished_at ? new Date(run.finished_at).toLocaleString() : terminal ? "Not recorded" : "Still running"}</p></div></div>
          {run.error ? <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4"><p className="text-sm font-semibold text-destructive">Run error</p><pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap text-xs text-destructive">{formatValue(run.error)}</pre></div> : null}
          {run.output ? <div className="rounded-lg border border-border bg-secondary/20 p-4"><p className="text-sm font-semibold text-foreground">Run output</p><pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">{formatValue(run.output)}</pre></div> : null}
        </CardContent></Card>
        {approvalGroup ? <Card><CardContent className="space-y-4 p-6"><div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold text-foreground">Approval required</h2><p className="mt-1 text-sm text-muted-foreground">{approvalGroup.operations.length} actions are waiting for one decision.</p></div><span className="rounded-full border border-status-attention/40 bg-status-attention-soft px-2.5 py-1 text-xs font-medium capitalize text-status-attention">{approvalGroup.status}</span></div><div className="space-y-2">{approvalGroup.operations.map((operation) => <details key={operation.runtimeOperationId ?? operation.providerToolCallId} className="rounded-lg border border-border bg-secondary/20 px-4 py-3"><summary className="cursor-pointer text-sm font-medium text-foreground">{operation.capability}</summary><div className="mt-4 space-y-3"><AgentApprovalPreview snapshot={operation.resourceSnapshot} /><div className="grid gap-3 text-xs text-muted-foreground sm:grid-cols-2"><p>Expires {new Date(operation.expiresAt).toLocaleString()}</p>{operation.previewRevision ? <p>Preview revision <span className="font-mono text-foreground">{operation.previewRevision}</span></p> : null}</div></div></details>)}</div><AgentApprovalGroupActions runId={run.id} group={approvalGroup} /></CardContent></Card> : null}
        {approvalGroups?.filter((group) => group.id !== approvalGroup?.id).length ? <ApprovalGroupHistory groups={approvalGroups.filter((group) => group.id !== approvalGroup?.id)} toolCalls={toolCalls} /> : null}
        <AgentRunLiveTimeline runId={run.id} initialEvents={events} terminal={terminal} />
        {(steps.length || toolCalls.length || effects.length) ? <Card><CardContent className="space-y-5 p-6"><div><h2 className="text-lg font-semibold text-foreground">Execution evidence</h2><p className="mt-1 text-sm text-muted-foreground">Safe step, tool, and effect records from the same durable run. Secret-like fields are redacted by the Agent API.</p></div><div className="grid gap-3 sm:grid-cols-3"><div className="rounded-lg bg-secondary/50 p-3"><p className="text-xs text-muted-foreground">Steps</p><p className="mt-1 text-xl font-semibold text-foreground">{steps.length}</p></div><div className="rounded-lg bg-secondary/50 p-3"><p className="text-xs text-muted-foreground">Tool calls</p><p className="mt-1 text-xl font-semibold text-foreground">{toolCalls.length}</p></div><div className="rounded-lg bg-secondary/50 p-3"><p className="text-xs text-muted-foreground">Effect receipts</p><p className="mt-1 text-xl font-semibold text-foreground">{effects.length}</p></div></div>{steps.length ? <div><h3 className="text-sm font-semibold text-foreground">Run steps</h3><div className="mt-2 space-y-2">{steps.map((step, index) => <div key={String(step.id || step.sequence_number || index)} className="rounded-lg border border-border p-3"><div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium capitalize text-foreground">{String(step.step_type || "step")}</span><span className="text-xs text-muted-foreground">{String(step.status || "unknown")}</span></div><pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">{formatValue({ input: step.input, output: step.output, error: step.error })}</pre></div>)}</div></div> : null}{toolCalls.length ? <div><h3 className="text-sm font-semibold text-foreground">Tool calls</h3><div className="mt-2 space-y-2">{toolCalls.map((toolCall, index) => <div key={String(toolCall.id || toolCall.provider_tool_call_id || index)} className="rounded-lg border border-border p-3"><div className="flex flex-wrap items-center justify-between gap-2"><span className="break-all font-medium text-foreground">{String(toolCall.tool_name || toolCall.name || "tool")}</span><span className="text-xs text-muted-foreground">{String(toolCall.status || "unknown")}</span></div><pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">{formatValue({ argumentsHash: toolCall.arguments_hash, output: toolCall.output, error: toolCall.error })}</pre></div>)}</div></div> : null}{effects.length ? <div><h3 className="text-sm font-semibold text-foreground">Effect receipts</h3><div className="mt-2 space-y-2">{effects.map((effect, index) => <div key={String(effect.id || index)} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3"><span className="break-all text-sm text-foreground">{String(effect.capability || "effect")}</span><span className="rounded-full border border-border bg-secondary px-2.5 py-1 text-xs capitalize text-muted-foreground">{String(effect.status || "unknown")}</span></div>)}</div></div> : null}</CardContent></Card> : null}
      </div>
    </MotionReveal>
  );
}

function ApprovalGroupHistory({ groups, toolCalls }: { groups: AgentApprovalGroup[]; toolCalls: Array<Record<string, unknown>> }) {
  return <Card><CardContent className="space-y-4 p-6">
    <div><h2 className="text-lg font-semibold text-foreground">Approval history</h2><p className="mt-1 text-sm text-muted-foreground">{groups.length} completed group{groups.length === 1 ? "" : "s"}</p></div>
    <div className="space-y-2">{groups.map((group) => <details key={group.id} className="rounded-lg border border-border bg-secondary/20 px-4 py-3">
      <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 text-sm font-medium text-foreground"><span className="capitalize">{group.status.replaceAll("_", " ")}</span><span className="text-xs font-normal text-muted-foreground">{group.operations.length} actions</span></summary>
      <div className="mt-3 space-y-2 text-xs">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground"><span>Decision: {group.decision ?? "none"}</span>{group.decidedAt ? <span>{new Date(group.decidedAt).toLocaleString()}</span> : null}</div>
        {group.operations.length ? group.operations.map((operation) => {
          const operationId = operation.runtimeOperationId ?? operation.providerToolCallId;
          const toolCall = toolCalls.find((candidate) => [candidate.id, candidate.runtime_operation_id, candidate.provider_tool_call_id].includes(operationId));
          const toolStatus = typeof toolCall?.status === "string" ? toolCall.status : null;
          const toolError = toolCall?.error;
          return <div key={operationId} className="rounded-md border border-border/70 px-3 py-2"><div className="flex flex-wrap items-center justify-between gap-2"><span className="break-all font-medium text-foreground">{operation.capability}</span><span className="capitalize text-muted-foreground">{operation.status}{toolStatus && toolStatus !== operation.status ? ` · tool ${toolStatus}` : ""}</span></div>{toolError ? <pre className="mt-2 max-h-24 overflow-auto whitespace-pre-wrap text-destructive">{formatValue(toolError)}</pre> : null}</div>;
        }) : <p className="text-muted-foreground">No operation records</p>}
      </div>
    </details>)}</div>
  </CardContent></Card>;
}
