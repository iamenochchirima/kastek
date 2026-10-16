import { describe, expect, it } from "vitest";
import { FixedWindowRateLimiter } from "../src/gateway/rate-limit";

describe("gateway rate limiter", () => {
  it("allows a fixed window and reports retry timing after the limit", () => {
    const limiter = new FixedWindowRateLimiter(2, 10_000);
    expect(limiter.consume("key", 1_000)).toMatchObject({ allowed: true });
    expect(limiter.consume("key", 2_000)).toMatchObject({ allowed: true });
    expect(limiter.consume("key", 3_000)).toMatchObject({ allowed: false, retryAfterSeconds: 8 });
    expect(limiter.consume("key", 11_000)).toMatchObject({ allowed: true });
  });

  it("bounds tracked keys while keeping active keys usable", () => {
    const limiter = new FixedWindowRateLimiter(2, 10_000, 2);
    limiter.consume("one", 1_000);
    limiter.consume("two", 1_000);
    limiter.consume("three", 1_000);
    expect(limiter.size()).toBeLessThanOrEqual(2);
  });
});
