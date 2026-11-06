import { growthAgentProductReferences, growthOperations } from "@kasitek-labs/contracts";
import { requestDigest } from "../../contracts/contracts";

export const growthInstalledHandlers = ["workspace.read", "content.list", "content.read", "campaigns.list",
  "campaigns.read", "analytics.read", "draft.prepare"].map(operation => `growth.${operation}@1`);
export const growthInstalledModelProjections = { "growth.draft.prepare@1": "effect-status-v1" } as const;
export const growthInstalledAdapterManifest = {
  schemaVersion: 1 as const, id: "growth-product", release: "2",
  executableDigest: requestDigest({ release: "growth-product-v2", handlers: growthInstalledHandlers }),
  transports: ["native_http" as const], protocolVersions: [], boundedSchemaValidation: true as const,
};

export const growthRetainedOperationHandlers = [
  "growth.operation.workspace.read@1",
  "growth.operation.connections.list@1",
  "growth.operation.connections.status.update@1",
  "growth.operation.content.accounts.list@1",
  "growth.operation.content.posts.list@1",
  "growth.operation.content.posts.get@1",
  "growth.operation.content.posts.activity@1",
  "growth.operation.content.posts.draft.create@1",
  "growth.operation.content.posts.draft.update@1",
  "growth.operation.content.posts.update_published@1",
  "growth.operation.content.posts.duplicate@1",
  "growth.operation.content.media.get@1",
  "growth.operation.content.media.preview@1",
  "growth.operation.content.media.transfer.prepare@1",
  "growth.operation.content.media.upload@1",
  "growth.operation.operations.reviews.get@1",
  "growth.operation.content.posts.publish_batch.preflight@1",
  "growth.operation.content.posts.publish@1",
  "growth.operation.content.posts.publish_batch@1",
  "growth.operation.content.posts.publish_batch.status@1",
  "growth.operation.content.posts.publish_batch.retry@1",
  "growth.operation.content.posts.schedule@1",
  "growth.operation.content.posts.reschedule@1",
  "growth.operation.content.posts.unschedule@1",
  "growth.operation.content.jobs.cancel@1",
  "growth.operation.content.jobs.retry@1",
  "growth.operation.content.posts.delete@1",
  "growth.operation.content.posts.delete_published@1",
  "growth.operation.content.posts.insights@1",
  "growth.operation.content.insights.report@1",
  "growth.operation.contacts.list@1",
  "growth.operation.customers.get@1",
  "growth.operation.contacts.update@1",
  "growth.operation.inbox.conversations.list@1",
  "growth.operation.inbox.messages.list@1",
  "growth.operation.inbox.conversations.update@1",
  "growth.operation.inbox.conversations.mark_read@1",
  "growth.operation.inbox.messages.send@1",
  "growth.operation.bookings.services.list@1",
  "growth.operation.bookings.list@1",
  "growth.operation.bookings.get@1",
  "growth.operation.campaigns.list@1",
  "growth.operation.campaigns.get@1",
  "growth.operation.templates.list@1",
  "growth.operation.analytics.read@1"
];
import { retainedGrowthOperationHandlersV10 } from "../../execution/products/retained-growth-operation-handlers-v10";
const handler = (operation: typeof growthOperations[number]) => `growth.operation.${operation.name}@${operation.version}`;
const operationAdapter=(release:string,handlers:readonly string[])=>({...growthInstalledAdapterManifest,release,
  executableDigest:requestDigest({release:"growth-operations-v1",handlers})});
