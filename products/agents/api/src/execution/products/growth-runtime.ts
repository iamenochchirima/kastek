import type { Pool,PoolClient } from "pg";
import { parseGrowthAgentContext, type GrowthAgentAction, type GrowthAgentActionInputs, type GrowthAgentActionOperation, type GrowthAgentActionOutputs } from "@kasitek-labs/contracts";
import { randomUUID } from "node:crypto";
import { GrowthActionClient } from "../../adapters/products/growth-action-client";
import { canonicalJson, PlatformError,requestDigest } from "../../contracts/contracts";
import type { CapabilityBinding } from "../../contracts/capability-catalog";
import { productDescriptor, registerProductManifest, type InstalledProductAdapter } from "../../capabilities/products/product-capabilities";
import { growthInstalledAdapterManifest, growthInstalledHandlers, growthInstalledModelProjections,
  growthHistoricalModelProjections, growthLocalRetainedVariants, growthRetainedOperationAdapters, growthFullOperationHandlers, growthFullOperationAccessHandlers, growthFullOperationModelProjections,
  growthContentReadAdapterManifest,growthCurrentContentReadAdapterManifest,growthConnectionReadAdapterManifest,growthRetainedContentReadHandlers,growthContentReadModelProjections } from "../../adapters/products/growth-capability-manifests";
export { growthOperationAdapterManifest,growthOperationAdapterManifestV7,growthOperationAdapterManifestV8,
  growthOperationAdapterManifestV9,growthOperationAdapterManifestV10,growthCurrentOperationAdapterManifest } from "../../adapters/products/growth-capability-manifests";
