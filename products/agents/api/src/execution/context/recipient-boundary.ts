import { PlatformError } from "../../contracts/contracts";

/** Customer channel generation must never inherit a staff or automation principal. */
export function assertCustomerChannelRecipient(product: string, principal: { kind: string }, binding: unknown): void {
  if (binding && (product !== "agents" || !["visitor", "channel_customer"].includes(principal.kind))) {
    throw new PlatformError("CHANNEL_SCOPE_DENIED", 403, "Customer channel execution is unavailable");
  }
}
