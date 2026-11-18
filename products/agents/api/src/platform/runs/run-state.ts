import type { Pool } from "pg";
import type { ContextRunState, ContextRunStateReader } from "../../execution/context/readers";

/** Current run state for one task, used by context assembly. */
export class PlatformRunStateReader implements ContextRunStateReader {
  constructor(readonly pool: Pool) {}

  async read(taskId: string): Promise<ContextRunState | null> {
    const row = (await this.pool.query<{ state: string; output: string | null; error_code: string | null }>(
      "SELECT state,output,error_code FROM agents_platform.tasks WHERE id=$1", [taskId])).rows[0];
    return row ? { state: row.state, output: row.output, errorCode: row.error_code } : null;
  }
}
