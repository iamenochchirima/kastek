export const agentActiveStates = new Set(["accepted", "queued", "working", "running", "waiting_children", "reconciling", "waiting_review", "waiting_authority", "cancel_requested"]);

export function agentIsActive(state: string): boolean {
  return agentActiveStates.has(state);
}

export function formatAgentDuration(milliseconds: number | null | undefined): string | null {
  if (milliseconds == null || !Number.isFinite(milliseconds) || milliseconds < 0) return null;
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 1) return "<1s";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60), remainder = seconds % 60;
  if (minutes < 60) return `${minutes}m${remainder ? ` ${remainder}s` : ""}`;
  const hours = Math.floor(minutes / 60), remainingMinutes = minutes % 60;
  return `${hours}h${remainingMinutes ? ` ${remainingMinutes}m` : ""}`;
}

export function agentStateLabel(state: string): string {
  return ({ accepted: "Accepted", queued: "Queued", working: "Working", running: "Working", started: "Running", waiting_children: "Specialists are working", waiting_review: "Needs review", waiting_authority: "Access required", waiting_input: "Needs your input", waiting_capacity: "Waiting for capacity", reconciling: "Checking outcome", cancel_requested: "Stopping", completed: "Finished", incomplete: "Incomplete", failed: "Failed", cancelled: "Stopped", uncertain: "Outcome unknown", refused: "Not permitted" } as Record<string, string>)[state] ?? state.replaceAll("_", " ");
}

/** Sequence values are opaque decimal IDs, not JavaScript floating-point numbers. */
export function mergeAgentEntries<T extends { id: string; revision?: string | number }>(previous: T[], incoming: T[]): T[] {
  const merged = new Map(previous.map(entry => [entry.id, entry]));
  for (const entry of incoming) {
    const current = merged.get(entry.id);
    if (current?.revision !== undefined && entry.revision !== undefined) {
      const before = String(current.revision), after = String(entry.revision);
      if (/^\d+$/.test(before) && /^\d+$/.test(after) && BigInt(after) < BigInt(before)) continue;
    }
    merged.set(entry.id, entry);
  }
  return [...merged.values()];
}

export function safeAgentLink(href: string): string | null {
  if (/[\u0000-\u0020\u007f\\]/.test(href)) return null;
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  if (href.startsWith("#")) return href;
  try {
    const url = new URL(href);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function orderAgentEntries<T extends { createdAt?: string; startedAt?: string }>(entries: T[]): T[] {
  const time = (entry: T) => { const value = Date.parse(entry.createdAt ?? entry.startedAt ?? ""); return Number.isFinite(value) ? value : Infinity; };
  return entries.map((entry, index) => ({ entry, index, time: time(entry) }))
    .sort((left, right) => left.time - right.time || left.index - right.index).map(item => item.entry);
}

const agentFailures: Record<string, string> = {
  CAPACITY_WAIT_EXPIRED: "The task waited too long to start. Try a new message.",
  CHILD_OUTCOME_UNCERTAIN: "A specialist outcome could not be confirmed. Review its result before repeating work.",
  ROOT_LIMIT: "An execution limit was reached.",
  MODEL_CALL_LIMIT: "This agent reached its model request limit.",
  ROOT_MODEL_CALL_LIMIT: "This work reached its shared model request limit.",
  TOOL_CALL_LIMIT: "This agent reached its tool call limit.",
  ROOT_TOOL_CALL_LIMIT: "This work reached its shared tool call limit.",
  SPECIALIST_TASK_LIMIT: "The specialist task limit was reached.",
  ROOT_TOKEN_LIMIT: "This work reached its token allowance.",
  TASK_TOKEN_LIMIT: "This agent reached its token allowance.",
  MODEL_COST_LIMIT: "The model spending allowance was reached.",
  SPECIALIST_ALLOCATION_LIMIT: "The specialist allocation cannot cover the next operation.",
  QUOTA_EXCEEDED: "The organization usage allowance was reached.",
  ROOT_DURATION_LIMIT: "This work reached its active time allowance.",
  TASK_DURATION_LIMIT: "This agent reached its active time allowance.",
  AUTHORITY_EXPIRED: "Task access expired.",
  PRODUCT_AUTHORITY_INACTIVE: "Task access expired or was revoked.",
  CAPABILITY_RESULT_INVALID: "Unable to read a tool result.",
  TOOL_SCHEMA_STALE: "The tool changed. Try again.",
  TOOL_SCHEMA_NOT_LOADED: "The required tool could not be loaded.",
  CONTEXT_CAPACITY: "The next request could not fit the model context.",
  CONTEXT_MANDATORY_OVERFLOW: "The required instructions exceed this model's context. Use a larger model or shorten them.",
  CONTEXT_INVALIDATED: "Source access or memory changed. Start a new message to rebuild the context.",
  COMPACTION_INPUT_LIMIT: "The conversation could not be compacted within the model context.",
  COMPACTION_NO_PROGRESS: "Context compaction could not make room for more work.",
  MODEL_RATE_LIMITED: "The model provider is busy. Try again later.",
  CONTEXT_LIMIT: "The request exceeded the available context. Try a smaller request.",
  ORCHESTRATION_STALLED: "Progress paused after repeated unsuccessful attempts.",
  TASK_DEADLINE: "The task reached its time limit.",
  MODEL_PROVIDER_UNAVAILABLE: "The model is unavailable. Try again later.",
  MODEL_ACCESS_DENIED: "The model provider denied access to this model.",
  MODEL_REQUEST_INVALID: "The model provider rejected this request.",
  MODEL_AUTHENTICATION_FAILED: "The model provider rejected authentication.",
  MODEL_USE_DENIED: "This agent is not authorized to use the model connection.",
  INTERNAL_ERROR: "The task could not finish. Try a new message.",
  CHILD_PARTIAL_FAILURE: "Some specialist work could not finish.",
  GRANT_REVOKED: "Task access was revoked.",
};
export function agentFailureLabel(state:string,code:string|null|undefined):string {
  if(code==="CHILD_OUTCOME_UNCERTAIN")return agentFailures.CHILD_OUTCOME_UNCERTAIN;
  if(state==="uncertain"&&code?.startsWith("MODEL_"))return "The model response was interrupted. Review completed work before continuing.";
  if(state==="uncertain")return "Outcome unknown. An action may have completed. Check its result before repeating it.";
  return code&&agentFailures[code]?agentFailures[code]:agentStateLabel(state);
}
