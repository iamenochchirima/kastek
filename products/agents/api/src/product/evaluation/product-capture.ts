import type {Pool, PoolClient} from "pg";
import {PlatformError} from "../../contracts/contracts";
import {exportExecutionHistory, type ExecutionHistoryExport} from "./history-export";

/** Product owners reuse native evidence with their own current task/resource authorization. */
export async function exportProductExecutionCapture(pool: Pool, taskId: string,
  authorize: (db: PoolClient, rootTaskId: string) => Promise<void>): Promise<{capture: ExecutionHistoryExport}> {
  const capture = await exportExecutionHistory(pool, taskId, authorize);
  const result = {capture};
  // Match the existing authenticated product bridge response bound; never silently truncate evidence.
  if (Buffer.byteLength(JSON.stringify(result)) > 2097152)
    throw new PlatformError("PRODUCT_CAPTURE_LIMIT", 413, "Execution capture exceeds the product response limit");
  return result;
}
