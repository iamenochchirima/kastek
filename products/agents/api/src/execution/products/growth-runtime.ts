import type { Pool,PoolClient } from "pg";
import type { GrowthAgentAction, GrowthAgentActionInputs, GrowthAgentActionOperation, GrowthAgentActionOutputs } from "@kasitek-labs/contracts";
import { randomUUID } from "node:crypto";
import { GrowthActionClient } from "../../adapters/products/growth-action-client";
import { requestDigest, PlatformError } from "../../contracts/contracts";
import { validateGrowthPublication } from "../../product/integrations/growth-features";
import { EvidenceStore } from "../context/evidence";
import { ProductRuntime } from "./product-runtime";
import { growthOperations } from "@kasitek-labs/contracts";
import { retainedGrowthOperationHandlersV10 } from "./retained-growth-operation-handlers-v10";
const handlers=["workspace.read","content.list","content.read","campaigns.list","campaigns.read","analytics.read","draft.prepare"].map(operation=>`growth.${operation}@1`);
export const growthInstalledAdapterManifest={schemaVersion:1 as const,id:"growth-product",release:"2",executableDigest:requestDigest({release:"growth-product-v2",handlers}),transports:["native_http" as const],protocolVersions:[],boundedSchemaValidation:true as const};
// Historical handler identities are frozen independently from the current operation catalogue.
const retainedOperationHandlers = [
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
const operationHandlers=growthOperations.map(operation=>`growth.operation.${operation.name}@${operation.version}`);
const operationAdapter=(release:string,selected:readonly string[])=>({...growthInstalledAdapterManifest,release,executableDigest:requestDigest({release:"growth-operations-v1",handlers:selected})});
export const growthOperationAdapterManifest=operationAdapter("3",retainedOperationHandlers.filter(handler=>handler!=="growth.operation.content.posts.update_published@1"));
export const growthOperationAdapterManifestV7=operationAdapter("4",retainedOperationHandlers);
export const growthOperationAdapterManifestV8=operationAdapter("5",retainedOperationHandlers);
export const growthOperationAdapterManifestV9=operationAdapter("6",[...retainedOperationHandlers.slice(0,16),"growth.operation.content.actions.preview@1",...retainedOperationHandlers.slice(16)]);
export const growthOperationAdapterManifestV10=operationAdapter("7",retainedGrowthOperationHandlersV10);
export const growthCurrentOperationAdapterManifest=operationAdapter("8",operationHandlers);
const clients=new WeakMap<GrowthActionClient,{handlers:readonly string[];invoke:GrowthActionClient["invoke"]}>();
export class GrowthProductRuntime extends ProductRuntime {
  constructor(pool:Pool,readonly client:GrowthActionClient,evidence=new EvidenceStore(pool)) {
    super(pool,evidence);
    let adapter=clients.get(client);
    if(!adapter){adapter={handlers,invoke:client.invoke.bind(client)};clients.set(client,adapter);}
    this.registerAdapter(growthInstalledAdapterManifest,adapter);
    for(const [manifest,selected] of [
      [growthOperationAdapterManifest,retainedOperationHandlers.filter(handler=>handler!=="growth.operation.content.posts.update_published@1")],
      [growthOperationAdapterManifestV7,retainedOperationHandlers],
      [growthOperationAdapterManifestV8,retainedOperationHandlers],
      [growthOperationAdapterManifestV9,[...retainedOperationHandlers.slice(0,16),"growth.operation.content.actions.preview@1",...retainedOperationHandlers.slice(16)]],
      [growthOperationAdapterManifestV10,retainedGrowthOperationHandlersV10],
      [growthCurrentOperationAdapterManifest,operationHandlers],
    ] as const)this.registerAdapter(manifest,{handlers:selected,invoke:client.invoke.bind(client)});
    this.registerOriginAuthorizer("growth",async (taskId,db)=>{
      const row=(await db.query("SELECT p.tenant_id,t.principal,p.conversation_id,f.feature_id FROM agents_platform.tasks t JOIN agents_platform.product_task_contexts p ON p.task_id=t.root_task_id JOIN agents_platform.agent_versions v ON v.id=t.version_id JOIN agents_platform.product_execution_features f ON f.product='growth' AND f.tenant_id=p.tenant_id AND f.agent_id=v.agent_id AND f.enabled WHERE t.id=$1 AND t.product='growth'",[taskId])).rows[0];
      if(!row||row.principal.kind!=="human")throw new PlatformError("PRODUCT_AUTHORITY_INACTIVE",403,"Growth execution access is unavailable");
      const result=await this.client.call({version:"1",requestId:randomUUID(),operationId:"origin:"+randomUUID(),tenantId:row.tenant_id,
        actor:{issuer:row.principal.issuer,subject:row.principal.subject},taskId,conversationId:row.conversation_id,
        featureId:row.feature_id,context:null,operation:"authorization.check",input:{context:null}});
      if(result.authorized!==true)throw new PlatformError("PRODUCT_AUTHORITY_INACTIVE",403,"Growth execution access is unavailable");
    });
  }
  async prepareExecution(taskId:string):Promise<void>{await this.loadPublications(taskId);}
  async loadPublications(taskId?:string):Promise<void> {
    const rows=(await this.pool.query("SELECT publication FROM agents_platform.growth_capability_publications n WHERE $1::uuid IS NULL OR EXISTS (SELECT 1 FROM agents_platform.tasks t JOIN agents_platform.product_task_contexts p ON p.task_id=t.root_task_id WHERE t.id=$1 AND p.product='growth' AND p.tenant_id=n.tenant_id) ORDER BY created_at",[taskId??null])).rows;
    for(const row of rows)validateGrowthPublication(row.publication);
  }
  async call<K extends GrowthAgentActionOperation>(taskId:string,operationId:string,operation:K,input:GrowthAgentActionInputs[K],db:Pool|PoolClient=this.pool):Promise<GrowthAgentActionOutputs[K]> {
    const s=(await db.query("SELECT p.*,t.principal,f.feature_id AS selected_feature_id FROM agents_platform.tasks t JOIN agents_platform.product_task_contexts p ON p.task_id=t.root_task_id JOIN agents_platform.agent_versions v ON v.id=t.version_id JOIN agents_platform.product_execution_features f ON f.product='growth' AND f.tenant_id=p.tenant_id AND f.agent_id=v.agent_id AND f.enabled WHERE t.id=$1 AND t.product='growth'",[taskId])).rows[0];
    if(!s||s.principal.kind!=="human")throw new PlatformError("PRODUCT_AUTHORITY_INACTIVE",403,"Growth execution access is unavailable");
    return this.client.call({version:"1",requestId:randomUUID(),operationId,tenantId:s.tenant_id,actor:{issuer:s.principal.issuer,subject:s.principal.subject},taskId,conversationId:s.conversation_id,
      featureId:s.selected_feature_id,context:s.context,contextRevision:s.context_revision,operation,input} as GrowthAgentAction<K>);
  }
  async readReview(taskId:string,reviewId:string){
    await this.authorizeTask(taskId);
    const binding=(await this.pool.query("SELECT t.effective_configuration,v.configuration FROM agents_platform.tasks t JOIN agents_platform.agent_versions v ON v.id=t.version_id WHERE t.id=$1",[taskId])).rows[0];
    const config=binding?.effective_configuration??binding?.configuration;
    if(config?.productBindings?.some((item:{authority?:{policyRevision?:string}})=>item.authority?.policyRevision==="6")) return this.call(taskId,"review-read:"+randomUUID(),"operation.review.read",{reviewId});
    return this.call(taskId,"review-read:"+randomUUID(),"draft.reconcile",{reviewId});
  }
}
