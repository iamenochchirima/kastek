export type FailureClass = "retryable" | "terminal";

const retryableCodes = new Set([
  "MODEL_TIMEOUT",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_UNAVAILABLE",
  "CORE_TIMEOUT",
  "CORE_REQUEST_FAILED",
  "TOOL_TIMEOUT",
  "DATABASE_UNAVAILABLE",
  "WORKFLOW_ACTIVITY_FAILED",
]);

export function classifyFailureCode(code: string): FailureClass {
  return retryableCodes.has(code) ? "retryable" : "terminal";
}
