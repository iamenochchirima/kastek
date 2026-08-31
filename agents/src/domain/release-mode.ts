import type { AgentExecutionMode, AgentReleaseMode } from "./types";

export function defaultAgentReleaseMode(executionMode: AgentExecutionMode): AgentReleaseMode {
  return executionMode === "kasitek_hosted" ? "follow_published" : "pinned";
}

export function assertAgentReleaseMode(
  executionMode: AgentExecutionMode,
  releaseMode: AgentReleaseMode,
): void {
  if (executionMode !== "kasitek_hosted" && releaseMode !== "pinned") {
    throw Object.assign(new Error("Only hosted organization agents may use staged or follow-published deployment"), {
      statusCode: 400,
      code: "RELEASE_MODE_NOT_ALLOWED",
    });
  }
}
