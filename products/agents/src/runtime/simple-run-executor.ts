import type { AgentRunActivities, DurableRunInput } from "../temporal/contracts";
import type { RunRepository, RuntimeRunRecord } from "../db/repositories/run-repository";
import { parseAgentResponse } from "../media/contracts";
import { sanitizeAssistantResponse } from "./sanitize";
import { withExecutionSignal } from "./execution-signal";

type ActiveRun = { controller: AbortController; done: Promise<void>; stopping: "cancelled" | "expired" | "failed" };

/** Process-bound orchestration over the same execution activities as Temporal. */
export class SimpleRunExecutor {
  private readonly active = new Map<string, ActiveRun>();
  private closing = false;

  public constructor(private readonly dependencies: {
    runs: Pick<RunRepository, "appendEvent">;
    activities: AgentRunActivities;
    onError: (error: unknown, runId: string) => void;
  }) {}

  public async start(run: RuntimeRunRecord): Promise<void> {
    if (this.closing) throw new Error("Simple execution is shutting down");
    if (this.active.has(run.id) || run.status !== "received") return;
    if (run.configuration.workflow) throw Object.assign(new Error("Workflow graphs require durable execution"), { statusCode: 409, code: "durable_execution_required" });
    const maxWallTimeMs = Math.min(300_000, Math.max(1, Number(run.configuration.maxWallTimeMs) || 60_000));
    await this.dependencies.runs.appendEvent({ organizationId: run.organization_id, installationId: run.installation_id,
      runId: run.id, eventType: "run.execution_selected", payload: { strategy: "simple", maxWallTimeMs, recovery: "manual_retry" } });
    const entry: ActiveRun = { controller: new AbortController(), done: Promise.resolve(), stopping: "cancelled" };
    this.active.set(run.id, entry);
    const timer = setTimeout(() => { entry.stopping = "expired"; entry.controller.abort(); }, maxWallTimeMs);
    timer.unref();
    // Schedule only after registration so cancellation cannot miss an accepted run.
    entry.done = Promise.resolve().then(() => withExecutionSignal(entry.controller.signal, () => this.execute(run, entry)))
      .catch(error => this.dependencies.onError(error, run.id))
      .finally(() => { clearTimeout(timer); this.active.delete(run.id); });
  }

  public cancel(runId: string): boolean {
    const entry = this.active.get(runId);
    if (!entry) return false;
    entry.stopping = "cancelled";
    entry.controller.abort();
    return true;
  }

  public async close(): Promise<void> {
    this.closing = true;
    const entries = [...this.active.values()];
    for (const entry of entries) { entry.stopping = "failed"; entry.controller.abort(); }
    await Promise.all(entries.map(entry => entry.done));
  }

  private async execute(run: RuntimeRunRecord, entry: ActiveRun): Promise<void> {
    const activities = this.dependencies.activities;
    const scope: DurableRunInput = { runId: run.id, organizationId: run.organization_id, actorId: run.created_by };
    let status = run.status;
    try {
      entry.controller.signal.throwIfAborted();
      await activities.transitionRun({ ...scope, expectedStatus: "received", nextStatus: "queued" });
      status = "queued";
      while (activities.waitForConversationTurn) {
        entry.controller.signal.throwIfAborted();
        const admission = await activities.waitForConversationTurn(scope);
        if (typeof admission === "boolean" ? admission : admission.acquired) {
          scope.sessionLease = typeof admission === "boolean" ? undefined : admission;
          break;
        }
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(entry.controller.signal.reason); };
          const timer = setTimeout(() => { entry.controller.signal.removeEventListener("abort", abort); resolve(); }, 100);
          entry.controller.signal.addEventListener("abort", abort, { once: true });
          if (entry.controller.signal.aborted) abort();
        });
      }
      entry.controller.signal.throwIfAborted();
      await activities.transitionRun({ ...scope, expectedStatus: "queued", nextStatus: "running" });
      status = "running";
      const result = await activities.executeLoop(scope);
      entry.controller.signal.throwIfAborted();
      if (["awaiting_approval", "awaiting_human", "awaiting_external_event"].includes(result.status) || result.pendingBatch || result.checkpointed) {
        for (const groupId of new Set(result.pendingToolCalls?.map(call => call.approvalGroupId).filter((id): id is string => Boolean(id)))) {
          await activities.cancelApprovalGroup?.({ ...scope, groupId, reason: "simple_execution_requires_durable_mode" });
        }
        await activities.cancelHandoff({ ...scope, reason: "simple_execution_requires_durable_mode" });
        throw Object.assign(new Error("This action needs durable execution"), { code: "DURABLE_EXECUTION_REQUIRED" });
      }
      if (result.status !== "completed") {
        throw Object.assign(new Error(result.error?.message ?? "The simple run reached an execution limit"), { code: result.error?.code ?? "AGENT_LOOP_LIMITED" });
      }
      const response = parseAgentResponse(result.completionResponse
        ? { ...result.completionResponse, text: sanitizeAssistantResponse(result.completionResponse.text) }
        : { text: sanitizeAssistantResponse(result.completionMessage ?? result.response?.message.content ?? "") });
      if (!response.text && !response.media.length && !result.directToolResult) throw Object.assign(new Error("The agent returned an empty response"), { code: "EMPTY_ASSISTANT_RESPONSE" });
      await activities.completeRun({ ...scope, output: { status: "completed", message: response.text, response,
        ...(result.directToolResult ? { tool: result.directToolResult } : {}), usage: result.usage, iterations: result.iterations,
        toolCalls: result.toolCalls, provenance: result.provenance ?? {}, executionStrategy: "simple" } });
      status = "completed";
      scope.sessionLease = undefined;
      await activities.deliverRunReply(scope);
    } catch (error) {
      if (status === "completed") throw error;
      if (entry.controller.signal.aborted && entry.stopping !== "failed") {
        await activities.transitionRun({ ...scope, expectedStatus: status, nextStatus: entry.stopping });
      } else {
        const code = entry.controller.signal.aborted ? "SIMPLE_EXECUTION_INTERRUPTED" : (error as { code?: string }).code ?? "SIMPLE_EXECUTION_FAILED";
        await activities.failRun({ ...scope, error: { code, message: code === "DURABLE_EXECUTION_REQUIRED" ? "This action requires durable execution" : "Simple execution could not complete",
          userMessage: code === "DURABLE_EXECUTION_REQUIRED" ? "Choose durable execution for approvals and waits." : "The run was interrupted or failed. You can retry it." } });
        scope.sessionLease = undefined;
        await activities.deliverRunReply(scope);
      }
    }
  }
}
