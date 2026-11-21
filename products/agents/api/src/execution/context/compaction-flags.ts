export type CompactionPolicy = "pressure" | "off";

export interface CompactionFlags {
  /** `pressure` enables automatic compaction; `off` keeps route windowing only. */
  policy: CompactionPolicy;
  /** Allow optional background summaries. */
  background: boolean;
  /** Allow the explicit Compact context action. */
  manual: boolean;
}

function bool(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`Invalid ${name}: use true or false`);
}

/** Rollout switches are read at the operation boundary so a restart changes policy without a schema change. */
export function compactionFlags(environment: NodeJS.ProcessEnv = process.env): CompactionFlags {
  const raw = environment.AGENTS_COMPACTION_POLICY?.trim().toLowerCase() || "pressure";
  if (raw !== "pressure" && raw !== "off") throw new Error("Invalid AGENTS_COMPACTION_POLICY: use pressure or off");
  return {
    policy: raw,
    background: bool(environment.AGENTS_COMPACTION_BACKGROUND, true, "AGENTS_COMPACTION_BACKGROUND"),
    manual: bool(environment.AGENTS_COMPACTION_MANUAL, true, "AGENTS_COMPACTION_MANUAL"),
  };
}
