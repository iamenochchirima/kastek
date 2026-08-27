import { describe, expect, it } from "vitest";
import { isStableEventName, normalizeOperationalEvent, operationalLogRedaction, operationalLogSerializers } from "../src/telemetry/logger";
import { redactTelemetryText } from "../src/telemetry/redaction";
import { boundedAttribute } from "../src/telemetry/spans";

describe("telemetry contract", () => {
  it("bounds span attribute values", () => {
    expect(boundedAttribute("x".repeat(200), 128)).toHaveLength(128);
    expect(boundedAttribute(undefined)).toBe("unknown");
  });

  it("requires lowercase dot-separated operational event names", () => {
    expect(isStableEventName("queue.item.completed")).toBe(true);
    expect(isStableEventName("kasiai.bootstrap.completed")).toBe(true);
    expect(isStableEventName("kasiai.release.gate.failed")).toBe(true);
    expect(isStableEventName("queue_item_completed")).toBe(false);
    expect(isStableEventName("operation.invalid.event")).toBe(true);
  });

  it("normalizes invalid event names without throwing or preserving unbounded text", () => {
    expect(normalizeOperationalEvent({ event: "queue_item_completed", detail: "safe" })).toEqual({
      event: "operation.invalid.event",
      invalid_event: "queue_item_completed",
      detail: "safe",
    });
  });

  it("keeps credential and content fields on the prohibited-field list", () => {
    expect(operationalLogRedaction.paths).toEqual(expect.arrayContaining([
      "authorization",
      "apiKey",
      "access_token",
      "password",
      "body.messages",
      "body.prompt",
    ]));
  });

  it("keeps request and error summaries bounded", () => {
    expect(operationalLogSerializers.req({ method: "GET", url: "/health?token=secret", id: "req-1" })).toMatchObject({
      method: "GET",
      url: "/health",
    });
    expect(operationalLogSerializers.err({ name: "Error", code: "PROVIDER_ERROR", message: "x".repeat(600), stack: "s".repeat(5_000) })).toEqual({
      type: "Error",
      code: "PROVIDER_ERROR",
      message: "x".repeat(512),
      stack: "s".repeat(4_096),
    });
  });

  it("redacts credential material from exception text", () => {
    expect(redactTelemetryText("request failed authorization=Bearer abc123&token=secret", 512))
      .toBe("request failed authorization=[REDACTED]&token=[REDACTED]");
  });
});
