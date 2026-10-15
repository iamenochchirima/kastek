import type { RunRepository } from "../db/repositories/run-repository";
import { runWithRequiredDatabaseContext } from "../db/context";

/** Discovery crosses tenants; terminal writes use each run's own scope. */
export async function reconcileSimpleRuns(
  runs: Pick<RunRepository, "listOverdueSimpleRuns" | "failRun">,
): Promise<number> {
  const overdue = await runWithRequiredDatabaseContext(
    "simple-run-reconciliation-discovery",
    { organizationId: "platform", actorId: "system:simple-run-reconciliation", operator: true },
    () => runs.listOverdueSimpleRuns(),
  );
  let reconciled = 0;
  for (const run of overdue) {
    const result = await runWithRequiredDatabaseContext(
      "simple-run-reconciliation",
      { organizationId: run.organization_id, actorId: run.created_by },
      () => runs.failRun(run.id, {
        code: "SIMPLE_EXECUTION_INTERRUPTED",
        message: "Simple execution did not record an outcome before its deadline",
        userMessage: "The run was interrupted and cannot resume automatically. Review any external actions before retrying.",
      }),
    );
    // failRun locks the run and preserves a concurrently saved terminal outcome.
    if (result.status === "failed" && result.error?.code === "SIMPLE_EXECUTION_INTERRUPTED") reconciled++;
  }
  return reconciled;
}
