import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { PostgresConversationEventNotifications } from "../src/events/postgres-conversation-notifications";

describe("conversation event notifications", () => {
  it("uses one PostgreSQL listener and fans out bounded conversation changes", async () => {
    const client = new EventEmitter() as EventEmitter & {
      query: ReturnType<typeof vi.fn>;
      release: ReturnType<typeof vi.fn>;
    };
    client.query = vi.fn(async () => ({ rows: [] }));
    client.release = vi.fn();
    const notifications = new PostgresConversationEventNotifications({ connect: vi.fn(async () => client) } as never);
    const received: unknown[] = [];

    const unsubscribe = await notifications.subscribe((event) => received.push(event));
    client.emit("notification", {
      channel: "agent_conversation_events",
      payload: JSON.stringify({ organizationId: "org-1", subject: "conversation:conversation-1", eventType: "conversation.message.changed" }),
    });
    client.emit("notification", { channel: "another_channel", payload: "{}" });

    expect(client.query).toHaveBeenCalledWith("LISTEN agent_conversation_events");
    expect(received).toEqual([{ organizationId: "org-1", subject: "conversation:conversation-1", eventType: "conversation.message.changed" }]);

    unsubscribe();
    await notifications.close();
    expect(client.query).toHaveBeenCalledWith("UNLISTEN agent_conversation_events");
    expect(client.release).toHaveBeenCalled();
  });
});