export const growthOperationHandlers=growthRetainedOperationHandlers.filter(value=>value!=="growth.operation.content.posts.update_published@1");
export const growthOperationAdapterManifest=operationAdapter("3",growthOperationHandlers);
export const growthOperationAdapterManifestV7=operationAdapter("4",growthRetainedOperationHandlers);
export const growthOperationAdapterManifestV8=operationAdapter("5",growthRetainedOperationHandlers);
export const growthOperationAdapterManifestV9=operationAdapter("6",[...growthRetainedOperationHandlers.slice(0,16),"growth.operation.content.actions.preview@1",...growthRetainedOperationHandlers.slice(16)]);
export const growthOperationAdapterManifestV10=operationAdapter("7",retainedGrowthOperationHandlersV10);
export const growthFullOperationHandlers=growthOperations.map(handler);
const growthRetainedOperationHandlersV11 = [
  "growth.operation.workspace.read@1",
  "growth.operation.connections.list@1",
  "growth.operation.connections.status.update@1",
  "growth.operation.content.accounts.list@1",
  "growth.operation.content.posts.list@1",
  "growth.operation.content.posts.get@1",
  "growth.operation.content.posts.activity@1",
  "growth.operation.content.posts.draft.create@1",
  "growth.operation.content.posts.draft.update@1",
  "growth.operation.content.posts.update_published@1",
  "growth.operation.content.posts.duplicate@1",
  "growth.operation.content.media.list@1",
  "growth.operation.content.media.usage@1",
  "growth.operation.content.media.update@1",
  "growth.operation.content.media.archive@1",
  "growth.operation.content.media.restore@1",
  "growth.operation.content.templates.list@1",
  "growth.operation.content.templates.get@1",
  "growth.operation.content.templates.create@1",
  "growth.operation.content.templates.update@1",
  "growth.operation.content.templates.render@1",
  "growth.operation.content.templates.instantiate@1",
  "growth.operation.content.templates.archive@1",
  "growth.operation.content.templates.restore@1",
  "growth.operation.content.media.get@1",
  "growth.operation.content.media.preview@1",
  "growth.operation.content.media.transfer.prepare@1",
  "growth.operation.content.media.upload@1",
  "growth.operation.operations.reviews.get@1",
  "growth.operation.content.actions.preview@1",
  "growth.operation.content.posts.publish_batch.preflight@1",
  "growth.operation.content.posts.publish@1",
  "growth.operation.content.posts.publish_batch@1",
  "growth.operation.content.posts.publish_batch.status@1",
  "growth.operation.content.posts.publish_batch.retry@1",
  "growth.operation.content.posts.schedule@1",
  "growth.operation.content.posts.reschedule@1",
  "growth.operation.content.posts.unschedule@1",
  "growth.operation.content.jobs.cancel@1",
  "growth.operation.content.jobs.retry@1",
  "growth.operation.content.posts.delete@1",
  "growth.operation.content.posts.delete_published@1",
  "growth.operation.content.posts.insights@1",
  "growth.operation.content.insights.report@1",
  "growth.operation.contacts.list@1",
  "growth.operation.customers.get@1",
  "growth.operation.contacts.update@1",
  "growth.operation.inbox.conversations.list@1",
  "growth.operation.inbox.messages.list@1",
  "growth.operation.inbox.conversations.update@1",
  "growth.operation.inbox.conversations.mark_read@1",
  "growth.operation.inbox.messages.send@1",
  "growth.operation.bookings.services.list@1",
  "growth.operation.bookings.list@1",
  "growth.operation.bookings.get@1",
  "growth.operation.campaigns.list@1",
  "growth.operation.campaigns.get@1",
  "growth.operation.templates.list@1",
  "growth.operation.analytics.read@1"
];
export const growthCurrentOperationAdapterManifest=operationAdapter("8",growthRetainedOperationHandlersV11);
export const growthFullOperationAdapterManifests=[growthOperationAdapterManifestV7,growthOperationAdapterManifestV8];
const readHandlers=growthOperations.filter(operation=>operation.effect==="read"||operation.stagingControl===true).map(handler);
export const growthFullOperationAccessHandlers=readHandlers;
export const growthOperationAccessHandlers=growthOperationHandlers.filter(value=>readHandlers.includes(value));
export const growthFullOperationModelProjections=Object.fromEntries(growthOperations.filter(operation=>operation.review==="required").map(operation=>[handler(operation),"effect-status-v1" as const]));
/** The product adapter declares which native selectors may cross the model boundary. */
export const growthProductReferences=growthAgentProductReferences;
const legacyReferenceHandlers=new Set([
  "growth.operation.connections.list@1","growth.operation.connections.status.update@1",
  "growth.operation.content.accounts.list@1","growth.operation.content.posts.draft.create@1",
  "growth.operation.content.posts.draft.update@1","growth.operation.content.templates.instantiate@1",
  "growth.draft.prepare@1",
]);
export function growthReferencesFor(handlers:readonly string[]){return Object.fromEntries(Object.entries(growthProductReferences).filter(([key])=>handlers.includes(key)));}
/** Retained releases keep their original behavior; new selectors enter in release 11. */
export function growthLegacyReferencesFor(handlers:readonly string[]){return Object.fromEntries(Object.entries(growthProductReferences).filter(([key])=>handlers.includes(key)&&legacyReferenceHandlers.has(key)));}
export const growthOperationModelProjections=Object.fromEntries(Object.entries(growthFullOperationModelProjections).filter(([value])=>growthOperationHandlers.includes(value)));
export const growthContentReadModelProjections={...growthFullOperationModelProjections,
  "growth.operation.content.posts.get@1":"growth-content-post-read-v1",
  "growth.operation.content.posts.list@1":"growth-content-post-read-v1"} as const;
