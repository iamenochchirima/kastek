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
