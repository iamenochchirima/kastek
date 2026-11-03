import type { PoolClient } from "pg";
import { PlatformError } from "../../contracts/contracts";

/** Root admission holds this shared row lock through commit, linearizing against an operator drain. */
export async function assertPlatformRootAdmissionOpen(db: PoolClient): Promise<void> {
  const gate = (await db.query<{ accepting_roots: boolean }>(
    "SELECT accepting_roots FROM agents_platform.platform_admission_gate WHERE id=1 FOR SHARE",
  )).rows[0];
  if (!gate) throw new PlatformError("ADMISSION_CONTROL_UNAVAILABLE", 503, "Task admission is temporarily unavailable");
  if (!gate.accepting_roots) throw new PlatformError("PLATFORM_ADMISSIONS_PAUSED", 503, "New task admission is paused");
}
