import { randomUUID } from "node:crypto";
import type { Pool,PoolClient } from "pg";
import type { ProductCapabilityInvocation,ProductCapabilityResult,ProductReviewReference } from "@kasitek-labs/contracts";
import { z } from "zod";
import { ExecutableAdapterRegistry,type AdapterManifest,type CapabilityBinding } from "../../contracts/capability-catalog";
import { PlatformError,requestDigest } from "../../contracts/contracts";
import { registerProductAdapter,registerRetainedProductAdapter,registerProductManifest,productDescriptor,assertProductBindings,requiresProductAccess,productEffectProjection,type InstalledProductAdapter } from "../../capabilities/products/product-capabilities";
import { registerProductPorts } from "../../infrastructure/product-ports";
import type { ProductContextDependency } from "../../infrastructure/product-ports";
import { loadExecution,assertCurrentAuthority,transaction } from "../lifecycle/execution";
import { inspectionAuthority } from "../context/evidence-policy";
import { EvidenceStore } from "../context/evidence";
import { narrowProductInformation } from "../../contracts/product-information";
import { assertProductInformationAudience, currentProductInformation, executionProductInformation } from "./product-information";
import { assertProductReadCustody } from "./product-read-custody";
import { productModelResult } from "./product-result";
import { projectProductReferences, resolveProductReferences } from "./product-references";
const sourceSchema=z.strictObject({id:z.string().min(1).max(1024),revision:z.string().regex(/^[a-f0-9]{64}$/),title:z.string().min(1).max(512),text:z.string().min(1).max(8192),acquiredAt:z.iso.datetime({offset:true}),continuation:z.string().max(2048).nullable(),route:z.string().max(2048).refine(value=>value.startsWith("/")&&!value.startsWith("//")&&!/[\x00-\x20\x7f]/.test(value)).optional()});
const accessSchema=z.strictObject({version:z.literal("1"),reference:z.string().min(1).max(1024),scopeReference:z.string().min(1).max(1024),resultDigest:z.string().regex(/^[a-f0-9]{64}$/)});
const reviewSchema=z.strictObject({id:z.string().min(1).max(256),product:z.string().min(1).max(128),taskId:z.uuid(),operationId:z.string().min(1).max(256),payloadDigest:z.string().regex(/^[a-f0-9]{64}$/),state:z.enum(["proposed","approved","saved","rejected","expired","uncertain"]),expiresAt:z.iso.datetime({offset:true})});
export interface ProductRuntimePort {
  prepareExecution?(taskId:string):Promise<void>;
  authorizeTask(taskId:string):Promise<void>;
  authorizeControl(taskId:string):Promise<void>;
  authorizeReconciliation?(taskId:string):Promise<void>;
  selectedContextReference(taskId:string):Promise<{reference:unknown;dependency:ProductContextDependency}|null>;
  availableBindings(taskId:string):Promise<CapabilityBinding[]>;
  invoke(taskId:string,operationId:string,binding:CapabilityBinding,args:unknown,signal?:AbortSignal,statusOnly?:boolean):Promise<ProductCapabilityResult>;
  prepare(taskId:string,operationId:string,binding:CapabilityBinding,args:unknown):Promise<ProductCapabilityResult>;
  review(taskId:string,operationId:string,binding:CapabilityBinding,review:ProductReviewReference):Promise<ProductCapabilityResult>;
  commit(taskId:string,operationId:string,binding:CapabilityBinding,review:ProductReviewReference,signal?:AbortSignal,statusOnly?:boolean):Promise<ProductCapabilityResult>;
  projectForModel?(taskId:string,operationId:string,binding:CapabilityBinding,output:unknown):Promise<unknown>;
}
export class ProductRuntime implements ProductRuntimePort {
  async prepareExecution(taskId:string):Promise<void>{
    const rows=(await this.pool.query(`SELECT n.manifest FROM agents_platform.product_capability_publications n
      WHERE EXISTS(SELECT 1 FROM agents_platform.tasks t JOIN agents_platform.product_task_contexts p ON p.task_id=t.root_task_id
        WHERE t.id=$1 AND p.product=n.product AND p.tenant_id=n.tenant_id) ORDER BY n.created_at`,[taskId])).rows;
    for(const row of rows)registerProductManifest(row.manifest);
  }
  private readonly originAuthorizers=new Map<string,(taskId:string,db:Pool|PoolClient)=>Promise<void>>();
  private readonly contextReaders=new Map<string,(taskId:string,db:Pool|PoolClient)=>Promise<unknown|null>>();
  registerOriginAuthorizer(product:string,authorize:(taskId:string,db:Pool|PoolClient)=>Promise<void>){if(this.originAuthorizers.has(product))throw new PlatformError("PRODUCT_ORIGIN_AUTHORITY_CONFLICT",409,"The origin authority is already installed");this.originAuthorizers.set(product,authorize);}
  registerContextReader(product:string,read:(taskId:string,db:Pool|PoolClient)=>Promise<unknown|null>){if(this.contextReaders.has(product))throw new PlatformError("PRODUCT_CONTEXT_CONFLICT",409,"The context reader is already installed");this.contextReaders.set(product,read);}
  private readonly adapters=new ExecutableAdapterRegistry<InstalledProductAdapter>();
  registerAdapter(manifest:AdapterManifest,adapter:InstalledProductAdapter){registerProductAdapter(manifest,adapter);return this.adapters.register(manifest,adapter);}
  registerRetainedAdapter(manifest:AdapterManifest,adapter:InstalledProductAdapter){registerRetainedProductAdapter(manifest,adapter);return this.adapters.registerRetainedVariant(manifest,adapter);}
  constructor(readonly pool:Pool,readonly evidence=new EvidenceStore(pool)) {
    registerProductPorts(pool,{assertCurrentEvidence:async(db,{consumerTaskId,dependency})=>{
      const source=await loadExecution(db,dependency.taskId),consumer=await loadExecution(db,consumerTaskId);
      const binding=source.configuration.productBindings.find(value=>value.id===dependency.bindingId&&value.digest===dependency.bindingDigest);
      if(!binding||!binding.authority||binding.authority.destinationProduct!==dependency.product||binding.authority.tenantId!==dependency.tenantId||requestDigest(source.task.principal)!==requestDigest(consumer.task.principal)||source.task.organization_id!==consumer.task.organization_id)throw denied();
      if(dependency.information)await assertProductInformationAudience(db,consumer,dependency.information,dependency);
      const result=await this.dispatch(db,dependency.taskId,"evidence:"+randomUUID(),binding,"evidence",{source:{id:dependency.sourceId,revision:dependency.contextRevision}});
      const value=result.value as {authorized?:boolean;revision?:string};if(value?.authorized!==true||value.revision!==dependency.contextRevision)throw new PlatformError("EVIDENCE_UNAVAILABLE",403,"Product source access changed");
    },assertCurrentAccess:async(db,{consumerTaskId,dependency})=>{
      const source=await loadExecution(db,dependency.taskId),consumer=await loadExecution(db,consumerTaskId);
      const binding=source.configuration.productBindings.find(value=>value.id===dependency.bindingId&&value.digest===dependency.bindingDigest);
      if(!binding||!binding.authority||!requiresProductAccess(binding)||binding.authority.destinationProduct!==dependency.product||binding.authority.tenantId!==dependency.tenantId||requestDigest(source.task.principal)!==requestDigest(consumer.task.principal)||source.task.organization_id!==consumer.task.organization_id)throw denied();
      const row=(await db.query(`SELECT a.*,o.state,o.output,o.name,o.request FROM agents_platform.product_operation_access a
        JOIN agents_platform.operations o ON o.id=a.operation_id AND o.task_id=a.task_id
        WHERE a.task_id=$1 AND a.scope_reference=$2 AND a.binding_id=$3 AND a.binding_digest=$4 AND a.information=$5::jsonb
          AND o.state='completed' ORDER BY a.created_at,a.operation_id LIMIT 1`,[dependency.taskId,dependency.reference,binding.id,binding.digest,JSON.stringify(dependency.information)])).rows[0];
      if(!row||row.state!=="completed"||row.name!==binding.alias||row.binding_id!==binding.id||row.binding_digest!==binding.digest||
        row.scope_reference!==dependency.reference||requestDigest(row.information)!==requestDigest(dependency.information)||!row.output||!("value" in row.output)||
        row.request?.productBindingId!==binding.id||row.request?.bindingDigest!==binding.digest||requestDigest(row.output.value)!==row.result_digest)throw denied();
      await assertProductInformationAudience(db,consumer,dependency.information,dependency);
      const result=await this.dispatch(db,dependency.taskId,"evidence:"+randomUUID(),binding,"evidence",{source:{id:dependency.reference}});
      const value=result.value as {authorized?:boolean;scopeReference?:string};
      if(value?.authorized!==true||value.scopeReference!==dependency.reference||!result.information||
        dependency.information.providers.some(provider=>!result.information!.providers.some(current=>requestDigest(current)===requestDigest(provider))))throw new PlatformError("EVIDENCE_UNAVAILABLE",403,"Product result access changed");
    },assertCurrentContext:async(db,{consumerTaskId,dependency})=>{
      const source=await loadExecution(db,dependency.taskId),consumer=await loadExecution(db,consumerTaskId);
      if(source.task.parent_task_id||source.task.product!==dependency.product||consumer.task.product!==dependency.product||
        source.task.organization_id!==consumer.task.organization_id||requestDigest(source.task.principal)!==requestDigest(consumer.task.principal))throw denied();
      const information=await currentProductInformation(db,source);
      if(information.origin.tenantId!==dependency.tenantId||requestDigest(information)!==requestDigest(dependency.information))throw denied();
      await assertProductInformationAudience(db,consumer,dependency.information,dependency);
      const reader=this.contextReaders.get(dependency.product);
      if(!reader)throw new PlatformError("PRODUCT_CONTEXT_UNAVAILABLE",503,"Product context authorization is unavailable");
      const reference=await reader(source.task.id,db);
      if(reference===null||requestDigest(reference)!==dependency.referenceDigest)throw denied();
      await this.originAuthority(dependency.product,source.task.id,db);
    },assertCurrentOrigin:async(db,taskId)=>{
      const {execution}=await this.scope(db,taskId);
      await this.originAuthority(execution.task.product,taskId,db);
    },assertCurrentArtifact:async(db,{consumerTaskId,dependency})=>{
      const {execution:source}=await this.scope(db,dependency.taskId),{execution:consumer}=await this.scope(db,consumerTaskId);
      if(source.task.product!==dependency.product||consumer.task.product!==dependency.product||
        source.task.organization_id!==consumer.task.organization_id||requestDigest(source.task.principal)!==requestDigest(consumer.task.principal))throw denied();
      const information=await currentProductInformation(db,source);
      if(information.origin.tenantId!==dependency.tenantId||requestDigest(information)!==requestDigest(dependency.information))throw denied();
      await assertProductInformationAudience(db,consumer,dependency.information,dependency);
      const row=(await db.query(`SELECT 1 FROM agents_platform.artifacts WHERE id=$1 AND task_id=$2 AND organization_id=$3
        AND product_owner=$4 AND account_id IS NULL AND content_digest=$5 AND root_task_id=$6 AND agent_id=$7
        AND name=$8 AND content_type=$9 AND bytes=$10 AND state='available' FOR SHARE`,
        [dependency.artifactId,dependency.taskId,source.task.organization_id,dependency.product,dependency.contentDigest,source.task.root_task_id,source.agentId,
          dependency.name,dependency.contentType,dependency.bytes])).rows[0];
      if(!row)throw denied();
      await this.originAuthority(dependency.product,source.task.id,db);
      if(source.task.id!==consumer.task.id)await this.originAuthority(dependency.product,consumer.task.id,db);
    }});
  }
  private async scope(db:Pool|PoolClient,taskId:string,binding?:CapabilityBinding){
    const execution=await loadExecution(db,taskId);await inspectionAuthority(db,execution);
    const s=(await db.query("SELECT p.*,n.revoked_at,f.enabled FROM agents_platform.tasks t JOIN agents_platform.product_task_contexts p ON p.task_id=t.root_task_id JOIN agents_platform.product_execution_tenants n ON n.product=p.product AND n.tenant_id=p.tenant_id JOIN agents_platform.product_execution_features f ON f.product=p.product AND f.tenant_id=p.tenant_id AND f.feature_id=p.feature_id WHERE t.id=$1",[taskId])).rows[0];
    if(!s||s.revoked_at||!s.enabled||execution.task.principal.kind!=="human")throw denied();
    if(binding){assertProductBindings([binding]);const a=binding.authority!;
      if(!execution.configuration.productBindings.some(value=>value.id===binding.id&&value.digest===binding.digest)||binding.organizationId!==execution.task.organization_id||a.originProduct!==execution.task.product||a.originTenantId!==s.tenant_id||
        (s.client_id??null)!==(a.originClientId??null))throw denied();}
    return {execution,scope:s};
  }
  private async dispatch(db:Pool|PoolClient,taskId:string,operationId:string,binding:CapabilityBinding,control:ProductCapabilityInvocation["control"],input:unknown,review?:ProductReviewReference,signal?:AbortSignal,originAuthorized=false,effectObservation=false):Promise<ProductCapabilityResult>{
    const {execution,scope}=await this.scope(db,taskId,binding);if(["invoke","prepare","commit"].includes(control))await assertCurrentAuthority(db,execution);if(!originAuthorized)await this.originAuthority(execution.task.product,taskId,db);const p=execution.task.principal;if(p.kind!=="human")throw denied();
    const modelOrigin=execution.task.parent_task_id?await loadExecution(db,execution.task.root_task_id):execution;
    const accessRequired=requiresProductAccess(binding);
    const information=execution.task.harness_release==="product-capabilities-v15"||accessRequired?executionProductInformation(execution,scope,modelOrigin.models):undefined;
    const command:ProductCapabilityInvocation={version:"1",requestId:randomUUID(),operationId,taskId,conversationId:execution.task.parent_task_id?scope.conversation_id:execution.task.conversation_id,
      actor:{issuer:p.issuer,subject:p.subject},authority:binding.authority!,bindingId:binding.id,bindingDigest:binding.digest,operation:binding.definition.providerOperation,control,input,...(review?{review}:{}),
      ...(information?{information,execution:{version:"1",workId:execution.task.work_id??execution.task.root_task_id,rootTaskId:execution.task.root_task_id,parentTaskId:execution.task.parent_task_id,taskId}}:{}),
      ...(accessRequired&&control==="invoke"?{observation:"access-v1" as const}:effectObservation?{observation:"effect-status-v1" as const}:{})};
    const timeout=AbortSignal.timeout(binding.limits.timeoutMs);
    const result=await this.adapters.resolve(binding).invoke(command,signal?AbortSignal.any([signal,timeout]):timeout);
    if(!result||typeof result!=="object"||!("value" in result)||Buffer.byteLength(JSON.stringify(result))>binding.limits.maxResponseBytes)throw new PlatformError("PRODUCT_RESULT_INVALID",502,"The product returned an invalid or oversized result");
    if(information)result.information=narrowProductInformation(information,result.information);
    else if(result.information)throw new PlatformError("PRODUCT_INFORMATION_DENIED",403,"Unexpected product information policy");
    if(result.sources){try{result.sources=z.array(sourceSchema).max(128).parse(result.sources);}catch{throw new PlatformError("PRODUCT_EVIDENCE_INVALID",502,"The product source observations are invalid");}}
    if(accessRequired&&control==="invoke"){
      try{result.access=accessSchema.parse(result.access);}catch{throw new PlatformError("PRODUCT_ACCESS_UNAVAILABLE",503,"The product result has no access observation");}
      if(result.access.resultDigest!==requestDigest(result.value))throw new PlatformError("PRODUCT_ACCESS_INVALID",502,"The product result observation does not match");
    }else if(effectObservation&&result.access){
      try{result.access=accessSchema.parse(result.access);}catch{throw new PlatformError("PRODUCT_ACCESS_INVALID",502,"The product result observation is invalid");}
      if(result.access.resultDigest!==requestDigest(result.value))throw new PlatformError("PRODUCT_ACCESS_INVALID",502,"The product result observation does not match");
    }else if(result.access)throw new PlatformError("PRODUCT_ACCESS_INVALID",502,"Unexpected product access observation");
    if(result.review){const checked=reviewSchema.parse(result.review);if(checked.product!==binding.authority!.destinationProduct||checked.taskId!==taskId||checked.operationId!==operationId.split(":review:")[0])throw denied();}
    return result;
  }
  private async originAuthority(product:string,taskId:string,db:Pool|PoolClient=this.pool):Promise<void>{const authorize=this.originAuthorizers.get(product);if(!authorize)throw new PlatformError("PRODUCT_ORIGIN_AUTHORITY_UNAVAILABLE",503,"The originating product authorization is unavailable");await authorize(taskId,db);}
  async authorizeTask(taskId:string):Promise<void>{await this.prepareExecution(taskId);const {execution}=await this.scope(this.pool,taskId);await this.originAuthority(execution.task.product,taskId);await assertProductReadCustody(this.pool,taskId);}
  async authorizeControl(taskId:string):Promise<void>{await this.authorizeReconciliation(taskId);}
  async authorizeReconciliation(taskId:string):Promise<void>{await this.prepareExecution(taskId);const {execution}=await this.scope(this.pool,taskId);await this.originAuthority(execution.task.product,taskId);}
  async selectedContextReference(taskId:string):Promise<{reference:unknown;dependency:ProductContextDependency}|null>{
    const {execution}=await this.scope(this.pool,taskId);
    if(execution.task.parent_task_id)return null;
    const reader=this.contextReaders.get(execution.task.product);if(!reader)return null;
    const reference=await reader(taskId,this.pool);if(reference===null)return null;
    await this.originAuthority(execution.task.product,taskId);
    const information=await currentProductInformation(this.pool,execution);
    return {reference,dependency:{kind:"product_context",product:execution.task.product,tenantId:information.origin.tenantId,
      taskId,referenceDigest:requestDigest(reference),information}};
  }
  async availableBindings(taskId:string):Promise<CapabilityBinding[]>{
    await this.authorizeTask(taskId);const execution=await loadExecution(this.pool,taskId),available:CapabilityBinding[]=[];
    for(const binding of execution.configuration.productBindings)try{if(binding.policy.effect==="reviewed_write"&&!productEffectProjection(binding))continue;const result=await this.dispatch(this.pool,taskId,"availability:"+randomUUID(),binding,"authorize",{},undefined,undefined,true);if((result.value as {authorized?:boolean})?.authorized===true)available.push(binding);}
    catch(error){if(!(error instanceof PlatformError)||![403,404].includes(error.statusCode))throw error;}
    return available;
  }
  async projectForModel(taskId:string,operationId:string,binding:CapabilityBinding,output:unknown):Promise<unknown>{
    const projected=productModelResult(binding,output,taskId,operationId);
    return projectProductReferences(this.pool,taskId,operationId,binding,projected);
  }
  async invoke(taskId:string,operationId:string,binding:CapabilityBinding,args:unknown,signal?:AbortSignal,statusOnly=false):Promise<ProductCapabilityResult>{
    await validateProductArguments(binding,args);
    const resolvedArgs=await resolveProductReferences(this.pool,taskId,binding,args);
    const direct=["draft_write","authorized_write"].includes(binding.policy.effect);
    if(statusOnly&&!direct)throw new PlatformError("PRODUCT_CONTROL_DENIED",403,"Status-only write recovery requires direct product write authority");
    let result:ProductCapabilityResult;
    try { result=await this.dispatch(this.pool,taskId,operationId,binding,direct&&statusOnly?"review":"invoke",resolvedArgs,undefined,signal); }
    catch(error) {
      if(!direct||statusOnly||!(error instanceof PlatformError)||error.statusCode<500)throw error;
      result=await this.dispatch(this.pool,taskId,operationId,binding,"review",resolvedArgs);
    }
    if(direct){
      const input=resolvedArgs&&typeof resolvedArgs==="object"&&!Array.isArray(resolvedArgs)?Object.fromEntries(Object.entries(resolvedArgs).filter(([key])=>!["_requestId","_reviewId","_previewId","_continuation"].includes(key))):resolvedArgs;
      const expected=requestDigest({operation:binding.definition.providerOperation,version:binding.definition.product!.revision,input});
      if(!result.receipt||typeof result.receipt.id!=="string"||!result.receipt.id||result.receipt.id.length>256||result.receipt.state!=="saved"||result.receipt.operationId!==operationId||result.receipt.payloadDigest!==expected)
        throw new PlatformError("PRODUCT_EFFECT_UNCERTAIN",409,"The product write has no matching saved receipt");
    }
    if(binding.definition.outputSchema){const {AjvJsonSchemaValidator}=await import("@modelcontextprotocol/client/validators/ajv");if(!new AjvJsonSchemaValidator().getValidator(binding.definition.outputSchema as Record<string,unknown>)(result.value).valid)throw new PlatformError("PRODUCT_RESULT_INVALID",502,"The product result does not match the published schema");}
    return this.observe(taskId,operationId,binding,result);
  }
  async prepare(taskId:string,operationId:string,binding:CapabilityBinding,args:unknown){await validateProductArguments(binding,args);const resolvedArgs=await resolveProductReferences(this.pool,taskId,binding,args);const result=await this.dispatch(this.pool,taskId,operationId,binding,"prepare",resolvedArgs);if(!result.review)throw denied();await this.project(result.review,taskId);return modelResult(result);}
  async review(taskId:string,operationId:string,binding:CapabilityBinding,review:ProductReviewReference){const result=await this.dispatch(this.pool,taskId,operationId,binding,"review",{},review);if(!result.review||result.review.id!==review.id||result.review.payloadDigest!==review.payloadDigest)throw denied();await this.project(result.review,taskId);return modelResult(result);}
  async commit(taskId:string,operationId:string,binding:CapabilityBinding,review:ProductReviewReference,signal?:AbortSignal,statusOnly=false){
    const projection=productEffectProjection(binding);
    const reconcile=()=>projection?this.dispatch(this.pool,taskId,operationId,binding,"review",{},review,undefined,false,true):this.review(taskId,operationId,binding,review);
    let result:ProductCapabilityResult;
    try{result=statusOnly?await reconcile():await this.dispatch(this.pool,taskId,operationId,binding,"commit",{},review,signal,false,Boolean(projection));}
    catch(error){
      if(!(error instanceof PlatformError))throw error;
      if(!projection&&error.statusCode<500)throw error;
      try{result=await reconcile();}catch{throw new PlatformError("PRODUCT_EFFECT_UNCERTAIN",409,"The product effect has not been confirmed");}
    }
    if(!result.review||result.review.id!==review.id||result.review.payloadDigest!==review.payloadDigest)throw new PlatformError("PRODUCT_EFFECT_UNCERTAIN",409,"The product effect has not been confirmed");
    if(result.review)await this.project(result.review,taskId);
    if(!result.receipt||result.receipt.state!=="saved"||result.receipt.operationId!==operationId||result.receipt.payloadDigest!==review.payloadDigest)throw new PlatformError("PRODUCT_EFFECT_UNCERTAIN",409,"The product effect has not been confirmed");
    if(projection){
      if(!result.access)throw new PlatformError("PRODUCT_EFFECT_UNCERTAIN",409,"The product effect has not been confirmed");
      try{await this.recordAccess(taskId,operationId,binding,result);}catch{throw new PlatformError("PRODUCT_EFFECT_UNCERTAIN",409,"The product effect has not been confirmed");}
    }
    return modelResult(result);
  }
  async project(review:ProductReviewReference,taskId:string){await this.pool.query("INSERT INTO agents_platform.product_review_projections(review_id,task_id,payload_digest,state,projection,product) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(product,review_id) DO UPDATE SET payload_digest=excluded.payload_digest,state=excluded.state,projection=excluded.projection,updated_at=now() WHERE product_review_projections.task_id=excluded.task_id",[review.id,taskId,review.payloadDigest,review.state,review,review.product]);}
  private async observe(taskId:string,operationId:string,binding:CapabilityBinding,result:ProductCapabilityResult):Promise<ProductCapabilityResult>{
    if(requiresProductAccess(binding))await this.recordAccess(taskId,operationId,binding,result);
    const sources=result.sources??[];if(productDescriptor(binding).evidence!=="versioned_sources"&&sources.length)throw denied();
      const passages=[];for(const source of sources){const passage=await this.evidence.recordProduct(taskId,operationId,{product:binding.authority!.destinationProduct,tenantId:binding.authority!.tenantId,contextRevision:source.revision,text:source.text,title:source.title,acquiredAt:source.acquiredAt,sources:[source],bindingId:binding.id,bindingDigest:binding.digest,operationName:binding.alias,...(result.information?{information:result.information}:{})});
      await this.pool.query("UPDATE agents_platform.product_task_contexts SET sources=CASE WHEN sources @> $2::jsonb THEN sources ELSE sources || $2::jsonb END WHERE task_id=(SELECT root_task_id FROM agents_platform.tasks WHERE id=$1)",[taskId,JSON.stringify([{id:source.id,revision:source.revision,title:source.title,route:source.route,citationLabel:passage.label,bindingId:binding.id,operationId}])]);
      passages.push({...source,text:passage.text,evidenceId:passage.reference.id,label:passage.label,citation:"["+passage.label+"]"});}
    return {...modelResult(result),sources:undefined,...(passages.length?{value:{data:result.value,passages}}:{})};
  }
  private async recordAccess(taskId:string,operationId:string,binding:CapabilityBinding,result:ProductCapabilityResult):Promise<void>{
    const access=accessSchema.parse(result.access);
    if(!result.information||access.resultDigest!==requestDigest(result.value))throw new PlatformError("PRODUCT_ACCESS_INVALID",502,"The product result observation does not match");
    await transaction(this.pool,async db=>{
      const initial=await loadExecution(db,taskId);
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[initial.task.organization_id]);
      const {execution}=await this.scope(db,taskId,binding);await assertCurrentAuthority(db,execution);
      const operation=(await db.query("SELECT name,state,request FROM agents_platform.operations WHERE id=$1 AND task_id=$2 FOR UPDATE",[operationId,taskId])).rows[0];
      if(!operation||operation.state!=="started"||operation.name!==binding.alias||operation.request?.productBindingId!==binding.id||operation.request?.bindingDigest!==binding.digest)throw denied();
      await db.query(`INSERT INTO agents_platform.product_operation_access(operation_id,task_id,binding_id,binding_digest,reference,scope_reference,result_digest,information)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(operation_id) DO NOTHING`,[operationId,taskId,binding.id,binding.digest,access.reference,access.scopeReference,access.resultDigest,result.information]);
      const saved=(await db.query("SELECT * FROM agents_platform.product_operation_access WHERE operation_id=$1",[operationId])).rows[0];
      if(!saved||saved.task_id!==taskId||saved.binding_id!==binding.id||saved.binding_digest!==binding.digest||saved.reference!==access.reference||saved.scope_reference!==access.scopeReference||saved.result_digest!==access.resultDigest||requestDigest(saved.information)!==requestDigest(result.information))throw new PlatformError("PRODUCT_ACCESS_CONFLICT",409,"The product observation changed during recovery");
    });
  }
}
function modelResult(result:ProductCapabilityResult):ProductCapabilityResult{const {information:_information,access:_access,...value}=result;return value;}
function denied(){return new PlatformError("PRODUCT_AUTHORITY_INACTIVE",403,"Product capability access is unavailable");}
export async function validateProductArguments(binding:CapabilityBinding,args:unknown):Promise<void>{
  productDescriptor(binding);if(Buffer.byteLength(JSON.stringify(args)??"null")>32768)throw new PlatformError("TOOL_ARGUMENTS_INVALID",400,"Tool arguments exceed the schema limit");
  const {AjvJsonSchemaValidator}=await import("@modelcontextprotocol/client/validators/ajv");
  if(!new AjvJsonSchemaValidator().getValidator(binding.definition.inputSchema as Record<string,unknown>)(args).valid)throw new PlatformError("TOOL_ARGUMENTS_INVALID",400,"Check the arguments against the tool schema");
}