export const growthContentReadAdapterManifest={...growthInstalledAdapterManifest,release:"9",
  executableDigest:requestDigest({release:"growth-operations-v2",handlers:growthFullOperationHandlers,modelProjection:"growth-content-post-read-v1"})};
export const growthConnectionReadAdapterManifest={...growthInstalledAdapterManifest,release:"10",
  executableDigest:requestDigest({release:"growth-operations-v2",handlers:growthFullOperationHandlers,modelProjection:"growth-content-post-read-v1",connectionProjection:"growth-connections-read-v1"})};
export const growthReferenceAdapterManifest={...growthInstalledAdapterManifest,release:"11",
  executableDigest:requestDigest({release:"growth-operations-v2",handlers:growthFullOperationHandlers,modelProjection:"growth-content-post-read-v1",
    connectionProjection:"growth-connections-read-v1",referenceProjection:"growth-product-references-v1",references:growthProductReferences})};
export const growthRetainedOperationAdapters=[
  {manifest:growthOperationAdapterManifest,handlers:growthOperationHandlers},
  {manifest:growthOperationAdapterManifestV7,handlers:growthRetainedOperationHandlers},
  {manifest:growthOperationAdapterManifestV8,handlers:growthRetainedOperationHandlers},
  {manifest:growthOperationAdapterManifestV9,handlers:[...growthRetainedOperationHandlers.slice(0,16),"growth.operation.content.actions.preview@1",...growthRetainedOperationHandlers.slice(16)]},
  {manifest:growthOperationAdapterManifestV10,handlers:retainedGrowthOperationHandlersV10},
  {manifest:growthCurrentOperationAdapterManifest,handlers:growthRetainedOperationHandlersV11},
];

