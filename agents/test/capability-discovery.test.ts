import { describe, expect, it } from "vitest";
import { createDefaultTools } from "../src/temporal/activities";

describe("capability discovery", () => {
  it("contains manifest metadata for the default platform tools", () => {
    const manifests = createDefaultTools().manifests();
    expect(manifests.map((manifest) => manifest.name)).toEqual([
      "platform.current_time",
      "kasitek.core.customer_get",
      "kasitek.core.workspace_status",
      "kasitek.core.booking_services_list",
      "kasitek.core.bookings_list",
      "kasitek.core.booking_get",
      "kasitek.core.campaigns_list",
      "kasitek.core.campaign_summary",
      "kasitek.core.templates_list",
      "kasitek.core.contacts_list",
      "kasitek.core.inbox_conversations_list",
      "kasitek.core.inbox_messages_list",
      "kasitek.core.channel_deliver",
      "kasitek.core.content_posts_list",
      "kasitek.core.content_post_get",
      "kasitek.core.content_post_update",
      "kasitek.core.content_post_draft",
      "kasitek.core.content_post_publish",
      "kasitek.core.content_post_schedule",
      "kasitek.core.content_post_unschedule",
      "kasitek.core.content_post_delete",
    ]);
    expect(manifests[1]?.manifest).toMatchObject({ ownerService: "kasitek-core", requiredScope: "customers.read" });
    expect(manifests[3]?.manifest).toMatchObject({ ownerService: "kasitek-core", requiredScope: "bookings.read", idempotency: "not_applicable" });
    expect(manifests[4]?.manifest).toMatchObject({ ownerService: "kasitek-core", requiredScope: "bookings.read", idempotency: "not_applicable" });
    expect(manifests[5]?.manifest).toMatchObject({ ownerService: "kasitek-core", requiredScope: "bookings.read", resourceSelector: { type: "booking" } });
    expect(manifests[6]?.manifest).toMatchObject({ ownerService: "kasitek-core", requiredScope: "campaigns.read", idempotency: "not_applicable" });
    expect(manifests[7]?.manifest).toMatchObject({ ownerService: "kasitek-core", requiredScope: "campaigns.read", resourceSelector: { type: "campaign" } });
    expect(manifests[8]?.manifest).toMatchObject({ ownerService: "kasitek-core", requiredScope: "templates.read", idempotency: "not_applicable" });
    expect(manifests[9]?.manifest).toMatchObject({ ownerService: "kasitek-core", requiredScope: "contacts.read", idempotency: "not_applicable" });
    expect(manifests[10]?.manifest).toMatchObject({ ownerService: "kasitek-core", requiredScope: "inbox.read", idempotency: "not_applicable" });
    expect(manifests[11]?.manifest).toMatchObject({ ownerService: "kasitek-core", requiredScope: "inbox.read", idempotency: "not_applicable" });
    expect(manifests[12]?.manifest).toMatchObject({ ownerService: "kasitek-core", requiredScope: "channels.write", approval: "always", execution: "durable", resourceSelector: { type: "conversation" } });
    expect(manifests[15]?.manifest).toMatchObject({ ownerService: "kasitek-core", requiredScope: "content.write", idempotency: "not_applicable" });
    expect(manifests[16]?.manifest).toMatchObject({ ownerService: "kasitek-core", requiredScope: "content.write", idempotency: "required" });
    expect(manifests[17]?.manifest).toMatchObject({ ownerService: "kasitek-core", requiredScope: "content.publish", approval: "always", execution: "durable" });
    expect(manifests[18]?.manifest).toMatchObject({ ownerService: "kasitek-core", requiredScope: "content.publish", approval: "always", execution: "durable" });
  });
});
