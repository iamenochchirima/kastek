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
      "kasitek.core.content_posts_list",
      "kasitek.core.content_post_get",
      "kasitek.core.content_post_update",
      "kasitek.core.content_post_draft",
      "kasitek.core.content_post_publish",
      "kasitek.core.content_post_schedule",
    ]);
    expect(manifests[1]?.manifest).toMatchObject({ ownerService: "kasitek-core", requiredScope: "customers.read" });
    expect(manifests[3]?.manifest).toMatchObject({ ownerService: "kasitek-core", requiredScope: "bookings.read", idempotency: "not_applicable" });
    expect(manifests[6]?.manifest).toMatchObject({ ownerService: "kasitek-core", requiredScope: "content.write", idempotency: "not_applicable" });
    expect(manifests[7]?.manifest).toMatchObject({ ownerService: "kasitek-core", requiredScope: "content.write", idempotency: "required" });
    expect(manifests[8]?.manifest).toMatchObject({ ownerService: "kasitek-core", requiredScope: "content.publish", approval: "always", execution: "durable" });
    expect(manifests[9]?.manifest).toMatchObject({ ownerService: "kasitek-core", requiredScope: "content.publish", approval: "always", execution: "durable" });
  });
});
