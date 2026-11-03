import type { Pool,PoolClient } from "pg";
import { AsyncLocalStorage } from "node:async_hooks";
import {
agentConfigurationSchema,
assertRuntimeAvailable,
PlatformError
} from "../../contracts/contracts";

import { capabilityBindingSchema } from "../../contracts/capability-catalog";
import { compilePublishedComposition } from "../programs/publication";
import { assertComposition, assertInspectableComposition } from "../programs/composition";
import { compileValidatedComposition } from "./validated-composition";
import { loadTaskModelRoutes } from "../models/persistence";
export { transaction } from "../../infrastructure/database";

import { HARNESS_RELEASE,HANDOFF_HARNESS_RELEASE,ADAPTIVE_HARNESS_RELEASE,LEGACY_ADAPTIVE_HARNESS_RELEASE,SHARED_HARNESS_RELEASE,type Execution } from "../../contracts/execution";
const inboxInspection = new AsyncLocalStorage<boolean>();
export function inspectInboxOutput<T>(fn: () => Promise<T>): Promise<T> {
  return inboxInspection.run(true, fn);
}
// Immutable task keys let writer locks coexist with Inbox foreign-key references.
export async function loadExecution(db: Pool | PoolClient, taskId: string, lock = false): Promise<Execution> {
  const task = (await db.query(`SELECT t.*,v.configuration,v.agent_id,v.tool_bindings,v.effective_composition AS published_composition FROM agents_platform.tasks t
    JOIN agents_platform.agent_versions v ON v.id=t.version_id AND v.organization_id=t.organization_id
    WHERE t.id=$1 ${lock ? "FOR NO KEY UPDATE OF t" : ""}`, [taskId])).rows[0];
  if (!task) throw new PlatformError("TASK_NOT_FOUND", 404, "Task not found");
  if (![HARNESS_RELEASE,HANDOFF_HARNESS_RELEASE,ADAPTIVE_HARNESS_RELEASE,LEGACY_ADAPTIVE_HARNESS_RELEASE,SHARED_HARNESS_RELEASE].includes(task.harness_release)) throw new PlatformError("HARNESS_RELEASE_UNAVAILABLE", 503, "Execution release is unavailable");
  const configuration = agentConfigurationSchema.parse(task.effective_configuration ?? task.configuration); assertRuntimeAvailable(configuration);
  const rows = configuration.connectedToolBindingIds.length ? (await db.query(`SELECT b.binding FROM agents_platform.version_connected_tools v
    JOIN agents_platform.capability_bindings b ON b.id=v.binding_id AND b.organization_id=v.organization_id
    WHERE v.organization_id=$1 AND v.version_id=$2 AND b.id=ANY($3::uuid[]) ORDER BY b.alias`, [task.organization_id, task.version_id, configuration.connectedToolBindingIds])).rows : [];
  if (rows.length !== configuration.connectedToolBindingIds.length) throw new PlatformError("CAPABILITY_BINDING_UNAVAILABLE", 409, "Published connected tools are unavailable");
  const connectedBindings = rows.map(row => capabilityBindingSchema.parse(row.binding));
  const current = task.harness_release!==SHARED_HARNESS_RELEASE
    ? compilePublishedComposition(configuration,connectedBindings,{release:task.harness_release,workflow:task.effective_composition.runtime.workflow},task.tool_bindings)
    : compileValidatedComposition(configuration, connectedBindings,task.tool_bindings);
  if (current.runtime.release !== task.harness_release) throw new PlatformError("HARNESS_RELEASE_UNAVAILABLE",503,"Execution release is unavailable");
  const inspect = inboxInspection.getStore() && ["completed", "incomplete"].includes(task.state);
  const check = inspect ? assertInspectableComposition : assertComposition;
  check(task.effective_composition, current);
  if (!task.parent_task_id) check(task.published_composition, current);
  const models = await loadTaskModelRoutes(db, task.id, task.organization_id);
  return { task, configuration, agentId: task.agent_id,toolBindings:task.tool_bindings, connectedBindings, models };
}
