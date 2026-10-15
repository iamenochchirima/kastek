export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

interface Bucket {
  count: number;
  resetAt: number;
}

export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  public constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("rate limit must be a positive integer");
    if (!Number.isInteger(windowMs) || windowMs < 1_000) throw new Error("rate-limit window must be at least one second");
    if (!Number.isInteger(maxKeys) || maxKeys < 1) throw new Error("rate-limit max keys must be positive");
  }

  public consume(key: string, now = Date.now()): RateLimitDecision {
    const existing = this.buckets.get(key);
    const bucket = existing && existing.resetAt > now
      ? existing
      : { count: 0, resetAt: now + this.windowMs };
    bucket.count += 1;
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    this.prune(now);
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1_000));
    return { allowed: bucket.count <= this.limit, retryAfterSeconds };
  }

  public size(): number {
    return this.buckets.size;
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now || this.buckets.size > this.maxKeys) this.buckets.delete(key);
      if (this.buckets.size <= this.maxKeys) break;
    }
  }
}
