import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { HARNESS_RELEASE,reconcilePendingRoots,settleTask,WORKFLOW_NAME } from "./execution";

export interface DispatcherOptions {
  ingressUrl: string;
  adminUrl: string;
  fetch?: typeof fetch;
  onError?: (code: string) => void;
}

export async function dispatchTasksOnce(pool: Pool, options: DispatcherOptions): Promise<void> {
  const request = options.fetch ?? fetch;
  await pool.query(`UPDATE agents_platform.task_outbox o SET dispatched_at=now(),lease_owner=NULL,lease_until=NULL
    FROM agents_platform.tasks t WHERE t.id=o.task_id AND o.dispatched_at IS NULL
    AND t.state IN ('completed','incomplete','refused','failed','cancelled','uncertain')`);
  const owner = randomUUID();
  const row = (await pool.query(`WITH candidate AS (
    SELECT o.task_id FROM agents_platform.task_outbox o JOIN agents_platform.tasks t ON t.id=o.task_id
    WHERE o.dispatched_at IS NULL AND o.available_at<=now() AND (o.lease_until IS NULL OR o.lease_until<now())
      AND t.state IN ('accepted','running','waiting_children','waiting_authority','waiting_review','reconciling','cancel_requested')
      AND (t.parent_task_id IS NULL OR t.state='cancel_requested')
    ORDER BY o.created_at FOR UPDATE OF o SKIP LOCKED LIMIT 1
  ) UPDATE agents_platform.task_outbox o SET lease_until=now()+interval '30 seconds',lease_owner=$1,attempts=attempts+1
    FROM candidate c WHERE o.task_id=c.task_id RETURNING o.task_id,o.created_at`, [owner])).rows[0];
  if (row) {
    try {
      const task = (await pool.query(`SELECT state,runtime_invocation_id,harness_release,parent_task_id FROM agents_platform.tasks WHERE id=$1`, [row.task_id])).rows[0];
      if (task?.harness_release !== HARNESS_RELEASE) throw new Error("HARNESS_RELEASE_UNAVAILABLE");
      if (Date.now() - new Date(row.created_at).getTime() >= 24 * 60 * 60 * 1000) {
        await settleTask(pool, row.task_id, { state: "uncertain", errorCode: "DISPATCH_WINDOW_EXPIRED" });
      } else if (task?.parent_task_id) {
        if(task.state==="cancel_requested"&&!task.runtime_invocation_id)await settleTask(pool,row.task_id,{state:"cancelled"});
      } else if (task?.state === "cancel_requested" && !task.runtime_invocation_id &&
          (await pool.query(`SELECT attempts FROM agents_platform.task_outbox WHERE task_id=$1`, [row.task_id])).rows[0]?.attempts === 1) {
        await settleTask(pool, row.task_id, { state: "cancelled" });
      } else {
        const response = await request(`${options.ingressUrl.replace(/\/$/, "")}/restate/send/${WORKFLOW_NAME}/${row.task_id}/run`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ taskId: row.task_id }), signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error("RUNTIME_DISPATCH_FAILED");
        const sent = await response.json() as { invocationId?: unknown };
        if (typeof sent.invocationId !== "string" || !sent.invocationId.startsWith("inv_")) throw new Error("RUNTIME_INVALID_RESPONSE");
        // Bind the accepted workflow identity independently of the submission response.
        const lookup = await request(`${options.ingressUrl.replace(/\/$/, "")}/restate/lookup`, {
          method:"POST",headers:{"content-type":"application/json"},
          body:JSON.stringify({target:"workflow",workflowName:WORKFLOW_NAME,workflowKey:row.task_id}),signal:AbortSignal.timeout(5000),
        });
        if(!lookup.ok)throw new Error("RUNTIME_LOOKUP_PENDING");
        const body=await lookup.json() as {invocationId?:unknown};
        if(typeof body.invocationId!=="string"||!body.invocationId.startsWith("inv_"))throw new Error("RUNTIME_INVALID_RESPONSE");
        const bound = await pool.query(`UPDATE agents_platform.tasks SET runtime_invocation_id=$2,updated_at=now()
          WHERE id=$1 AND (runtime_invocation_id IS NULL OR runtime_invocation_id=$2)`, [row.task_id, body.invocationId]);
        if (bound.rowCount !== 1) throw new Error("RUNTIME_IDENTITY_CONFLICT");
      }
      await pool.query(`UPDATE agents_platform.task_outbox SET dispatched_at=now(),lease_owner=NULL,lease_until=NULL,last_error_code=NULL
        WHERE task_id=$1 AND lease_owner=$2`, [row.task_id, owner]);
    } catch {
      await pool.query(`UPDATE agents_platform.task_outbox SET lease_owner=NULL,lease_until=NULL,
        available_at=now()+interval '5 seconds',last_error_code='RUNTIME_DISPATCH_FAILED' WHERE task_id=$1 AND lease_owner=$2`, [row.task_id, owner]);
      options.onError?.("RUNTIME_DISPATCH_FAILED");
    }
  }
  await reconcilePendingRoots(pool);
  const controls = (await pool.query(`SELECT c.task_id,c.generation,c.kind FROM agents_platform.task_controls c JOIN agents_platform.tasks t ON t.id=c.task_id
    WHERE c.dispatched_at IS NULL AND t.state NOT IN ('completed','incomplete','refused','failed','cancelled','uncertain') LIMIT 10`)).rows;
  for (const control of controls) {
    try {
      const response = await request(`${options.ingressUrl.replace(/\/$/, "")}/${WORKFLOW_NAME}/${control.task_id}/${control.kind==="review"?"review":"resume"}`, {
        method: "POST", headers: {"content-type":"application/json", "idempotency-key":`continue:${control.task_id}:${control.generation}`},
        body:JSON.stringify({generation:Number(control.generation)}), signal:AbortSignal.timeout(5000) });
      if(response.ok) await pool.query("UPDATE agents_platform.task_controls SET dispatched_at=now() WHERE task_id=$1 AND generation=$2",[control.task_id,control.generation]);
    } catch { options.onError?.("RUNTIME_CONTINUATION_FAILED"); }
  }
  await pool.query(`WITH expired AS (UPDATE agents_platform.tasks SET state='cancel_requested',error_code='TASK_DEADLINE',updated_at=now()
    WHERE deadline_at<now() AND state IN ('accepted','running','waiting_authority','waiting_review','waiting_children','reconciling') RETURNING id)
    INSERT INTO agents_platform.task_events(task_id,event_key,kind) SELECT id,'deadline-stop','cancel_requested' FROM expired ON CONFLICT DO NOTHING`);

  const cancellations = (await pool.query(`SELECT id,runtime_invocation_id,created_at FROM agents_platform.tasks
    WHERE state='cancel_requested' AND runtime_invocation_id IS NOT NULL ORDER BY updated_at LIMIT 10`)).rows;
  for (const task of cancellations) {
    try {
      const response = await request(`${options.adminUrl.replace(/\/$/, "")}/invocations/${encodeURIComponent(task.runtime_invocation_id)}/cancel`,
        { method: "PATCH", signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error("RUNTIME_CANCEL_FAILED");
      const output = await request(`${options.ingressUrl.replace(/\/$/, "")}/restate/output/${encodeURIComponent(task.runtime_invocation_id)}`,
        { signal: AbortSignal.timeout(5000) });
      const body = await output.json() as { message?: unknown; state?: unknown; output?: unknown; errorCode?: unknown };
      if (output.status === 409 && typeof body.message === "string" && /cancel/i.test(body.message)) {
        await settleTask(pool, task.id, { state: "cancelled" });
      } else if (output.ok && ["completed", "incomplete", "refused", "failed", "cancelled", "uncertain"].includes(String(body.state))) {
        await settleTask(pool, task.id, { state: body.state as "completed" | "incomplete" | "refused" | "failed" | "cancelled" | "uncertain",
          output: typeof body.output === "string" ? body.output : undefined,
          errorCode: typeof body.errorCode === "string" ? body.errorCode : undefined });
      } else if (Date.now() - new Date(task.created_at).getTime() > 24 * 60 * 60 * 1000) {
        await settleTask(pool, task.id, { state: "uncertain", errorCode: "CANCELLATION_UNCONFIRMED" });
      }
    } catch {
      options.onError?.("RUNTIME_CANCEL_FAILED");
      if (Date.now() - new Date(task.created_at).getTime() > 24 * 60 * 60 * 1000) {
        await settleTask(pool, task.id, { state: "uncertain", errorCode: "CANCELLATION_UNCONFIRMED" });
      }
    }
  }
}

export function startDispatcher(pool: Pool, options: DispatcherOptions): { stop(): Promise<void> } {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let wake: (() => void) | undefined;
  const done = (async () => {
    while (!stopped) {
      try { await dispatchTasksOnce(pool, options); }
      catch { options.onError?.("RUNTIME_PUBLISHER_FAILED"); }
      if (!stopped) await new Promise<void>(resolve => { wake = resolve; timer = setTimeout(resolve, 1000); });
    }
  })();
  return { stop: async () => { stopped = true; if (timer) clearTimeout(timer); wake?.(); await done; } };
}
