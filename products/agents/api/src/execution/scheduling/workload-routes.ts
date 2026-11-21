export type WorkloadClass = "interactive" | "background";
export type CapacityWorkload = "interactive" | "background" | "ingestion" | "sandbox" | "evaluation";

/**
 * Interactive work is conversation turns. Everything else runs on the background class so a
 * long import or report cannot take the capacity a customer reply needs.
 */
export function workloadClass(workload: CapacityWorkload): WorkloadClass {
  return workload === "interactive" ? "interactive" : "background";
}

export interface WorkloadPools {
  interactive: string | null;
  background: string | null;
}

/** Optional pool labels; a missing label means the worker accepts either class. */
export function workloadPoolsFromEnvironment(env: NodeJS.ProcessEnv = process.env): WorkloadPools {
  const read = (name: string) => {
    const value = env[name]?.trim();
    if (!value) return null;
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) throw new Error(`${name} must be a short pool label`);
    return value;
  };
  return { interactive: read("AGENTS_WORKER_POOL_INTERACTIVE"), background: read("AGENTS_WORKER_POOL_BACKGROUND") };
}

/** Whether this worker should carry the workload, given its own pool label and the configured pools. */
export function workerAcceptsWorkload(workload: CapacityWorkload, workerPool: string | null, pools: WorkloadPools): boolean {
  const target = pools[workloadClass(workload)];
  if (!target) return true;
  return workerPool === target;
}

export type WorkerRole = "all" | "interactive" | "background" | "ingestion";

/** A worker can be limited to one pool, or reserved for ingestion, by deployment configuration. */
export function workerRoleFromEnvironment(env: NodeJS.ProcessEnv = process.env): WorkerRole {
  const value = env.AGENTS_WORKER_ROLE?.trim();
  if (!value) return "all";
  if (!["all", "interactive", "background", "ingestion"].includes(value))
    throw new Error("AGENTS_WORKER_ROLE must be all, interactive, background or ingestion");
  return value as WorkerRole;
}

/** Ingestion workers carry only the knowledge-ingestion service and dispatcher. */
export function workerRunsBusiness(role: WorkerRole): boolean { return role !== "ingestion"; }
export function workerRunsIngestion(role: WorkerRole): boolean { return role === "all" || role === "ingestion"; }
export function workerRoleWorkload(role: WorkerRole): "interactive" | "background" | undefined {
  return role === "interactive" ? "interactive" : role === "background" ? "background" : undefined;
}
