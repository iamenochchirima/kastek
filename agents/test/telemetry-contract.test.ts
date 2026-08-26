import { describe, expect, it } from "vitest";
import { operationalLogRedaction, operationalLogSerializers } from "../src/telemetry/logger";
import { redactTelemetryText } from "../src/telemetry/redaction";
import { boundedAttribute } from "../src/telemetry/spans";

describe("telemetry contract", () => {
  it("bounds span attribute values", () => {
    expect(boundedAttribute("x".repeat(200), 128)).toHaveLength(128);
    expect(boundedAttribute(undefined)).toBe("unknown");
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
