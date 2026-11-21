import { PlatformError, terminalTaskStates, type TaskState } from "../../contracts/contracts";
import type { ContextRunStateReader } from "./readers";

/**
 * Guard against building context for a run that settled after the task record was loaded.
 * Callers without a reader keep their existing behavior.
 */
export async function assertRunActive(reader: ContextRunStateReader | undefined, taskId: string, loadedState: string): Promise<void> {
  if (!reader || terminalTaskStates.has(loadedState as TaskState)) return;
  const current = await reader.read(taskId);
  if (current && terminalTaskStates.has(current.state as TaskState)) throw new PlatformError("TASK_SETTLED", 409, "The run has already settled");
}
