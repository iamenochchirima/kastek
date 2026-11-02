import { randomUUID } from "node:crypto";
import type { Pool,PoolClient } from "pg";
import type { ProductCapabilityInvocation,ProductCapabilityResult,ProductReviewReference } from "@kasitek-labs/contracts";
import { z } from "zod";
import { ExecutableAdapterRegistry,type AdapterManifest,type CapabilityBinding } from "../../contracts/capability-catalog";
import { PlatformError,requestDigest } from "../../contracts/contracts";
import { registerProductAdapter,productDescriptor,assertProductBindings,type InstalledProductAdapter } from "../../capabilities/products/product-capabilities";
import { registerProductPorts } from "../../infrastructure/product-ports";
import { loadExecution,assertCurrentAuthority } from "../lifecycle/execution";
import { inspectionAuthority } from "../context/evidence-policy";
import { EvidenceStore } from "../context/evidence";
const sourceSchema=z.strictObject({id:z.string().min(1).max(1024),revision:z.string().regex(/^[a-f0-9]{64}$/),title:z.string().min(1).max(512),text:z.string().min(1).max(8192),acquiredAt:z.iso.datetime({offset:true}),continuation:z.string().max(2048).nullable(),route:z.string().max(2048).refine(value=>value.startsWith("/")&&!value.startsWith("//")&&!/[\x00-\x20\x7f]/.test(value)).optional()});
const reviewSchema=z.strictObject({id:z.string().min(1).max(256),product:z.string().min(1).max(128),taskId:z.uuid(),operationId:z.string().min(1).max(256),payloadDigest:z.string().regex(/^[a-f0-9]{64}$/),state:z.enum(["proposed","approved","saved","rejected","expired","uncertain"]),expiresAt:z.iso.datetime({offset:true})});
export interface ProductRuntimePort {
  prepareExecution?(taskId:string):Promise<void>;
  authorizeTask(taskId:string):Promise<void>;
  authorizeControl(taskId:string):Promise<void>;
  availableBindings(taskId:string):Promise<CapabilityBinding[]>;
  invoke(taskId:string,operationId:string,binding:CapabilityBinding,args:unknown,signal?:AbortSignal):Promise<ProductCapabilityResult>;
  prepare(taskId:string,operationId:string,binding:CapabilityBinding,args:unknown):Promise<ProductCapabilityResult>;
  review(taskId:string,operationId:string,binding:CapabilityBinding,review:ProductReviewReference):Promise<ProductCapabilityResult>;
  commit(taskId:string,operationId:string,binding:CapabilityBinding,review:ProductReviewReference,signal?:AbortSignal,statusOnly?:boolean):Promise<ProductCapabilityResult>;
}
export class ProductRuntime implements ProductRuntimePort {
  private readonly originAuthorizers=new Map<string,(taskId:string,db:Pool|PoolClient)=>Promise<void>>();
  registerOriginAuthorizer(product:string,authorize:(taskId:string,db:Pool|PoolClient)=>Promise<void>){if(this.originAuthorizers.has(product))throw new PlatformError("PRODUCT_ORIGIN_AUTHORITY_CONFLICT",409,"The origin authority is already installed");this.originAuthorizers.set(product,authorize);}
  private readonly adapters=new ExecutableAdapterRegistry<InstalledProductAdapter>();
  registerAdapter(manifest:AdapterManifest,adapter:InstalledProductAdapter){registerProductAdapter(manifest,adapter);return this.adapters.register(manifest,adapter);}
  constructor(readonly pool:Pool,readonly evidence=new EvidenceStore(pool)) {
    registerProductPorts(pool,{assertCurrentEvidence:async(db,{consumerTaskId,dependency})=>{
      const source=await loadExecution(db,dependency.taskId),consumer=await loadExecution(db,consumerTaskId);
      const binding=source.configuration.productBindings.find(value=>value.id===dependency.bindingId&&value.digest===dependency.bindingDigest);
      if(!binding||!binding.authority||binding.authority.destinationProduct!==dependency.product||binding.authority.tenantId!==dependency.tenantId||requestDigest(source.task.principal)!==requestDigest(consumer.task.principal)||source.task.organization_id!==consumer.task.organization_id)throw denied();
      const result=await this.dispatch(db,dependency.taskId,"evidence:"+randomUUID(),binding,"evidence",{source:{id:dependency.sourceId,revision:dependency.contextRevision}});
      const value=result.value as {authorized?:boolean;revision?:string};if(value?.authorized!==true||value.revision!==dependency.contextRevision)throw new PlatformError("EVIDENCE_UNAVAILABLE",403,"Product source access changed");
    }});
  }
  private async scope(db:Pool|PoolClient,taskId:string,binding?:CapabilityBinding){
    const execution=await loadExecution(db,taskId);await inspectionAuthority(db,execution);
    const s=(await db.query("SELECT p.*,n.revoked_at,f.enabled FROM agents_platform.tasks t JOIN agents_platform.product_task_contexts p ON p.task_id=t.root_task_id JOIN agents_platform.product_execution_tenants n ON n.product=p.product AND n.tenant_id=p.tenant_id JOIN agents_platform.product_execution_features f ON f.product=p.product AND f.tenant_id=p.tenant_id AND f.feature_id=p.feature_id WHERE t.id=$1",[taskId])).rows[0];
    if(!s||s.revoked_at||!s.enabled||execution.task.principal.kind!=="human")throw denied();
    if(binding){assertProductBindings([binding]);const a=binding.authority!;
      if(!execution.configuration.productBindings.some(value=>value.id===binding.id&&value.digest===binding.digest)||binding.organizationId!==execution.task.organization_id||a.originProduct!==execution.task.product||a.originTenantId!==s.tenant_id)throw denied();}
    return {execution,scope:s};
  }
  private async dispatch(db:Pool|PoolClient,taskId:string,operationId:string,binding:CapabilityBinding,control:ProductCapabilityInvocation["control"],input:unknown,review?:ProductReviewReference,signal?:AbortSignal,originAuthorized=false):Promise<ProductCapabilityResult>{
    const {execution,scope}=await this.scope(db,taskId,binding);if(["invoke","prepare","commit"].includes(control))await assertCurrentAuthority(db,execution);if(!originAuthorized)await this.originAuthority(execution.task.product,taskId,db);const p=execution.task.principal;if(p.kind!=="human")throw denied();
    const command:ProductCapabilityInvocation={version:"1",requestId:randomUUID(),operationId,taskId,conversationId:execution.task.parent_task_id?scope.conversation_id:execution.task.conversation_id,
      actor:{issuer:p.issuer,subject:p.subject},authority:binding.authority!,bindingId:binding.id,bindingDigest:binding.digest,operation:binding.definition.providerOperation,control,input,...(review?{review}:{})};
    const timeout=AbortSignal.timeout(binding.limits.timeoutMs);
    const result=await this.adapters.resolve(binding).invoke(command,signal?AbortSignal.any([signal,timeout]):timeout);
    if(!result||typeof result!=="object"||!("value" in result)||Buffer.byteLength(JSON.stringify(result))>binding.limits.maxResponseBytes)throw new PlatformError("PRODUCT_RESULT_INVALID",502,"The product returned an invalid or oversized result");
    if(result.sources){try{result.sources=z.array(sourceSchema).max(128).parse(result.sources);}catch{throw new PlatformError("PRODUCT_EVIDENCE_INVALID",502,"The product source observations are invalid");}}
    if(result.review){const checked=reviewSchema.parse(result.review);if(checked.product!==binding.authority!.destinationProduct||checked.taskId!==taskId||checked.operationId!==operationId.split(":review:")[0])throw denied();}
    return result;
  }
  private async originAuthority(product:string,taskId:string,db:Pool|PoolClient=this.pool):Promise<void>{const authorize=this.originAuthorizers.get(product);if(!authorize)throw new PlatformError("PRODUCT_ORIGIN_AUTHORITY_UNAVAILABLE",503,"The originating product authorization is unavailable");await authorize(taskId,db);}
  async authorizeTask(taskId:string):Promise<void>{const {execution}=await this.scope(this.pool,taskId);await this.originAuthority(execution.task.product,taskId);}
  async authorizeControl(taskId:string):Promise<void>{await this.authorizeTask(taskId);}
  async availableBindings(taskId:string):Promise<CapabilityBinding[]>{
    await this.authorizeTask(taskId);const execution=await loadExecution(this.pool,taskId),available:CapabilityBinding[]=[];
    for(const binding of execution.configuration.productBindings)try{const result=await this.dispatch(this.pool,taskId,"availability:"+randomUUID(),binding,"authorize",{},undefined,undefined,true);if((result.value as {authorized?:boolean})?.authorized===true)available.push(binding);}
    catch(error){if(!(error instanceof PlatformError)||![403,404].includes(error.statusCode))throw error;}
    return available;
  }
  async invoke(taskId:string,operationId:string,binding:CapabilityBinding,args:unknown,signal?:AbortSignal):Promise<ProductCapabilityResult>{
    await validateProductArguments(binding,args);
    const result=await this.dispatch(this.pool,taskId,operationId,binding,"invoke",args,undefined,signal);
    if(binding.definition.outputSchema){const {AjvJsonSchemaValidator}=await import("@modelcontextprotocol/client/validators/ajv");if(!new AjvJsonSchemaValidator().getValidator(binding.definition.outputSchema as Record<string,unknown>)(result.value).valid)throw new PlatformError("PRODUCT_RESULT_INVALID",502,"The product result does not match the published schema");}
    return this.observe(taskId,operationId,binding,result);
  }
  async prepare(taskId:string,operationId:string,binding:CapabilityBinding,args:unknown){await validateProductArguments(binding,args);const result=await this.dispatch(this.pool,taskId,operationId,binding,"prepare",args);if(!result.review)throw denied();await this.project(result.review,taskId);return result;}
  async review(taskId:string,operationId:string,binding:CapabilityBinding,review:ProductReviewReference){const result=await this.dispatch(this.pool,taskId,operationId,binding,"review",{},review);if(!result.review||result.review.id!==review.id||result.review.payloadDigest!==review.payloadDigest)throw denied();await this.project(result.review,taskId);return result;}
  async commit(taskId:string,operationId:string,binding:CapabilityBinding,review:ProductReviewReference,signal?:AbortSignal,statusOnly=false){
    let result:ProductCapabilityResult;
    try{result=statusOnly?await this.review(taskId,operationId,binding,review):await this.dispatch(this.pool,taskId,operationId,binding,"commit",{},review,signal);}catch(error){if(!(error instanceof PlatformError)||error.statusCode<500)throw error;result=await this.review(taskId,operationId,binding,review);}
    if(result.review)await this.project(result.review,taskId);
    if(!result.receipt||result.receipt.state!=="saved"||result.receipt.operationId!==operationId||result.receipt.payloadDigest!==review.payloadDigest)throw new PlatformError("PRODUCT_EFFECT_UNCERTAIN",409,"The product effect has not been confirmed");
    return result;
  }
  async project(review:ProductReviewReference,taskId:string){await this.pool.query("INSERT INTO agents_platform.product_review_projections(review_id,task_id,payload_digest,state,projection,product) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(product,review_id) DO UPDATE SET payload_digest=excluded.payload_digest,state=excluded.state,projection=excluded.projection,updated_at=now() WHERE product_review_projections.task_id=excluded.task_id",[review.id,taskId,review.payloadDigest,review.state,review,review.product]);}
  private async observe(taskId:string,operationId:string,binding:CapabilityBinding,result:ProductCapabilityResult):Promise<ProductCapabilityResult>{
    const sources=result.sources??[];if(productDescriptor(binding).evidence!=="versioned_sources"&&sources.length)throw denied();
    const passages=[];for(const source of sources){const passage=await this.evidence.recordProduct(taskId,operationId,{product:binding.authority!.destinationProduct,tenantId:binding.authority!.tenantId,contextRevision:source.revision,text:source.text,title:source.title,acquiredAt:source.acquiredAt,sources:[source],bindingId:binding.id,bindingDigest:binding.digest,operationName:binding.alias});
      await this.pool.query("UPDATE agents_platform.product_task_contexts SET sources=CASE WHEN sources @> $2::jsonb THEN sources ELSE sources || $2::jsonb END WHERE task_id=(SELECT root_task_id FROM agents_platform.tasks WHERE id=$1)",[taskId,JSON.stringify([{id:source.id,revision:source.revision,title:source.title,route:source.route,citationLabel:passage.label,bindingId:binding.id,operationId}])]);
      passages.push({...source,text:passage.text,evidenceId:passage.reference.id,label:passage.label,citation:"["+passage.label+"]"});}
    return {...result,sources:undefined,...(passages.length?{value:{data:result.value,passages}}:{})};
  }
}
function denied(){return new PlatformError("PRODUCT_AUTHORITY_INACTIVE",403,"Product capability access is unavailable");}
export async function validateProductArguments(binding:CapabilityBinding,args:unknown):Promise<void>{
  productDescriptor(binding);if(Buffer.byteLength(JSON.stringify(args)??"null")>32768)throw new PlatformError("TOOL_ARGUMENTS_INVALID",400,"Tool arguments exceed the schema limit");
  const {AjvJsonSchemaValidator}=await import("@modelcontextprotocol/client/validators/ajv");
  if(!new AjvJsonSchemaValidator().getValidator(binding.definition.inputSchema as Record<string,unknown>)(args).valid)throw new PlatformError("TOOL_ARGUMENTS_INVALID",400,"Check the arguments against the tool schema");
}
