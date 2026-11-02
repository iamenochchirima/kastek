import type { Pool, PoolClient } from "pg";
import { requestDigest } from "../../contracts/contracts";
import { acceptedModelRoutesSchema, type AcceptedModelRoutes } from "../../contracts/model-bindings";
import { ModelOperationError } from "../business/model";

type Db = Pool | PoolClient;
const unavailable = () => new ModelOperationError("MODEL_ROUTES_UNAVAILABLE", "rejected", 409);
const integrity = () => new ModelOperationError("MODEL_ROUTES_INTEGRITY", "rejected", 409);
function parseRoutes(raw: unknown, organizationId: string): AcceptedModelRoutes {
  const parsed = acceptedModelRoutesSchema.safeParse(raw);
  if (!parsed.success || parsed.data.primary.binding.organizationId !== organizationId) throw integrity();
  for (const route of Object.values(parsed.data)) {
    if (requestDigest(route.definition) !== route.binding.providerDefinitionDigest) throw integrity();
  }
  return parsed.data;
}
export async function saveTaskModelRoutes(db: PoolClient, taskId: string, organizationId: string, raw: AcceptedModelRoutes): Promise<void> {
  const routes = parseRoutes(raw, organizationId), digest = requestDigest(routes);
  const scope = await db.query("SELECT id FROM agents_platform.tasks WHERE id=$1 AND organization_id=$2", [taskId, organizationId]);
  if (!scope.rowCount) throw unavailable();
  await db.query(`INSERT INTO agents_platform.task_model_routes(task_id,organization_id,routes,snapshot_digest)
    VALUES($1,$2,$3,$4) ON CONFLICT(task_id) DO NOTHING`, [taskId, organizationId, routes, digest]);
  const current = await loadTaskModelRoutes(db, taskId, organizationId);
  if (requestDigest(current) !== digest) throw integrity();
}
export async function loadTaskModelRoutes(db: Db, taskId: string, organizationId: string): Promise<AcceptedModelRoutes> {
  const row = (await db.query(`SELECT routes,snapshot_digest FROM agents_platform.task_model_routes WHERE task_id=$1 AND organization_id=$2`,
    [taskId, organizationId])).rows[0];
  if (!row) throw unavailable();
  if (requestDigest(row.routes) !== row.snapshot_digest) throw integrity();
  const routes = parseRoutes(row.routes, organizationId);
  return routes;
}
