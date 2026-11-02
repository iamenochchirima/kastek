export type GrowthOperationEffect = "read" | "draft" | "external_effect" | "destructive";
export type GrowthOperationScope = "growth:read" | "growth:draft" | "growth:publish" | "growth:manage";
export interface GrowthOperationDefinition {
  name: string;
  version: "1";
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  effect: GrowthOperationEffect;
  scope: GrowthOperationScope;
  entitlement: string | null;
  requiredEntitlements: string[];
  idempotency: "not_applicable" | "required";
  review: "none" | "required";
  resourceFields: string[];
  stagingControl?: boolean;
}
const object = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const text = (maxLength = 256) => ({ type: "string", minLength: 1, maxLength });
const id = text();
const dateTime = { type: "string", format: "date-time", maxLength: 64 };
const page = { limit: { type: "integer", minimum: 1, maximum: 100 }, cursor: { type: "integer", minimum: 0, maximum: 1_000_000 } };
const search = { ...page, search: { type: "string", maxLength: 200 }, status: { type: "string", maxLength: 40 } };
const platforms = ["FACEBOOK", "INSTAGRAM", "THREADS", "TIKTOK", "BLUESKY", "LINKEDIN", "X"];
const platform = { type: "string", enum: platforms };
const draft = object({
  title: { type: "string", maxLength: 240 }, content: { type: "string", maxLength: 32768 }, prompt: { type: "string", maxLength: 8192 },
  channels: { type: "array", items: platform, minItems: 1, maxItems: 7, uniqueItems: true },
  primaryChannelId: id,
  channelSelections: { type: "object", properties: Object.fromEntries(platforms.map(name => [name, id])), additionalProperties: false, maxProperties: 7 },
  variants: { type: "array", maxItems: 7, items: object({ platform, content: { type: "string", maxLength: 32768 }, aiGenerated: { type: "boolean" }, status: { type: "string", enum: ["DRAFT", "APPROVED", "NEEDS_EDITS"] } }, ["platform", "content"]) },
  media: { type: "array", maxItems: 20, items: object({ assetId: id, altText: { type: ["string", "null"], maxLength: 1000 }, sortOrder: { type: "integer", minimum: 0, maximum: 100 } }, ["assetId"]) },
  metadata: { type: "object", maxProperties: 30, additionalProperties: true },
});
const scope: Record<GrowthOperationEffect, GrowthOperationScope> = { read: "growth:read", draft: "growth:draft", external_effect: "growth:publish", destructive: "growth:manage" };
function operation(name: string, description: string, schema: Record<string, unknown>, effect: GrowthOperationEffect = "read", entitlement: string | null = "feature.content.manage", resourceFields: string[] = []): GrowthOperationDefinition {
  const requiredEntitlements = [...(entitlement ? [entitlement] : []), ...(name.startsWith("content.") && (effect === "external_effect" || name === "content.posts.delete_published") ? ["feature.content.publish"] : [])];
  return { name, version: "1", description, inputSchema: schema, outputSchema: { type: "object", additionalProperties: true }, effect, scope: scope[effect], entitlement, requiredEntitlements, idempotency: effect === "read" ? "not_applicable" : "required", review: effect === "read" ? "none" : "required", resourceFields };
}
const byPost = object({ postId: id }, ["postId"]);
const byAsset = object({ assetId: id }, ["assetId"]);
const filters = { platform, metricKeys: { type: "array", maxItems: 20, items: text(64) }, publishedFrom: dateTime, publishedTo: dateTime };
const mediaBytes = { fileName: text(255), mimeType: text(100), base64: { type: "string", minLength: 4, maxLength: 21_848 } };

