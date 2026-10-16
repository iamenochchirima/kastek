export type ToolFailureClass = "retryable" | "terminal" | "waiting" | "blocked" | "interrupted" | "unknown";

export interface ToolFailureInput {
  code: string;
  message?: string;
  effectStarted?: boolean;
}

const retryableCodePatterns = [
  /(?:^|_)(?:TIMEOUT|TIMED_OUT|RATE_LIMIT(?:ED)?|THROTTLED|UNAVAILABLE|TEMPORARY|TRANSIENT|NETWORK|CONNECTION|ECONNRESET|ECONNREFUSED|ETIMEDOUT)(?:$|_)/i,
  /^(?:5(?:02|03|04)|429)$/,
  /(?:PROVIDER|UPSTREAM|REMOTE).*(?:TIMEOUT|UNAVAILABLE|RATE|TEMPORARY|TRANSIENT)/i,
];

const waitingCodes = new Set(["APPROVAL_REQUIRED", "HANDOFF_REQUIRED", "EXTERNAL_EVENT_REQUIRED"]);

const interruptedCodePatterns = [
  /(?:CANCEL(?:LED|ED)?|ABORT(?:ED)?|INTERRUPT(?:ED)?|WORKER_LOST|ACTIVITY_SHUTDOWN|SHUTDOWN)/i,
];

const blockedCodePatterns = [
  /(?:NOT_FOUND|NOT_GRANTED|NOT_CONFIGURED|NOT_CONNECTED|UNAUTHORIZED|FORBIDDEN|INVALID|MISMATCH|SCHEMA|POLICY|KILL_SWITCH|EFFECT_FLAG|EFFECT_HOLD|INSTALLATION_NOT_ACTIVE|SESSION_LEASE_FENCED)/i,
];

export function classifyToolFailure(input: ToolFailureInput): ToolFailureClass {
  if (input.effectStarted) return "unknown";
  if (waitingCodes.has(input.code)) return "waiting";
  if (interruptedCodePatterns.some((pattern) => pattern.test(input.code))) return "interrupted";
  if (blockedCodePatterns.some((pattern) => pattern.test(input.code))) return "blocked";
  if (retryableCodePatterns.some((pattern) => pattern.test(input.code))) return "retryable";
  return "terminal";
}
