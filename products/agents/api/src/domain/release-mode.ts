import type { AgentExecutionMode, AgentReleaseMode } from "./types";

export function defaultAgentReleaseMode(executionMode: AgentExecutionMode): AgentReleaseMode {
  // Live moves only through an explicit Deploy operation.
  void executionMode;
  return "pinned";
}

export function assertAgentReleaseMode(
  executionMode: AgentExecutionMode,
  releaseMode: AgentReleaseMode,
): void {
  if (releaseMode !== "pinned") {
    throw Object.assign(new Error("Only pinned deployment is supported"), {
      statusCode: 400,
      code: "RELEASE_MODE_NOT_ALLOWED",
    });
  }
  void executionMode;
}
