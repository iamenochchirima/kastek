import * as restate from "@restatedev/restate-sdk";
import { restateServiceName } from "../../contracts/restate-names";
import type { Pool } from "pg";
import { SupportWaitingService } from "./support-waiting";

export const SUPPORT_WAITING_WORKFLOW = "AgentsSupportWaitingV1";
export function createSupportWaitingWorkflow(service: SupportWaitingService) {
  return restate.workflow({ name: restateServiceName(SUPPORT_WAITING_WORKFLOW), handlers: { run: async (ctx: restate.WorkflowContext, input: { taskId: string }) => {
    for (let tick = 0; ; tick++) {
      const next = await ctx.run(`waiting:${tick}`, async () => (await service.advance(input.taskId))?.getTime() ?? null);
      if (next === null) return;
      const now = await ctx.date.now();
      if (next > now) await ctx.sleep(next - now);
    }
  } } });
}

export async function dispatchSupportWaitingOnce(pool: Pool, ingressUrl: string, request: typeof fetch = fetch): Promise<void> {
  const rows = (await pool.query(`SELECT task_id FROM agents_platform.support_waiting WHERE dispatched_at IS NULL AND completed_at IS NULL ORDER BY requested_at,task_id LIMIT 20`)).rows;
  for (const row of rows) {
    const response = await request(`${ingressUrl.replace(/\/$/, "")}/restate/send/${restateServiceName(SUPPORT_WAITING_WORKFLOW)}/${row.task_id}/run`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: row.task_id }), signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("SUPPORT_WAITING_DISPATCH_FAILED");
    const body = await response.json() as { invocationId?: string };
    if (!body.invocationId?.startsWith("inv_")) throw new Error("SUPPORT_WAITING_DISPATCH_FAILED");
    await pool.query("UPDATE agents_platform.support_waiting SET dispatched_at=now() WHERE task_id=$1", [row.task_id]);
  }
}

export function startSupportWaitingDispatcher(pool: Pool, ingressUrl: string, onError: (code: string) => void) {
  let stopped = false, timer: ReturnType<typeof setTimeout> | undefined, wake: (() => void) | undefined;
  const done = (async () => {
    while (!stopped) {
      try { await dispatchSupportWaitingOnce(pool, ingressUrl); } catch { onError("SUPPORT_WAITING_DISPATCH_FAILED"); }
      if (!stopped) await new Promise<void>(resolve => { wake = resolve; timer = setTimeout(resolve, 1000); });
    }
  })();
  return { async stop() { stopped = true; if (timer) clearTimeout(timer); wake?.(); await done; } };
}
