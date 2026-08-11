import { describe, expect, it } from "vitest";
import { signWebhookPayload, verifyWebhookSignature } from "../src/channels/webhook-security";

describe("webhook signature verification", () => {
  it("verifies signed payloads and rejects tampering or replay", () => {
    const signature = signWebhookPayload('{"id":"event-1"}', "secret", 1_000);
    expect(verifyWebhookSignature({ rawBody: '{"id":"event-1"}', signature, secret: "secret", now: 1_010 })).toEqual({ timestamp: 1_000 });
    expect(() => verifyWebhookSignature({ rawBody: '{"id":"event-2"}', signature, secret: "secret", now: 1_010 })).toThrow("mismatch");
    expect(() => verifyWebhookSignature({ rawBody: '{"id":"event-1"}', signature, secret: "secret", now: 1_400 })).toThrow("replay window");
  });
});
