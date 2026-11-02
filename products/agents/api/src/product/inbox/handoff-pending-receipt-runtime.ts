import * as restate from "@restatedev/restate-sdk";
import type { Pool } from "pg";
import { z } from "zod";
import { cancelExpiredReceiptRoot, settleReceipt, type Publisher } from "./handoff-pending-receipt";

export const HANDOFF_RECEIPT_WORKFLOW = "AgentsHandoffReceiptV1";
export function createReceiptWorkflow(pool: Pool, fallback: string, publish: Publisher) {
  return restate.workflow({ name: HANDOFF_RECEIPT_WORKFLOW, handlers: { run: async (ctx: restate.WorkflowContext, input: { taskId: string }) => {
    if (!z.uuid().safeParse(input.taskId).success || ctx.key !== input.taskId) throw new restate.TerminalError("Invalid handoff receipt",{errorCode:400});
    for (let attempt = 0; ; attempt++) {
      const deadline = await ctx.run(`deadline:${attempt}`, async () => {
        const row = (await pool.query("SELECT deadline,outcome FROM agents_platform.pending_handoff_receipts WHERE task_id=$1", [input.taskId])).rows[0];
        return !row || row.outcome ? null : row.deadline.getTime();
      });
      if (deadline === null) return;
      const now = await ctx.date.now();
      if (deadline > now) await ctx.sleep(deadline - now);
      await ctx.run(`cancel-expired:${attempt}`, () => cancelExpiredReceiptRoot(pool,input.taskId));
      const result = await ctx.run(`fallback:${attempt}`, () => settleReceipt(pool, input.taskId, null, fallback, publish));
      if (result !== "pending") return;
      // Database time is authoritative; avoid a hot loop if the clocks differ.
      await ctx.sleep(250);
    }
  } } });
}

// Repeated sends use the same workflow key. A lost response is safe to retry.
export async function dispatchReceiptsOnce(pool: Pool, ingressUrl: string, request: typeof fetch = fetch) {
  const rows = (await pool.query("SELECT task_id FROM agents_platform.pending_handoff_receipts WHERE dispatched_at IS NULL AND outcome IS NULL ORDER BY created_at,task_id LIMIT 20")).rows;
  for (const row of rows) {
    const response = await request(`${ingressUrl.replace(/\/$/, "")}/restate/send/${HANDOFF_RECEIPT_WORKFLOW}/${row.task_id}/run`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: row.task_id }), signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || !(await response.json() as { invocationId?: string }).invocationId?.startsWith("inv_")) throw new Error("HANDOFF_RECEIPT_DISPATCH_FAILED");
    await pool.query("UPDATE agents_platform.pending_handoff_receipts SET dispatched_at=clock_timestamp() WHERE task_id=$1", [row.task_id]);
  }
}

export function startHandoffReceiptDispatcher(pool: Pool, ingressUrl: string, onError: (code:string)=>void) {
  let stopped=false,timer:ReturnType<typeof setTimeout>|undefined,wake:(()=>void)|undefined;
  const done=(async()=>{while(!stopped){
    try { await dispatchReceiptsOnce(pool,ingressUrl); } catch { onError("HANDOFF_RECEIPT_DISPATCH_FAILED"); }
    if(!stopped)await new Promise<void>(resolve=>{wake=resolve;timer=setTimeout(resolve,1000);});
  }})();
  return {async stop(){stopped=true;if(timer)clearTimeout(timer);wake?.();await done;}};
}
