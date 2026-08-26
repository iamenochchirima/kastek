import { describe, expect, it } from "vitest";
import {
  correlationIdFromHeader,
  currentCorrelationHeaders,
  currentCorrelationId,
  normalizeCorrelationId,
  runWithCorrelationId,
} from "../src/telemetry/context";

describe("telemetry correlation context", () => {
  it("accepts bounded header-safe IDs and rejects unsafe values", () => {
    expect(normalizeCorrelationId("run-123:attempt_1")).toBe("run-123:attempt_1");
    expect(normalizeCorrelationId(" contains spaces ")).toBeUndefined();
    expect(normalizeCorrelationId("x".repeat(129))).toBeUndefined();
    expect(normalizeCorrelationId({})).toBeUndefined();
  });

  it("generates an ID when a caller sends a malformed or missing header", () => {
    expect(correlationIdFromHeader("bad value")).toMatch(/^[0-9a-f-]{36}$/);
    expect(correlationIdFromHeader(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keeps the correlation ID available to asynchronous operational work", async () => {
    await runWithCorrelationId("request-42", async () => {
      await Promise.resolve();
      expect(currentCorrelationId()).toBe("request-42");
      expect(currentCorrelationHeaders()).toEqual({ "x-correlation-id": "request-42" });
    });
    expect(currentCorrelationId()).toBeUndefined();
  });
});
