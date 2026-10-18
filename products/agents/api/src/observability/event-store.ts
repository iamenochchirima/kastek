import type { Pool, PoolClient } from "pg";
import { effectiveCompositionSchema } from "../contracts/programs";
import { makeObservation } from "./observations";

/** Native observation and export intent commit with the original execution event. */
export async function recordEvent(db: Pool | PoolClient, taskId: string, key: string, kind: string, payload: object = {}): Promise<void> {
  const task = (await db.query(`SELECT t.*,v.agent_id FROM agents_platform.tasks t
    JOIN agents_platform.agent_versions v ON v.id=t.version_id AND v.organization_id=t.organization_id WHERE t.id=$1`, [taskId])).rows[0];
  if (!task) throw new Error("OBSERVATION_TASK_NOT_FOUND");
  const composition = effectiveCompositionSchema.parse(task.effective_composition);
  const fields = payload as Record<string, unknown>;
  const operationId = typeof fields.operationId === "string" ? fields.operationId : null;
  const operation = operationId ? (await db.query(`SELECT * FROM agents_platform.operations WHERE task_id=$1 AND id=$2`, [taskId, operationId])).rows[0] : null;
  const category = operation?.kind === "compaction" ? "context" : operation?.kind === "delegation" ? "delegation" : operation?.kind;
  const typedKind = kind.startsWith("operation.") && category ? `${category}.${kind.slice("operation.".length)}` : kind;
  const observation = makeObservation({ eventKey: key, kind: typedKind, occurredAt: new Date().toISOString(),
    identity: { product: task.product, organizationId: task.organization_id, agentId: task.agent_id, versionId: task.version_id,
      programId: composition.program.id, programVersion: composition.program.version, runtimeRelease: composition.runtime.release,
      conversationId: task.conversation_id, rootTaskId: task.root_task_id, parentTaskId: task.parent_task_id, taskId,
      operationId, attemptId: operation?.attempt_id ?? null },
    metadata: { ...fields, contextTokens: fields.estimatedTokens,
      totalTokens: operation?.accounted_tokens ?? fields.accountedTokens,
      inputTokens: operation?.output?.usage?.inputTokens, outputTokens: operation?.output?.usage?.outputTokens,
      outcome: operation?.state ?? (['completed','failed','uncertain','cancelled','incomplete','refused'].includes(kind) ? kind : undefined),
      durationMs: operation?.completed_at ? new Date(operation.completed_at).getTime() - new Date(operation.started_at).getTime() : undefined },
  });
  await db.query(`WITH inserted AS (
    INSERT INTO agents_platform.task_events(task_id,event_key,kind,payload,observation) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(task_id,event_key) DO NOTHING RETURNING sequence
  ) INSERT INTO agents_platform.observation_exports(event_sequence,observation_id) SELECT sequence,$6 FROM inserted`,
  [taskId, key, kind, payload, observation, observation.id]);
}
