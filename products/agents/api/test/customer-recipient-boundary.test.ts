import { describe, expect, it } from "vitest";
import { assertCustomerChannelRecipient } from "../src/execution/context/recipient-boundary";

describe("customer channel recipient", () => {
  const binding = { customerConversationId: "conversation" };

  it.each(["visitor", "channel_customer"])("admits a customer principal (%s)", kind => {
    expect(() => assertCustomerChannelRecipient("agents", { kind }, binding)).not.toThrow();
  });

  it.each(["human", "automation"])("denies a staff or automation principal (%s)", kind => {
    expect(() => assertCustomerChannelRecipient("agents", { kind }, binding)).toThrowError(
      expect.objectContaining({ code: "CHANNEL_SCOPE_DENIED" }),
    );
    expect(() => assertCustomerChannelRecipient("agents", { kind }, null)).not.toThrow();
  });

  it("does not bind a product-owned task to an Agents customer channel", () => {
    expect(() => assertCustomerChannelRecipient("growth", { kind: "visitor" }, binding)).toThrowError(
      expect.objectContaining({ code: "CHANNEL_SCOPE_DENIED" }),
    );
  });
});