import { EvidenceStore } from "../context/evidence";
import { ProductRuntime } from "./product-runtime";
const clients=new WeakMap<GrowthActionClient,InstalledProductAdapter>();
async function selectedContext(db:Pool|PoolClient,taskId:string){
  const row=(await db.query(`SELECT p.selected_context,p.context FROM agents_platform.tasks t
    JOIN agents_platform.product_task_contexts p ON p.task_id=t.id AND p.product=t.product AND p.conversation_id=t.conversation_id
    WHERE t.id=$1 AND t.product='growth' AND t.parent_task_id IS NULL`,[taskId])).rows[0];
  if(!row)throw new PlatformError("PRODUCT_CONTEXT_UNAVAILABLE",403,"Selected context is unavailable");
  if(row.selected_context===null)return null;
  let selected;try{selected=parseGrowthAgentContext(row.selected_context);}catch{throw new PlatformError("PRODUCT_CONTEXT_UNAVAILABLE",403,"Selected context is unavailable");}
  if(canonicalJson(selected)!==canonicalJson(row.context))throw new PlatformError("PRODUCT_CONTEXT_UNAVAILABLE",403,"Selected context changed");
  return selected;
}
export class GrowthProductRuntime extends ProductRuntime {
  constructor(pool:Pool,readonly client:GrowthActionClient,evidence=new EvidenceStore(pool)) {
    super(pool,evidence);
    let adapter=clients.get(client);
    if(!adapter){adapter={handlers:growthInstalledHandlers,modelProjections:growthInstalledModelProjections,invoke:client.invoke.bind(client)};clients.set(client,adapter);}
    this.registerAdapter(growthInstalledAdapterManifest,adapter);
    for(const {manifest,handlers} of growthRetainedOperationAdapters)this.registerAdapter(manifest,{handlers,
      accessReceiptHandlers:growthFullOperationAccessHandlers.filter(handler=>(handlers as readonly string[]).includes(handler)),
      modelProjections:Object.fromEntries(Object.entries(Number(manifest.release)<8?growthHistoricalModelProjections:growthFullOperationModelProjections).filter(([handler])=>(handlers as readonly string[]).includes(handler))),
      invoke:client.invoke.bind(client)});
    this.registerAdapter(growthContentReadAdapterManifest,{handlers:growthRetainedContentReadHandlers,accessReceiptHandlers:growthFullOperationAccessHandlers.filter(handler=>growthRetainedContentReadHandlers.includes(handler)),modelProjections:Object.fromEntries(Object.entries(growthContentReadModelProjections).filter(([handler])=>growthRetainedContentReadHandlers.includes(handler))),invoke:client.invoke.bind(client)});
    this.registerAdapter(growthConnectionReadAdapterManifest,{handlers:growthFullOperationHandlers,accessReceiptHandlers:growthFullOperationAccessHandlers,modelProjections:growthContentReadModelProjections,invoke:client.invoke.bind(client)});
    this.registerRetainedAdapter(growthCurrentContentReadAdapterManifest,{handlers:growthFullOperationHandlers,accessReceiptHandlers:growthFullOperationAccessHandlers,modelProjections:growthContentReadModelProjections,invoke:client.invoke.bind(client)});
    for(const {manifest,handlers,accessReceiptHandlers,modelProjections} of growthLocalRetainedVariants.filter(local=>!growthRetainedOperationAdapters.some(standard=>requestDigest(standard.manifest)===requestDigest(local.manifest))))this.registerRetainedAdapter(manifest,{handlers,accessReceiptHandlers,modelProjections,invoke:client.invoke.bind(client)});
    this.registerContextReader("growth",async(taskId,db)=>{
      const context=await selectedContext(db,taskId);
      if(context===null)return null;
      const evidence=await this.call(taskId,"selected-context:"+randomUUID(),"context.read",{context},db);
      if(!evidence||typeof evidence!=="object"||canonicalJson(evidence.context)!==canonicalJson(context)||
        typeof evidence.revision!=="string"||!/^[a-f0-9]{64}$/.test(evidence.revision)||
        evidence.data===null||typeof evidence.data!=="object")
        throw new PlatformError("PRODUCT_CONTEXT_UNAVAILABLE",502,"Growth returned invalid selected context");
      // The owning product supplies its permission-checked, model-safe projection. Keep
      // the original reference and revision beside it so the context dependency can be
      // re-read and compared before replay, compaction, or delegated use.
      return {...context,revision:evidence.revision,data:evidence.data};
    });
    this.registerOriginAuthorizer("growth",async (taskId,db)=>{
      const row=(await db.query("SELECT p.tenant_id,t.principal,t.parent_task_id,p.conversation_id,f.feature_id FROM agents_platform.tasks t JOIN agents_platform.product_task_contexts p ON p.task_id=t.root_task_id JOIN agents_platform.agent_versions v ON v.id=t.version_id JOIN agents_platform.product_execution_features f ON f.product='growth' AND f.tenant_id=p.tenant_id AND f.agent_id=v.agent_id AND f.enabled WHERE t.id=$1 AND t.product='growth'",[taskId])).rows[0];
      if(!row||row.principal.kind!=="human")throw new PlatformError("PRODUCT_AUTHORITY_INACTIVE",403,"Growth execution access is unavailable");
      const context=row.parent_task_id?null:await selectedContext(db,taskId);
      const result=await this.client.call({version:"1",requestId:randomUUID(),operationId:"origin:"+randomUUID(),tenantId:row.tenant_id,
        actor:{issuer:row.principal.issuer,subject:row.principal.subject},taskId,conversationId:row.conversation_id,
        featureId:row.feature_id,context,operation:"authorization.check",input:{context}});
      if(result.authorized!==true)throw new PlatformError("PRODUCT_AUTHORITY_INACTIVE",403,"Growth execution access is unavailable");
    });
  }
  async prepareExecution(taskId:string):Promise<void>{await super.prepareExecution(taskId);await this.loadPublications(taskId);}
  async loadPublications(taskId?:string):Promise<void> {
    const rows=(await this.pool.query("SELECT publication FROM agents_platform.growth_capability_publications n WHERE $1::uuid IS NULL OR EXISTS (SELECT 1 FROM agents_platform.tasks t JOIN agents_platform.product_task_contexts p ON p.task_id=t.root_task_id WHERE t.id=$1 AND p.product='growth' AND p.tenant_id=n.tenant_id) ORDER BY created_at",[taskId??null])).rows;
    for(const row of rows)registerProductManifest(row.publication.manifest);
  }
  async call<K extends GrowthAgentActionOperation>(taskId:string,operationId:string,operation:K,input:GrowthAgentActionInputs[K],db:Pool|PoolClient=this.pool):Promise<GrowthAgentActionOutputs[K]> {
    const s=(await db.query("SELECT p.*,t.principal,f.feature_id AS selected_feature_id FROM agents_platform.tasks t JOIN agents_platform.product_task_contexts p ON p.task_id=t.root_task_id JOIN agents_platform.agent_versions v ON v.id=t.version_id JOIN agents_platform.product_execution_features f ON f.product='growth' AND f.tenant_id=p.tenant_id AND f.agent_id=v.agent_id AND f.enabled WHERE t.id=$1 AND t.product='growth'",[taskId])).rows[0];
    if(!s||s.principal.kind!=="human")throw new PlatformError("PRODUCT_AUTHORITY_INACTIVE",403,"Growth execution access is unavailable");
    return this.client.call({version:"1",requestId:randomUUID(),operationId,tenantId:s.tenant_id,actor:{issuer:s.principal.issuer,subject:s.principal.subject},taskId,conversationId:s.conversation_id,
      featureId:s.selected_feature_id,context:s.context,contextRevision:s.context_revision,operation,input} as GrowthAgentAction<K>);
  }
  async readReview(taskId:string,reviewId:string){
    await this.authorizeTask(taskId);
    return this.readReviewFromProduct(taskId,reviewId);
  }
  /** Control flow sees only the current exact review decision, not its private body. */
  async readReviewStatus(taskId:string,reviewId:string){
    await this.authorizeReconciliation(taskId);
    const {review}=await this.readReviewFromProduct(taskId,reviewId);
    return {id:review.id,payloadDigest:review.payloadDigest,state:review.state};
  }
  private async readReviewFromProduct(taskId:string,reviewId:string){
    const binding=(await this.pool.query("SELECT t.effective_configuration,v.configuration FROM agents_platform.tasks t JOIN agents_platform.agent_versions v ON v.id=t.version_id WHERE t.id=$1",[taskId])).rows[0];
    const config=binding?.effective_configuration??binding?.configuration;
    if(config?.productBindings?.some((binding:CapabilityBinding)=>{
      const descriptor=productDescriptor(binding);
      return descriptor.handlerRef===`growth.operation.${descriptor.operation}@${descriptor.revision}`;
    })) return this.call(taskId,"review-read:"+randomUUID(),"operation.review.read",{reviewId});
    return this.call(taskId,"review-read:"+randomUUID(),"draft.reconcile",{reviewId});
  }
}
