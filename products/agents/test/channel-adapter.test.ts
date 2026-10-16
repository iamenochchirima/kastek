import { describe, expect, it } from "vitest";
import { PlatformChannelAdapter } from "../src/channels/types";

describe("platform channel adapter", () => {
  it("normalizes a canonical sidebar message", () => {
    const event = new PlatformChannelAdapter().normalizeInbound({
      providerEventId: "event-1",
      externalIdentity: "user-1",
      externalConversationId: "conversation-1",
      message: { content: { text: "hello" }, providerMessageId: "message-1" },
    });
    expect(event).toMatchObject({ channelType: "platform", message: { direction: "inbound", messageType: "text", providerMessageId: "message-1" } });
  });
});
