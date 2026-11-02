import { Ajv } from "ajv";
import addFormats from "ajv-formats";
import type { FastifyInstance } from "fastify";
import { parseGrowthAgentContext, type ProductCapabilityInvocation, type ProductCapabilityResult, type ProductReviewReference, type GrowthAgentAction, type GrowthDraftReview } from "@kasitek-labs/contracts";
import type { CoreContext } from "../context.js";
import { ApiError } from "../error.js";
import { reportingDependencies } from "../services/analytics-reporting.js";
import { requireCapability } from "../services/billing.js";
import { authorizeGrowthAgentScope } from "./scope.js";
import { growthAgentDigest, verifyGrowthProductCapability } from "./security.js";
import { growthAgentPublication, growthAgentPublicationV2, growthAgentPublicationV3, growthAgentPublicationV4, growthAgentPublicationV5, growthAgentPublicationV6, growthAgentPublicationV7, growthAgentPublicationV8 } from "./manifest.js";
import { invokeInternalGrowthOperation } from "../operations/internal.js";
import { discoverGrowthRecords, readGrowthRecord, growthSourceHandle, resolveGrowthSourceHandle } from "./tools.js";
import { GrowthAgentReviewStore, type GrowthDraftPorts } from "./reviews.js";
const ajv=new Ajv({strict:false,allErrors:false});addFormats.default(ajv);
const publications = new Map([growthAgentPublicationV2, growthAgentPublicationV3, growthAgentPublicationV4, growthAgentPublicationV5, growthAgentPublicationV6, growthAgentPublicationV7, growthAgentPublicationV8, growthAgentPublication].map(publication => [publication.policy.revision, publication]));
const validators = new Map([...publications.values()].map(publication => [publication.manifest.digest, new Map(publication.manifest.operations.map(operation => [operation.operation, ajv.compile(operation.inputSchema)]))]));
function reviewReference(review:GrowthDraftReview,operationId:string):ProductReviewReference {
  return {id:review.id,product:"growth",taskId:review.taskId,operationId,payloadDigest:review.payloadDigest,
    state:review.state==="executing"||review.state==="failed"?"uncertain":review.state,expiresAt:review.expiresAt};
}
export function registerGrowthCapabilityRoutes(app:FastifyInstance,core:CoreContext,options:{drafts?:GrowthDraftPorts}={}) {
  const reviews=new GrowthAgentReviewStore(core,options.drafts);
  app.post("/internal/agents/capabilities",{bodyLimit:131072},async (request):Promise<ProductCapabilityResult>=>{
    await verifyGrowthProductCapability(core.config,request.headers.authorization,request.body);
    const command=request.body as ProductCapabilityInvocation;
    if(!command||command.version!=="1"||typeof command.requestId!=="string"||typeof command.operationId!=="string"||
      typeof command.taskId!=="string"||typeof command.conversationId!=="string"||!command.actor||!command.authority||
      typeof command.bindingId!=="string"||!/^[a-f0-9]{64}$/.test(command.bindingDigest)||
      !["invoke","authorize","prepare","review","commit","evidence"].includes(command.control))throw new ApiError(400,"agent_capability_invalid","Check the capability request");
    const authority=command.authority, publication=publications.get(authority.policyRevision), manifest=publication?.manifest, descriptor=manifest?.operations.find(o=>o.operation===command.operation);
    if(!descriptor||authority.kind!=="product"||authority.originProduct!=="growth"||authority.destinationProduct!=="growth"||
      authority.originTenantId!==authority.tenantId||authority.mappingRef!==`growth:${authority.tenantId}`||!publication||
      authority.manifestDigest!==manifest!.digest||authority.descriptorDigest!==growthAgentDigest(descriptor)||authority.handlerRef!==descriptor.handlerRef)
      throw new ApiError(403,"agent_capability_denied","The capability is not authorized");
    const scope={tenantId:authority.tenantId,actor:command.actor};
    await authorizeGrowthAgentScope(core,scope);
    for(const permission of descriptor.requiredAuthority)await requireCapability(core.pool,scope.tenantId,permission);
    if (["6", "7", "8", "9"].includes(authority.policyRevision)) return invokeInternalGrowthOperation(core, command);
    if(command.control==="authorize") {
      if(command.operation==="analytics.read") {
        try {await reportingDependencies(core);}
        catch(error){if(error instanceof ApiError&&error.status===503)return {value:{authorized:false,code:"REPORTING_UNAVAILABLE"}};throw error;}
      }
      return {value:{authorized:true}};
    }
    if(command.control==="evidence"){
      const input=command.input as {source?:{id?:unknown;revision?:unknown}};
      const context=await resolveGrowthSourceHandle(core,scope,input?.source?.id);
      const source=await readGrowthRecord(core,scope,context,{});
      if(source.revision!==input.source?.revision)throw new ApiError(409,"agent_source_changed","The source changed");
      return {value:{authorized:true,revision:source.revision}};
    }
    if(["review","commit"].includes(command.control)) {
      const reference=command.review;
      if(command.operation!=="draft.prepare"||!reference||reference.product!=="growth"||reference.taskId!==command.taskId||reference.operationId!==command.operationId)
        throw new ApiError(403,"agent_review_scope_denied","The review is outside this operation");
      const action={version:"1",requestId:command.requestId,operationId:command.operationId,tenantId:scope.tenantId,actor:command.actor,
        taskId:command.taskId,conversationId:command.conversationId,featureId:"content",context:null,contextRevision:null,
        operation:command.control==="commit"?"draft.commit":"draft.reconcile",input:{reviewId:reference.id,payloadDigest:reference.payloadDigest}} as GrowthAgentAction<"draft.commit">|GrowthAgentAction<"draft.reconcile">;
      const result=action.operation==="draft.commit"?await reviews.commit(action):await reviews.reconcile(action);
      return {value:result,review:reviewReference(result.review,command.operationId),...(result.result?{receipt:{id:result.result.recordId,operationId:command.operationId,payloadDigest:result.result.payloadDigest,state:"saved" as const}}:{})};
    }
    if(!validators.get(manifest!.digest)?.get(command.operation)?.(command.input))throw new ApiError(422,"agent_tool_arguments_invalid","Check the tool arguments");
    const input=command.input as Record<string,unknown>;
    if(command.operation==="draft.prepare"){
      if(command.control!=="prepare")throw new ApiError(403,"agent_review_required","The change requires review");
      const result=await reviews.prepare({version:"1",requestId:command.requestId,operationId:command.operationId,tenantId:scope.tenantId,actor:command.actor,
        taskId:command.taskId,conversationId:command.conversationId,featureId:"content",context:null,operation:"draft.prepare",input:command.input as {draft:import("@kasitek-labs/contracts").GrowthDraftProposal}});
      return {value:result,review:reviewReference(result.review,command.operationId)};
    }
    if(command.control!=="invoke")throw new ApiError(403,"agent_capability_control_denied","The capability control is unavailable");
    if(command.operation==="content.list"||command.operation==="campaigns.list") {
      const result=await discoverGrowthRecords(core,scope,command.operation==="content.list"?"content_post":"whatsapp_campaign",input);
      return {value:result,sources:await Promise.all(result.items.map(async item=>({id:await growthSourceHandle(core,scope,item.context),revision:item.revision,title:item.title,route:item.route,
        text:JSON.stringify(item),acquiredAt:new Date().toISOString(),continuation:null}))) };
    }
    const context=parseGrowthAgentContext(command.operation==="workspace.read"?{kind:"workspace",resourceId:scope.tenantId}:
      command.operation==="content.read"?{kind:"content_post",resourceId:input.resourceId}:
      command.operation==="campaigns.read"?{kind:"whatsapp_campaign",resourceId:input.resourceId}:{kind:"analytics_report",resourceId:scope.tenantId,range:input.range,...(input.report===undefined?{}:{report:input.report})});
    const result=await readGrowthRecord(core,scope,context,input);
    return {value:result,sources:await Promise.all(result.sources.map(async source=>({id:await growthSourceHandle(core,scope,result.context),revision:source.revision!,title:source.title,...(source.route?{route:source.route}:{}),
      text:JSON.stringify({context:result.context,data:result.data}),acquiredAt:new Date().toISOString(),continuation:result.continuation}))) };
  });
}
