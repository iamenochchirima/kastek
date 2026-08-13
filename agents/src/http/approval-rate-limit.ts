interface WindowEntry {
  count: number;
  resetAt: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Small bounded fixed-window limiter for approval commands. Approval decisions
 * are already serialized by PostgreSQL; this protects the HTTP boundary from
 * repeated decision attempts before they reach that durable state machine.
 */
export class ApprovalDecisionRateLimiter {
  private readonly entries = new Map<string, WindowEntry>();

  public constructor(
    private readonly maxAttempts = 5,
    private readonly windowMs = 60_000,
    private readonly maxKeys = 10_000,
  ) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error("Approval rate limit must allow at least one attempt");
    if (!Number.isInteger(windowMs) || windowMs < 1) throw new Error("Approval rate-limit window must be positive");
    if (!Number.isInteger(maxKeys) || maxKeys < 1) throw new Error("Approval rate-limit key bound must be positive");
  }

  public consume(key: string, now = Date.now()): RateLimitDecision {
    const existing = this.entries.get(key);
    const entry = existing && existing.resetAt > now
      ? existing
      : { count: 0, resetAt: now + this.windowMs };
    if (!existing || existing.resetAt <= now) this.entries.set(key, entry);

    if (entry.count >= this.maxAttempts) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
      };
    }
    entry.count += 1;
    this.trim(now);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private trim(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key);
    }
    while (this.entries.size > this.maxKeys) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest !== "string") break;
      this.entries.delete(oldest);
    }
  }
}