// Source-frozen local branch lineage: HEAD c6c88b5a8 operation catalogue plus reviewed local projection release6.
const localBranchHandlers = [
  "growth.operation.workspace.read@1",
  "growth.operation.connections.list@1",
  "growth.operation.connections.status.update@1",
  "growth.operation.content.accounts.list@1",
  "growth.operation.content.posts.list@1",
  "growth.operation.content.posts.get@1",
  "growth.operation.content.posts.activity@1",
  "growth.operation.content.posts.draft.create@1",
  "growth.operation.content.posts.draft.update@1",
  "growth.operation.content.posts.update_published@1",
  "growth.operation.content.posts.duplicate@1",
  "growth.operation.content.media.get@1",
  "growth.operation.content.media.preview@1",
  "growth.operation.content.media.transfer.prepare@1",
  "growth.operation.content.media.upload@1",
  "growth.operation.operations.reviews.get@1",
  "growth.operation.content.posts.publish_batch.preflight@1",
  "growth.operation.content.posts.publish@1",
  "growth.operation.content.posts.publish_batch@1",
  "growth.operation.content.posts.publish_batch.status@1",
  "growth.operation.content.posts.publish_batch.retry@1",
  "growth.operation.content.posts.schedule@1",
  "growth.operation.content.posts.reschedule@1",
  "growth.operation.content.posts.unschedule@1",
  "growth.operation.content.jobs.cancel@1",
  "growth.operation.content.jobs.retry@1",
  "growth.operation.content.posts.delete@1",
  "growth.operation.content.posts.delete_published@1",
  "growth.operation.content.posts.insights@1",
  "growth.operation.content.insights.report@1",
  "growth.operation.contacts.list@1",
  "growth.operation.customers.get@1",
  "growth.operation.contacts.update@1",
  "growth.operation.inbox.conversations.list@1",
  "growth.operation.inbox.messages.list@1",
  "growth.operation.inbox.conversations.update@1",
  "growth.operation.inbox.conversations.mark_read@1",
  "growth.operation.inbox.messages.send@1",
  "growth.operation.bookings.services.list@1",
  "growth.operation.bookings.list@1",
  "growth.operation.bookings.get@1",
  "growth.operation.campaigns.list@1",
  "growth.operation.campaigns.get@1",
  "growth.operation.templates.list@1",
  "growth.operation.analytics.read@1"
];
const localBranchAccessHandlers = [
  "growth.operation.workspace.read@1",
  "growth.operation.connections.list@1",
  "growth.operation.content.accounts.list@1",
  "growth.operation.content.posts.list@1",
  "growth.operation.content.posts.get@1",
  "growth.operation.content.posts.activity@1",
  "growth.operation.content.media.get@1",
  "growth.operation.content.media.preview@1",
  "growth.operation.content.media.transfer.prepare@1",
  "growth.operation.operations.reviews.get@1",
  "growth.operation.content.posts.publish_batch.preflight@1",
  "growth.operation.content.posts.publish_batch.status@1",
  "growth.operation.content.posts.insights@1",
  "growth.operation.content.insights.report@1",
  "growth.operation.contacts.list@1",
  "growth.operation.customers.get@1",
  "growth.operation.inbox.conversations.list@1",
  "growth.operation.inbox.messages.list@1",
  "growth.operation.bookings.services.list@1",
  "growth.operation.bookings.list@1",
  "growth.operation.bookings.get@1",
  "growth.operation.campaigns.list@1",
  "growth.operation.campaigns.get@1",
  "growth.operation.templates.list@1",
  "growth.operation.analytics.read@1"
];
export const growthHistoricalModelProjections = {
  "growth.operation.connections.status.update@1": "effect-status-v1",
  "growth.operation.content.posts.draft.create@1": "effect-status-v1",
  "growth.operation.content.posts.draft.update@1": "effect-status-v1",
  "growth.operation.content.posts.update_published@1": "effect-status-v1",
  "growth.operation.content.posts.duplicate@1": "effect-status-v1",
  "growth.operation.content.media.upload@1": "effect-status-v1",
  "growth.operation.content.posts.publish@1": "effect-status-v1",
  "growth.operation.content.posts.publish_batch@1": "effect-status-v1",
  "growth.operation.content.posts.publish_batch.retry@1": "effect-status-v1",
  "growth.operation.content.posts.schedule@1": "effect-status-v1",
  "growth.operation.content.posts.reschedule@1": "effect-status-v1",
  "growth.operation.content.posts.unschedule@1": "effect-status-v1",
  "growth.operation.content.jobs.cancel@1": "effect-status-v1",
  "growth.operation.content.jobs.retry@1": "effect-status-v1",
  "growth.operation.content.posts.delete@1": "effect-status-v1",
  "growth.operation.content.posts.delete_published@1": "effect-status-v1",
  "growth.operation.contacts.update@1": "effect-status-v1",
  "growth.operation.inbox.conversations.update@1": "effect-status-v1",
  "growth.operation.inbox.conversations.mark_read@1": "effect-status-v1",
  "growth.operation.inbox.messages.send@1": "effect-status-v1"
} as const;
export const growthLocalRetainedVariants=["3","4","5","6"].map(release=>{
  const handlers=release==="3"?localBranchHandlers.filter(value=>value!=="growth.operation.content.posts.update_published@1"):localBranchHandlers;
  const projected=release==="6";
  return {manifest:{...growthInstalledAdapterManifest,release,executableDigest:requestDigest(projected
    ?{release:"growth-operations-v2",handlers,modelProjection:"growth-content-post-read-v1"}
    :{release:"growth-operations-v1",handlers})},handlers,
    accessReceiptHandlers:localBranchAccessHandlers.filter(value=>handlers.includes(value)),
    modelProjections:{...Object.fromEntries(Object.entries(growthHistoricalModelProjections).filter(([value])=>handlers.includes(value))),
      ...(projected?{"growth.operation.content.posts.get@1":"growth-content-post-read-v1" as const,"growth.operation.content.posts.list@1":"growth-content-post-read-v1" as const}:{})}};
});
