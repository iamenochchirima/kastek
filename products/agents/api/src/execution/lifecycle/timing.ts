import type { Pool, PoolClient } from "pg";
import { terminalTaskStates } from "../../contracts/contracts";
const terminalStates:ReadonlySet<string>=terminalTaskStates;

export function elapsedTaskTime(from: unknown, to: unknown): number | null {
  const value = (input: unknown) => input instanceof Date ? input.getTime() : typeof input === "string" ? Date.parse(input) : NaN;
  const start = value(from), end = value(to);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

/** Acceptance and the terminal receipt define wall time; later projection writes do not extend it. */
export async function readTaskTiming(db: Pool | PoolClient, task: { id: string; state: string; created_at: unknown;work_id?:string;root_task_id?:string }) {
  const observedAt = new Date().toISOString(), terminal = terminalStates.has(task.state);
  const finished = terminal ? (await db.query<{ created_at: Date }>("SELECT created_at FROM agents_platform.task_events WHERE task_id=$1 AND event_key=$2", [task.id, `terminal:${task.id}`])).rows[0]?.created_at : null;
  const endpoint=terminal?finished:observedAt,elapsedMs=elapsedTaskTime(task.created_at,endpoint);
  const workId=task.work_id??task.root_task_id??null;
  const origin=workId&&workId!==task.id?(await db.query(`SELECT origin.created_at FROM agents_platform.tasks t
    JOIN agents_platform.tasks origin ON origin.id=$2 AND origin.id=coalesce(t.work_id,t.root_task_id) AND origin.parent_task_id IS NULL
      AND origin.organization_id=t.organization_id AND origin.product=t.product AND origin.principal=t.principal
    WHERE t.id=$1`,[task.id,workId])).rows[0]:undefined;
  return { observedAt, elapsedMs,workId,workElapsedMs:workId===task.id?elapsedMs:elapsedTaskTime(origin?.created_at,endpoint),
    finishedAt: finished instanceof Date && Number.isFinite(finished.getTime()) ? finished.toISOString() : null };
}
