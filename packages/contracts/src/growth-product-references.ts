/** Growth selectors that may cross into the shared Agents model context. */
export interface GrowthProductReferenceRule {
  resourceType: string;
  /** Result rows whose `id` is a native selector and should become a scoped handle. */
  outputRows?: readonly string[];
  /** Scalar result selectors that should become scoped handles. */
  outputValues?: readonly string[];
  /** Input selectors that accept handles issued for this resource type. */
  inputPaths?: readonly string[];
  /** Human-readable row fields used when an output handle is shown in a response. */
  labelFields?: readonly string[];
}

const rule = (resourceType: string, values: Omit<GrowthProductReferenceRule, "resourceType"> = {}): GrowthProductReferenceRule => ({ resourceType, ...values });

/**
 * Explicit adapter contract: only these fields are native resource selectors.
 * IDs outside these paths remain ordinary business data unless their owning
 * adapter adds a more specific contract.
 */
export const growthAgentProductReferences = {
  "growth.operation.connections.list@1": [rule("growth.connection", { outputRows: ["value.result.connections.*"], labelFields: ["name", "handle", "platform"] })],
  "growth.operation.connections.status.update@1": [rule("growth.connection", { inputPaths: ["connectionId"] })],
  "growth.operation.content.accounts.list@1": [rule("growth.social_account", { outputRows: ["value.result.accounts.*"], labelFields: ["name", "handle", "platform"] })],

  "growth.operation.content.posts.get@1": [
    rule("growth.content_post", { outputRows: ["post"], inputPaths: ["postId"], labelFields: ["title"] }),
    rule("growth.media_asset", { outputValues: ["post.media.*.assetId"] }),
  ],
  "growth.operation.content.posts.list@1": [
    rule("growth.content_post", { outputRows: ["posts.*"], labelFields: ["title"] }),
    rule("growth.media_asset", { outputValues: ["posts.*.media.*.assetId"] }),
  ],
  "growth.operation.content.posts.activity@1": [rule("growth.content_post", { inputPaths: ["postId"] })],
  "growth.operation.content.posts.draft.create@1": [
    rule("growth.social_account", { inputPaths: ["draft.primaryChannelId", "draft.channelSelections.*"] }),
    rule("growth.media_asset", { inputPaths: ["draft.media.*.assetId"] }),
    rule("growth.content_post", { outputRows: ["value.result.post"], outputValues: ["value.result.postId"], labelFields: ["title"] }),
  ],
  "growth.operation.content.posts.draft.update@1": [
    rule("growth.content_post", { inputPaths: ["postId"], labelFields: ["title"] }),
    rule("growth.social_account", { inputPaths: ["draft.primaryChannelId", "draft.channelSelections.*"] }),
    rule("growth.media_asset", { inputPaths: ["draft.media.*.assetId"] }),
  ],
  "growth.operation.content.posts.update_published@1": [rule("growth.content_post", { inputPaths: ["postId"] })],
  "growth.operation.content.posts.duplicate@1": [
    rule("growth.content_post", { inputPaths: ["postId"], outputRows: ["value.result.post"], outputValues: ["value.result.postId"], labelFields: ["title"] }),
    rule("growth.media_asset", { inputPaths: ["value.result.post.media.*.asset_id"] }),
  ],
  "growth.operation.content.posts.publish_batch.preflight@1": [rule("growth.content_post", { inputPaths: ["postId"] })],
  "growth.operation.content.posts.publish@1": [rule("growth.content_post", { inputPaths: ["postId"] })],
  "growth.operation.content.posts.publish_batch@1": [rule("growth.content_post", { inputPaths: ["postId"] })],
  "growth.operation.content.posts.publish_batch.status@1": [
    rule("growth.content_post", { inputPaths: ["postId"] }),
    rule("growth.content_batch", { inputPaths: ["batchId"], outputValues: ["value.result.batchId"] }),
  ],
  "growth.operation.content.posts.publish_batch.retry@1": [rule("growth.content_batch", { inputPaths: ["batchId"] })],
  "growth.operation.content.posts.schedule@1": [rule("growth.content_post", { inputPaths: ["postId"] })],
  "growth.operation.content.posts.reschedule@1": [rule("growth.content_post", { inputPaths: ["postId"] })],
  "growth.operation.content.posts.unschedule@1": [rule("growth.content_post", { inputPaths: ["postId"] })],
  "growth.operation.content.posts.delete@1": [rule("growth.content_post", { inputPaths: ["postId"] })],
  "growth.operation.content.posts.delete_published@1": [rule("growth.content_post", { inputPaths: ["postId"] })],
  "growth.operation.content.posts.insights@1": [rule("growth.content_post", { inputPaths: ["postId"] })],
  "growth.operation.content.actions.preview@1": [
    rule("growth.content_post", { inputPaths: ["input.postId"] }),
    rule("growth.content_batch", { inputPaths: ["input.batchId"] }),
    rule("growth.social_account", { inputPaths: ["input.draft.primaryChannelId", "input.draft.channelSelections.*"] }),
    rule("growth.media_asset", { inputPaths: ["input.draft.media.*.assetId", "input.media.*.assetId"] }),
    rule("growth.content_template", { inputPaths: ["input.templateId"] }),
  ],

  "growth.operation.content.media.list@1": [rule("growth.media_asset", { outputRows: ["value.result.assets.*"], labelFields: ["displayName", "fileName"] })],
  "growth.operation.content.media.usage@1": [rule("growth.media_asset", { inputPaths: ["assetId"], outputValues: ["value.result.assetId"] })],
  "growth.operation.content.media.update@1": [
    rule("growth.media_asset", { inputPaths: ["assetId"], outputRows: ["value.result.asset"], labelFields: ["displayName", "fileName"] }),
  ],
  "growth.operation.content.media.archive@1": [rule("growth.media_asset", { inputPaths: ["assetId"], outputRows: ["value.result.asset"], labelFields: ["displayName", "fileName"] })],
  "growth.operation.content.media.restore@1": [rule("growth.media_asset", { inputPaths: ["assetId"], outputRows: ["value.result.asset"], labelFields: ["displayName", "fileName"] })],
  "growth.operation.content.media.get@1": [rule("growth.media_asset", { inputPaths: ["assetId"], outputRows: ["value.result.asset"], labelFields: ["displayName", "fileName"] })],
  "growth.operation.content.media.preview@1": [rule("growth.media_asset", { inputPaths: ["assetId"], outputRows: ["value.result.asset"], labelFields: ["displayName", "fileName"] })],

  "growth.operation.content.templates.list@1": [
    rule("growth.content_template", { outputRows: ["value.result.templates.*"], labelFields: ["name"] }),
    rule("growth.media_asset", { outputValues: ["value.result.templates.*.media.*.assetId", "value.result.templates.*.variants.*.media.*.assetId"] }),
  ],
  "growth.operation.content.templates.get@1": [
    rule("growth.content_template", { inputPaths: ["templateId"], outputRows: ["value.result.template"], labelFields: ["name"] }),
    rule("growth.media_asset", { outputValues: ["value.result.template.media.*.assetId", "value.result.template.variants.*.media.*.assetId"] }),
  ],
  "growth.operation.content.templates.create@1": [
    rule("growth.content_template", { outputRows: ["value.result.template"], labelFields: ["name"] }),
    rule("growth.media_asset", { inputPaths: ["template.media.*.assetId", "template.variants.*.media.*.assetId"] }),
  ],
  "growth.operation.content.templates.update@1": [
    rule("growth.content_template", { inputPaths: ["templateId"], outputRows: ["value.result.template"], labelFields: ["name"] }),
    rule("growth.media_asset", { inputPaths: ["template.media.*.assetId", "template.variants.*.media.*.assetId"] }),
  ],
  "growth.operation.content.templates.render@1": [
    rule("growth.content_template", { inputPaths: ["templateId"], outputValues: ["value.result.rendered.templateId"] }),
    rule("growth.media_asset", { inputPaths: ["media.*.assetId", "value.result.rendered.media.*.assetId", "value.result.rendered.variants.*.media.*.assetId"], outputValues: ["value.result.rendered.media.*.assetId", "value.result.rendered.variants.*.media.*.assetId"] }),
  ],
  "growth.operation.content.templates.instantiate@1": [
    rule("growth.content_template", { inputPaths: ["templateId"] }),
    rule("growth.social_account", { inputPaths: ["primaryChannelId", "channelSelections.*"] }),
    rule("growth.media_asset", { inputPaths: ["media.*.assetId"] }),
    rule("growth.content_post", { outputRows: ["value.result.post"], outputValues: ["value.result.postId"], labelFields: ["title"] }),
    rule("growth.media_asset", { outputValues: ["value.result.post.media.*.asset_id"] }),
  ],
  "growth.operation.content.templates.archive@1": [rule("growth.content_template", { inputPaths: ["templateId"], outputRows: ["value.result.template"], labelFields: ["name"] })],
  "growth.operation.content.templates.restore@1": [rule("growth.content_template", { inputPaths: ["templateId"], outputRows: ["value.result.template"], labelFields: ["name"] })],

  "growth.draft.prepare@1": [
    rule("growth.social_account", { inputPaths: ["draft.channelSelections.*"] }),
    rule("growth.media_asset", { inputPaths: ["draft.media.*.assetId"] }),
  ],
} as const satisfies Record<string, readonly GrowthProductReferenceRule[]>;
