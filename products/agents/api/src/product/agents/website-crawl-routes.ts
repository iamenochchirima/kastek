import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { DocumentRuntime } from "../../capabilities/knowledge/document-runtime";
import type { KnowledgeScope } from "../../capabilities/knowledge/knowledge";
import { PlatformError } from "../../contracts/contracts";
import { WebsiteCrawlStore } from "./website-crawls";

export function registerWebsiteCrawlRoutes(app:FastifyInstance,options:{crawls:WebsiteCrawlStore;runtime?:Pick<DocumentRuntime,"available"|"profile">;resolveScope(request:FastifyRequest):Promise<KnowledgeScope>}){
 const base="/api/organizations/:organizationId/agents/:agentId/website-crawls";
 const params=(request:FastifyRequest)=>z.object({agentId:z.uuid(),crawlId:z.uuid().optional()}).parse(request.params);
 app.get(base,async request=>({crawls:await options.crawls.list(await options.resolveScope(request),params(request).agentId),available:options.crawls.available}));
 app.post(base,async(request,reply)=>{
  const scope=await options.resolveScope(request),agentId=params(request).agentId;
  const crawl=await options.crawls.start(scope,agentId,request.body);
  request.log.info({event:"website.crawl.admitted",organizationId:scope.organizationId,agentId,crawlId:crawl.id,state:crawl.state});
  return reply.code(202).send({crawl});
 });
 app.get(`${base}/:crawlId`,async request=>({crawl:await options.crawls.get(await options.resolveScope(request),params(request).agentId,params(request).crawlId!)}));
 app.post(`${base}/:crawlId/cancel`,async request=>{
  const scope=await options.resolveScope(request),{agentId,crawlId}=params(request);
  const crawl=await options.crawls.cancel(scope,agentId,crawlId!);
  request.log.info({event:"website.crawl.cancelled",organizationId:scope.organizationId,agentId,crawlId: crawl.id,state:crawl.state});
  return{crawl};
 });
 app.post(`${base}/:crawlId/import`,async(request,reply)=>{
  const scope=await options.resolveScope(request),{agentId,crawlId}=params(request);
  await options.crawls.get(scope,agentId,crawlId!);
  if(!options.runtime || !await options.runtime.available())throw new PlatformError("DOCUMENT_RUNTIME_UNAVAILABLE",503,"Document processing is unavailable");
  const{profileRelease}=await options.runtime.profile();
  return reply.code(202).send(await options.crawls.import(scope,agentId,crawlId!,request.body,profileRelease));
 });
}
