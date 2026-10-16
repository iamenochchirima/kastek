import { describe, expect, it } from "vitest";
import { buildApprovalResourceSnapshot, buildApprovalResourceSnapshotFromCore, projectContentApprovalOperation, projectContentApprovalResource } from "../src/temporal/activities";
import { buildDomainApprovalSnapshot, projectBookingApprovalResource, projectCampaignApprovalResource, projectDomainApprovalOperation } from "../src/approval/domain-preview";

describe("approval preview projection", () => {
  it("keeps stable resource selectors and excludes content, credentials, and metadata", () => {
    expect(buildApprovalResourceSnapshot("kasitek.core.content_post_publish", {
      postId: "post-123",
      platform: "X",
      content: "private provider payload",
      metadata: { secret: "must not persist" },
      accessToken: "token-value",
    })).toEqual({
      capability: "kasitek.core.content_post_publish",
      request: { postId: "post-123", platform: "X" },
    });
  });

  it("shows the proposed calendar event without credentials or arbitrary payloads", () => {
    expect(buildApprovalResourceSnapshot("kasitek.calendar.create", { source: "internal", title: "Demo booking", start: "2026-10-07T10:00:00Z", end: "2026-10-07T10:30:00Z", timezone: "UTC", location: "Online", accessToken: "secret", metadata: { secret: "hidden" }, idempotencyKey: "private-key" })).toEqual({
      capability: "kasitek.calendar.create", request: { source: "internal", title: "Demo booking", start: "2026-10-07T10:00:00Z", end: "2026-10-07T10:30:00Z", timezone: "UTC", location: "Online" },
    });
  });

  it("shows a bounded remote booking reference while omitting arbitrary remote payloads", () => {
    expect(buildApprovalResourceSnapshot("remote_mcp.version.lookup", { reference: "BOOK-739", apiKey: "hidden", body: "private" }))
      .toEqual({ capability: "remote_mcp.version.lookup", request: { reference: "BOOK-739" } });
  });

  it("bounds string selectors without changing the effect argument hash", () => {
    const preview = buildApprovalResourceSnapshot("kasitek.core.content_post_schedule", {
      postId: "post-123",
      scheduledFor: "2026-08-14T12:00:00Z",
      content: "x".repeat(10_000),
    });
    expect(String((preview.request as Record<string, unknown>).scheduledFor)).toBe("2026-08-14T12:00:00Z");
    expect(JSON.stringify(preview)).not.toContain("x".repeat(100));
  });

  it("projects the reviewed content without persisting provider jobs or metadata", () => {
    const preview = buildApprovalResourceSnapshot("kasitek.core.content_post_publish", {
      postId: "post-123",
      platform: "X",
    }, {
      kind: "content_post",
      revision: "content-post.v1",
      ...projectContentApprovalResource({
        id: "post-123",
        title: "Launch update",
        content: "A reviewed launch update",
        channels: ["X"],
        status: "DRAFT",
        variants: [{ platform: "X", content: "A reviewed launch update", status: "DRAFT" }],
        publishJobs: [{ providerReceipt: "must not persist" }],
        metadata: { secret: "must not persist" },
      }),
    });
    expect(preview).toMatchObject({
      resource: {
        kind: "content_post",
        postId: "post-123",
        title: "Launch update",
        contentPreview: "A reviewed launch update",
        variants: [{ platform: "X", contentPreview: "A reviewed launch update", status: "DRAFT" }],
      },
    });
    expect(JSON.stringify(preview)).not.toContain("providerReceipt");
    expect(JSON.stringify(preview)).not.toContain("must not persist");
  });

  it("projects the requested transition for every enabled content effect", () => {
    const post = {
      id: "post-123",
      content: "Reviewed copy",
      channels: ["X"],
      status: "DRAFT",
      scheduled_for: "2026-08-15T12:00:00Z",
    };
    expect(projectContentApprovalOperation("kasitek.core.content_post_publish", { platform: "X" }, post)).toEqual({
      type: "publish",
      postId: "post-123",
      fromStatus: "DRAFT",
      platform: "X",
      targetStatus: "PUBLISHED",
    });
    expect(projectContentApprovalOperation("kasitek.core.content_post_schedule", { scheduledFor: "2026-08-16T12:00:00Z" }, post)).toEqual({
      type: "schedule",
      postId: "post-123",
      fromStatus: "DRAFT",
      scheduledFor: "2026-08-16T12:00:00Z",
      targetStatus: "SCHEDULED",
    });
    expect(projectContentApprovalOperation("kasitek.core.content_post_unschedule", {}, { ...post, status: "SCHEDULED" })).toEqual({
      type: "unschedule",
      postId: "post-123",
      fromStatus: "SCHEDULED",
      currentScheduledFor: "2026-08-15T12:00:00Z",
      targetStatus: "DRAFT",
    });
    expect(projectContentApprovalOperation("kasitek.core.content_post_delete", {}, post)).toEqual({
      type: "delete",
      postId: "post-123",
      fromStatus: "DRAFT",
      targetStatus: "DELETED",
    });
    expect(projectContentApprovalOperation("kasitek.core.content_post_delete_published", { platform: "THREADS" }, { ...post, status: "PUBLISHED" })).toEqual({
      type: "delete_published",
      postId: "post-123",
      fromStatus: "PUBLISHED",
      platform: "THREADS",
      targetStatus: "DELETED_FROM_PLATFORMS",
    });
  });

  it("includes the operation in the immutable content resource preview", async () => {
    const coreClient = {
      getContentPost: async () => ({
        post: {
          id: "post-123",
          content: "Reviewed copy",
          channels: ["X"],
          status: "DRAFT",
          variants: [],
        },
      }),
    } as never;
    const preview = await buildApprovalResourceSnapshotFromCore(coreClient, {
      organizationId: "org-1",
      agentId: "agent-1",
      agentVersionId: "version-1",
      installationId: "install-1",
      runId: "run-1",
      correlationId: "corr-1",
    }, "kasitek.core.content_post_publish", { postId: "post-123", platform: "X" });
    expect(preview).toMatchObject({
      resource: {
        revision: "content-post.v1",
        operation: {
          type: "publish",
          platform: "X",
          targetStatus: "PUBLISHED",
        },
      },
    });
  });

  it("includes the fixed batch targets and snapshot used for one approval", async () => {
    const coreClient = {
      getContentPost: async () => ({
        post: {
          id: "post-123",
          title: "Launch",
          content: "Reviewed copy",
          channels: ["INSTAGRAM", "X"],
          status: "DRAFT",
          variants: [{ platform: "X", content: "Short copy", status: "DRAFT" }],
          media: [{ assetId: "asset-1", kind: "IMAGE", processingStatus: "READY", scanStatus: "CLEAN" }],
        },
      }),
      preflightContentPublishBatch: async () => ({
        postId: "post-123",
        status: "READY",
        snapshotHash: "snapshot-123",
        mediaCount: 1,
        targets: [
          { platform: "INSTAGRAM", accountName: "KasiTek", handle: "@kasiteklabs", state: "READY", status: "READY", requiredCapability: "MEDIA_PUBLISH" },
          { platform: "X", accountName: "KasiTek Labs", state: "READY", status: "READY", requiredCapability: "MEDIA_PUBLISH" },
        ],
      }),
    } as never;
    const preview = await buildApprovalResourceSnapshotFromCore(coreClient, {
      organizationId: "org-1",
      agentId: "agent-1",
      agentVersionId: "version-1",
      installationId: "install-1",
      runId: "run-1",
      correlationId: "corr-1",
    }, "kasitek.core.content_post_publish_batch", { postId: "post-123" });
    expect(preview).toMatchObject({
      resource: {
        batchPreflight: {
          status: "READY",
          snapshotHash: "snapshot-123",
          targets: [
            { platform: "INSTAGRAM", accountName: "KasiTek", state: "READY" },
            { platform: "X", accountName: "KasiTek Labs", state: "READY" },
          ],
        },
        operation: {
          type: "publish_batch",
          targetCount: 2,
          preflightStatus: "READY",
          snapshotHash: "snapshot-123",
        },
      },
    });
  });

  it("fails closed when an enabled content effect cannot load its preview", async () => {
    const coreClient = { getContentPost: async () => { throw new Error("unavailable"); } } as never;
    await expect(buildApprovalResourceSnapshotFromCore(coreClient, {
      organizationId: "org-1",
      agentId: "agent-1",
      agentVersionId: "version-1",
      installationId: "install-1",
      runId: "run-1",
      correlationId: "corr-1",
    }, "kasitek.core.content_post_delete", { postId: "post-123" })).rejects.toThrow("CONTENT_PREVIEW_UNAVAILABLE");
  });

  it("projects send/reply operations without persisting provider credentials", () => {
    const preview = buildDomainApprovalSnapshot("kasitek.core.channel_deliver", {
      channelType: "whatsapp",
      externalConversationId: "thread-1",
      text: "A customer-facing reply",
      accessToken: "must not persist",
    });
    expect(preview).toMatchObject({ operation: { domain: "channel", type: "send_or_reply", channelType: "whatsapp", targetStatus: "sent" }, request: { channelType: "whatsapp", externalConversationId: "thread-1" } });
    expect(JSON.stringify(preview)).not.toContain("accessToken");
    expect(JSON.stringify(preview)).toContain("A customer-facing reply");
  });

  it("projects bounded campaign and booking resource previews", () => {
    const campaign = projectCampaignApprovalResource({ id: "campaign-1", name: "Launch", status: "SCHEDULED", scheduledAt: "2026-08-20T10:00:00Z", totalRecipients: 40, recipientPhone: "+secret" });
    expect(campaign).toMatchObject({ campaignId: "campaign-1", name: "Launch", status: "SCHEDULED", totalRecipients: 40 });
    expect(JSON.stringify(campaign)).not.toContain("recipientPhone");
    const booking = projectBookingApprovalResource({ id: "booking-1", serviceName: "Consultation", customerName: "Ada", contactName: "Ada", contactPhone: "+secret", scheduledStart: "2026-08-20T10:00:00Z", scheduledEnd: "2026-08-20T11:00:00Z", timezone: "Africa/Johannesburg", status: "SCHEDULED" });
    expect(booking).toMatchObject({ bookingId: "booking-1", serviceName: "Consultation", customerName: "Ada", status: "SCHEDULED" });
    expect(JSON.stringify(booking)).not.toContain("contactPhone");
    expect(projectDomainApprovalOperation("kasitek.core.campaign_pause", { campaignId: "campaign-1", action: "pause" }, campaign)).toMatchObject({ domain: "campaign", type: "campaign_transition", fromStatus: "SCHEDULED", targetStatus: "PAUSED" });
    expect(projectDomainApprovalOperation("kasitek.core.booking_cancel", { bookingId: "booking-1", action: "cancel" }, booking)).toMatchObject({ domain: "booking", targetStatus: "CANCELLED" });
  });

  it("loads campaign and booking previews through organization-scoped core reads", async () => {
    const coreClient = {
      getCampaignSummary: async () => ({ campaign: { id: "campaign-1", name: "Launch", status: "SCHEDULED" } }),
      getBooking: async () => ({ booking: { id: "booking-1", serviceName: "Consultation", status: "SCHEDULED" } }),
    } as never;
    const context = { organizationId: "org-1", agentId: "agent-1", agentVersionId: "version-1", installationId: "install-1", runId: "run-1", correlationId: "corr-1" };
    await expect(buildApprovalResourceSnapshotFromCore(coreClient, context, "kasitek.core.campaign_pause", { campaignId: "campaign-1", action: "pause" })).resolves.toMatchObject({ resource: { kind: "campaign", campaignId: "campaign-1", status: "SCHEDULED" }, operation: { targetStatus: "PAUSED" } });
    await expect(buildApprovalResourceSnapshotFromCore(coreClient, context, "kasitek.core.booking_cancel", { bookingId: "booking-1", action: "cancel" })).resolves.toMatchObject({ resource: { kind: "booking", bookingId: "booking-1", status: "SCHEDULED" }, operation: { targetStatus: "CANCELLED" } });
  });
});