/** All transport adapters derive their callable contracts from this catalogue. */
export const growthOperations: readonly GrowthOperationDefinition[] = [
  operation("workspace.read", "Read this workspace's business identity and reporting timezone.", object(), "read", null),
  operation("connections.list", "List authorized connected account identities, permissions and readiness. Provider credentials are never returned.", object(page), "read", null),
  operation("connections.status.update", "Update the local status of a connected account after exact review. Does not perform a new provider authorization.", object({ connectionId: id, status: { type: "string", enum: ["CONNECTED", "DISCONNECTED", "REVOKED"] } }, ["connectionId", "status"]), "destructive", null, ["connectionId"]),
  operation("content.accounts.list", "List social publishing account identities and their supported capabilities. A connected status alone does not establish provider readiness.", object(page)),
  operation("content.posts.list", "Find content posts with bounded search, status filtering and pagination.", object(search)),
  operation("content.posts.get", "Read one authorized post, its media, platform variants and publishing outcomes.", byPost, "read", "feature.content.manage", ["postId"]),
  operation("content.posts.activity", "Read a post's saved activity and publication history.", byPost, "read", "feature.content.manage", ["postId"]),
  operation("content.posts.draft.create", "Prepare a new content draft for exact review. Does not publish or schedule.", object({ draft }, ["draft"]), "draft"),
  operation("content.posts.draft.update", "Update an unpublished draft after exact review. Published history must remain unchanged.", object({ postId: id, draft }, ["postId", "draft"]), "draft", "feature.content.manage", ["postId"]),
  operation("content.posts.update_published", "Update a confirmed Facebook Page post after exact review. Edit text or caption and optionally remove its existing photo while preserving the provider post, link and account. Unknown outcomes require reconciliation, not another update.", object({ postId: id, content: text(32768), expectedUpdatedAt: dateTime, removePhoto: { type: "boolean", default: false } }, ["postId", "content", "expectedUpdatedAt"]), "external_effect", "feature.content.manage", ["postId"]),
  operation("content.posts.duplicate", "Copy an authorized post into a new draft without copying delivery history or scheduling.", byPost, "draft", "feature.content.manage", ["postId"]),
  operation("content.media.get", "Read metadata for an authorized media asset.", byAsset, "read", "feature.content.manage", ["assetId"]),
  operation("content.media.preview", "Obtain a short-lived authorized preview for a ready media asset. Do not persist the preview URL as an asset identifier.", byAsset, "read", "feature.content.manage", ["assetId"]),
  { ...operation("content.media.transfer.prepare", "Prepare private temporary storage for an image or video upload. This does not create a content asset; save the completed transfer through content.media.upload after review.", object({ fileName: text(255), mimeType: { type: "string", maxLength: 100 }, byteSize: { type: "integer", minimum: 1, maximum: 536870912 }, sha256: { type: "string", minLength: 64, maxLength: 64, description: "Lowercase hexadecimal SHA-256 checksum" } }, ["mimeType", "byteSize"]), "draft"), review: "none", stagingControl: true },
  operation("content.media.upload", "Save a completed owned transfer, or a small image/video of at most 16 KiB decoded from canonical base64, after exact review. Choose exactly one source.", {
    ...object({ transferId: id, ...mediaBytes }),
    oneOf: [
      object({ transferId: id }, ["transferId"]),
      object(mediaBytes, ["mimeType", "base64"]),
    ],
  }, "draft", "feature.content.manage", ["transferId"]),
  operation("operations.reviews.get", "Read the current state, exact input and safe result of an operation review owned by this connection.", object({ reviewId: id }, ["reviewId"]), "read", null, ["reviewId"]),
  operation("content.posts.publish_batch.preflight", "Check exact content, media, permissions and selected destinations without starting publication.", byPost, "read", "feature.content.manage", ["postId"]),
  operation("content.posts.publish", "Publish the exact reviewed post to one selected platform. Observe its authoritative result before retrying.", object({ postId: id, platform }, ["postId", "platform"]), "external_effect", "feature.content.manage", ["postId"]),
  operation("content.posts.publish_batch", "Admit the reviewed content to all configured destinations and return a durable batch result.", byPost, "external_effect", "feature.content.manage", ["postId"]),
  operation("content.posts.publish_batch.status", "Read a durable publication batch or the latest batch for a post. Unknown outcomes require reconciliation.", object({ postId: id, batchId: id }, [])),
  operation("content.posts.publish_batch.retry", "Retry only confirmed failed destinations from the exact reviewed existing batch. Never retry an unknown outcome.", object({ batchId: id }, ["batchId"]), "external_effect", "feature.content.manage", ["batchId"]),
  operation("content.posts.schedule", "Schedule a reviewed draft for a future RFC3339 timestamp with explicit timezone offset.", object({ postId: id, scheduledFor: dateTime }, ["postId", "scheduledFor"]), "external_effect", "feature.content.manage", ["postId"]),
  operation("content.posts.reschedule", "Move a still-unclaimed scheduled post to a future RFC3339 timestamp, preserving its publication history.", object({ postId: id, scheduledFor: dateTime }, ["postId", "scheduledFor"]), "external_effect", "feature.content.manage", ["postId"]),
  operation("content.posts.unschedule", "Return an unclaimed scheduled post to draft after exact review.", byPost, "external_effect", "feature.content.manage", ["postId"]),
  operation("content.jobs.cancel", "Cancel an eligible pending or queued publication job. Already-started provider effects cannot be silently undone.", object({ jobId: id }, ["jobId"]), "external_effect", "feature.content.manage", ["jobId"]),
  operation("content.jobs.retry", "Retry an eligible confirmed failed publication job. Published, active and unknown jobs are rejected.", object({ jobId: id }, ["jobId"]), "external_effect", "feature.content.manage", ["jobId"]),
  operation("content.posts.delete", "Delete an unpublished draft after exact review. This does not delete a published provider copy.", byPost, "destructive", "feature.content.manage", ["postId"]),
  operation("content.posts.delete_published", "Delete a recorded provider copy on a supported platform after exact review, retaining failure details for reconciliation.", object({ postId: id, platform }, ["postId", "platform"]), "destructive", "feature.content.manage", ["postId"]),
  operation("content.posts.insights", "Read available post metrics with source availability and freshness.", object({ postId: id, ...filters }, ["postId"]), "read", "feature.content.manage", ["postId"]),
  operation("content.insights.report", "Read bounded available content metrics for an explicit publication range.", object({ ...filters, limit: { type: "integer", minimum: 1, maximum: 100 } })),
  operation("contacts.list", "Find workspace customer contacts, including authorized personal contact details, with bounded filters and pagination.", object({ ...page, search: { type: "string", maxLength: 200 }, optIn: { type: "string", enum: ["all", "true", "false"] }, excluded: { type: "string", enum: ["all", "true", "false"] }, tag: text(100), location: text(200), listLabel: text(200) }), "read", "feature.contacts.access"),
  operation("customers.get", "Read an authorized customer's details and activity.", object({ customerId: id }, ["customerId"]), "read", "feature.contacts.access", ["customerId"]),
  operation("contacts.update", "Update an authorized contact's details after exact review. Consent changes must reflect actual customer permission.", object({ contactId: id, contact: object({ fullName: { type: ["string", "null"], maxLength: 240 }, tags: { type: "array", maxItems: 30, items: text(100) }, location: { type: ["string", "null"], maxLength: 240 }, metadata: { type: "object", maxProperties: 30, additionalProperties: true } }) }, ["contactId", "contact"]), "draft", "feature.contacts.access", ["contactId"]),
  operation("inbox.conversations.list", "Read bounded authorized conversation summaries.", object(page), "read", "feature.inbox.access"),
  operation("inbox.messages.list", "Read bounded messages in an authorized conversation.", object({ conversationId: id, ...page }, ["conversationId"]), "read", "feature.inbox.access", ["conversationId"]),
  operation("inbox.conversations.update", "Set an authorized conversation's starred state after exact review.", object({ conversationId: id, starred: { type: "boolean" } }, ["conversationId", "starred"]), "draft", "feature.inbox.access", ["conversationId"]),
  operation("inbox.conversations.mark_read", "Mark an authorized conversation read after exact review.", object({ conversationId: id }, ["conversationId"]), "draft", "feature.inbox.access", ["conversationId"]),
  operation("inbox.messages.send", "Send exact reviewed text to an existing authorized conversation. Does not enable an autonomous channel responder.", object({ conversationId: id, text: text(16000), replyToMessageId: id }, ["conversationId", "text"]), "external_effect", "feature.inbox.access", ["conversationId"]),
  operation("bookings.services.list", "List authorized booking services.", object(page), "read", "feature.bookings.access"),
  operation("bookings.list", "Read bounded authorized booking records.", object(page), "read", "feature.bookings.access"),
  operation("bookings.get", "Read an authorized booking.", object({ bookingId: id }, ["bookingId"]), "read", "feature.bookings.access", ["bookingId"]),
  operation("campaigns.list", "Find permitted WhatsApp campaigns without changing recipients or launching sends.", object(search), "read", "feature.campaigns.manage"),
  operation("campaigns.get", "Read a permitted WhatsApp campaign summary and delivery outcomes.", object({ campaignId: id }, ["campaignId"]), "read", "feature.campaigns.manage", ["campaignId"]),
  operation("templates.list", "Read bounded approved or pending WhatsApp template inventory.", object({ ...page, status: text(40) }), "read", "feature.templates.manage"),
  operation("analytics.read", "Read authorized business reporting for an explicit date range and timezone. No arbitrary SQL or descendant scope.", object({ from: dateTime, to: dateTime, timezone: text(128), metrics: { type: "array", maxItems: 20, items: text(128) }, breakdowns: { type: "array", maxItems: 20, items: text(128) }, filters: { type: "object", maxProperties: 20, additionalProperties: { type: "array", maxItems: 100, items: text(256) } } }, ["from", "to", "timezone"]), "read", "feature.analytics.view"),
];
