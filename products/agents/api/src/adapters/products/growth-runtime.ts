import { randomUUID } from "node:crypto";
import type { Pool,PoolClient } from "pg";
import type { GrowthAgentAction, GrowthAgentActionInputs, GrowthAgentActionOperation, GrowthAgentActionOutputs,
  GrowthAgentContext, GrowthAgentFeatureId, GrowthAgentReview } from "@kasitek-labs/contracts";
import { PlatformError } from "../../contracts/contracts";
import { GrowthActionClient } from "./growth-action-client";
import { registerProductPorts } from "../../infrastructure/product-ports";
import { EvidenceStore,assertCurrentEvidence,taskEvidenceManifest } from "../../execution/context/evidence";
import { fitUtf8 } from "../../capabilities/tool-definitions";
export class GrowthProductRuntime {
  constructor(readonly pool:Pool,readonly client:GrowthActionClient,readonly evidence=new EvidenceStore(pool)) {
    registerProductPorts(pool,{assertCurrentEvidence:async(db,{consumerTaskId,dependency})=>{
      const source=await this.scope(dependency.taskId,db),consumer=await this.scope(consumerTaskId,db);
      if(dependency.product!=="growth"||source.tenant_id!==dependency.tenantId||consumer.tenant_id!==source.tenant_id||
        JSON.stringify(source.principal)!==JSON.stringify(consumer.principal)||source.context_revision!==dependency.contextRevision||
        !source.sources?.some(item=>item.id===dependency.sourceId))throw new PlatformError("EVIDENCE_UNAVAILABLE",403,"Growth evidence is unavailable");
      const response=await this.client.call({version:"1",requestId:randomUUID(),operationId:"evidence:"+randomUUID(),
        tenantId:source.tenant_id,actor:{issuer:source.principal.issuer,subject:source.principal.subject},taskId:dependency.taskId,
        conversationId:source.conversation_id,featureId:source.feature_id,context:source.context,
        contextRevision:dependency.contextRevision,operation:"authorization.check",input:{context:source.context}});
      if(response.authorized!==true)throw new PlatformError("EVIDENCE_UNAVAILABLE",403,"Growth evidence is unavailable");
    }});
  }
  async scope(taskId:string,db:Pool|PoolClient=this.pool) {
    const row=(await db.query("SELECT p.*,t.principal,t.state,c.deleted_at,f.enabled,n.revoked_at FROM agents_platform.tasks t JOIN agents_platform.product_task_contexts p ON p.task_id=t.root_task_id JOIN agents_platform.conversations c ON c.id=t.conversation_id JOIN agents_platform.product_execution_features f ON f.product=p.product AND f.tenant_id=p.tenant_id AND f.feature_id=p.feature_id JOIN agents_platform.product_execution_tenants n ON n.product=p.product AND n.tenant_id=p.tenant_id WHERE t.id=$1 AND t.product='growth'",[taskId])).rows[0];
    if(!row||row.principal.kind!=="human"||row.deleted_at||row.revoked_at||!row.enabled)throw new PlatformError("PRODUCT_AUTHORITY_INACTIVE",403,"Growth execution access is unavailable");
    return row as {tenant_id:string;feature_id:GrowthAgentFeatureId;conversation_id:string;context:GrowthAgentContext|null;context_revision:string|null;
      principal:{kind:"human";issuer:string;subject:string};state:string;sources:{id:string;title?:string}[]};
  }
  async call<K extends GrowthAgentActionOperation>(taskId:string,operationId:string,operation:K,input:GrowthAgentActionInputs[K]):Promise<GrowthAgentActionOutputs[K]> {
    const s=await this.scope(taskId);
    const command={version:"1" as const,requestId:randomUUID(),operationId,tenantId:s.tenant_id,
      actor:{issuer:s.principal.issuer,subject:s.principal.subject},taskId,conversationId:s.conversation_id,
      featureId:s.feature_id,context:s.context,contextRevision:s.context_revision,operation,input} as GrowthAgentAction<K>;
    return this.client.call(command);
  }
  async authorizeTask(taskId:string):Promise<void> {
    const product=(await this.pool.query("SELECT product FROM agents_platform.tasks WHERE id=$1",[taskId])).rows[0]?.product;
    if(product!=="growth")return;
    const mapped=(await this.pool.query("SELECT 1 FROM agents_platform.product_task_contexts p JOIN agents_platform.tasks t ON t.root_task_id=p.task_id WHERE t.id=$1",[taskId])).rowCount;
    if(!mapped)throw new PlatformError("PRODUCT_CONTEXT_UNAVAILABLE",403,"Growth task context is unavailable");
    const s=await this.scope(taskId);
    const response=await this.call(taskId,"authorize:"+randomUUID(),"authorization.check",{context:s.context});
    if(response.authorized!==true)throw new PlatformError("PRODUCT_AUTHORITY_INACTIVE",403,"Growth execution access is unavailable");
    await assertCurrentEvidence(this.pool,taskId,await taskEvidenceManifest(this.pool,taskId),{requireActiveTask:false});
  }
  async readContext(taskId:string,operationId:string) {
    await this.authorizeTask(taskId);
    const scope=await this.scope(taskId);
    const response=scope.context?await this.call(taskId,operationId,"context.read",{context:scope.context}):await this.call(taskId,operationId,"workspace.read",{});
    if(!response||typeof response.revision!=="string"||!Array.isArray(response.sources))throw new PlatformError("PRODUCT_EVIDENCE_INVALID",502,"Growth evidence is unavailable");
    if(response.revision!==scope.context_revision)throw new PlatformError("GROWTH_CONTEXT_CHANGED",409,"The accepted Growth context changed");
    await this.pool.query("UPDATE agents_platform.product_task_contexts SET sources=$2 WHERE task_id=$1",[taskId,JSON.stringify(response.sources)]);
    const passage=await this.evidence.recordProduct(taskId,operationId,{product:"growth",tenantId:scope.tenant_id,
      contextRevision:response.revision,text:fitUtf8(JSON.stringify(response.data),7600),title:(response.sources[0]?.title??"Growth context").slice(0,512),
      acquiredAt:new Date().toISOString(),sources:response.sources});
    return {...response,data:null,passages:[{evidenceId:passage.reference.id,label:passage.label,citation:"["+passage.label+"]",text:passage.text,title:passage.title}]};
  }
  async project(review:GrowthAgentReview,taskId:string):Promise<void> {
    if(review.taskId!==taskId)throw new PlatformError("PRODUCT_REVIEW_SCOPE_DENIED",403,"The review is outside this task");
    await this.pool.query("INSERT INTO agents_platform.product_review_projections(review_id,task_id,payload_digest,state,projection) VALUES($1,$2,$3,$4,$5) ON CONFLICT(review_id) DO UPDATE SET payload_digest=excluded.payload_digest,state=excluded.state,projection=excluded.projection,updated_at=now() WHERE product_review_projections.task_id=excluded.task_id",[review.id,taskId,review.payloadDigest,review.state,review]);
  }
  async review(taskId:string,operationId:string,reviewId:string) {
    await this.authorizeTask(taskId);
    const value=await this.call(taskId,operationId,"draft.reconcile",{reviewId});
    await this.project(value.review,taskId);
    return value;
  }
  async commit(taskId:string,operationId:string,review:GrowthAgentReview) {
    await this.authorizeTask(taskId);
    let value;
    try {value=await this.call(taskId,operationId,"draft.commit",{reviewId:review.id,payloadDigest:review.payloadDigest});}
    catch(error) {
      if(!(error instanceof PlatformError)||error.statusCode<500)throw error;
      value=await this.review(taskId,operationId+":reconcile",review.id);
      if(!value.result&&value.review.state!=="saved")throw new PlatformError("GROWTH_EFFECT_UNCERTAIN",409,"The draft save has not been confirmed");
    }
    await this.project(value.review,taskId);
    if(value.review.state==="uncertain")throw new PlatformError("GROWTH_EFFECT_UNCERTAIN",409,"The draft save has not been confirmed");
    if(!value.result||value.result.state!=="saved")throw new PlatformError("GROWTH_DRAFT_NOT_SAVED",409,"The draft was not saved");
    return value;
  }
}
