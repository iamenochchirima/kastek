import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { DocumentRuntime } from "../../platform/knowledge/document-runtime";
import type { KnowledgeScope } from "../../platform/knowledge/knowledge";
import { PlatformError } from "../../contracts/contracts";
import { WebsiteCrawlStore } from "./website-crawls";

// Shared by authenticated product interfaces. The store rechecks membership and
// agent access for each operation; callers must supply a verified principal.
export function websiteCrawlOperations(options: { crawls: WebsiteCrawlStore; runtime?: Pick<DocumentRuntime, "available" | "profile"> }) {
 return {
  list: async (scope: KnowledgeScope, agentId: string) => ({ crawls: await options.crawls.list(scope, agentId), available: options.crawls.available }),
  start: (scope: KnowledgeScope, agentId: string, input: unknown) => options.crawls.start(scope, agentId, input),
  get: (scope: KnowledgeScope, agentId: string, crawlId: string) => options.crawls.get(scope, agentId, crawlId),
  cancel: (scope: KnowledgeScope, agentId: string, crawlId: string) => options.crawls.cancel(scope, agentId, crawlId),
  import: async (scope: KnowledgeScope, agentId: string, crawlId: string, input: unknown) => {
   const profileRelease=options.runtime && await options.runtime.available() ? (await options.runtime.profile()).profileRelease : undefined;
   return options.crawls.import(scope,agentId,crawlId,input,profileRelease);
  },
 };
}

export function registerWebsiteCrawlRoutes(app:FastifyInstance,options:{crawls:WebsiteCrawlStore;runtime?:Pick<DocumentRuntime,"available"|"profile">;resolveScope(request:FastifyRequest):Promise<KnowledgeScope>}){
 const operations=websiteCrawlOperations(options);
 const base="/api/organizations/:organizationId/agents/:agentId/website-crawls";
 const params=(request:FastifyRequest)=>z.object({agentId:z.uuid(),crawlId:z.uuid().optional()}).parse(request.params);
 app.get(base,async request=>operations.list(await options.resolveScope(request),params(request).agentId));
 app.post(base,async(request,reply)=>{
  const scope=await options.resolveScope(request),agentId=params(request).agentId;
  const crawl=await operations.start(scope,agentId,request.body);
  request.log.info({event:"website.crawl.admitted",organizationId:scope.organizationId,agentId,crawlId:crawl.id,state:crawl.state});
  return reply.code(202).send({crawl});
 });
 app.get(`${base}/:crawlId`,async request=>({crawl:await operations.get(await options.resolveScope(request),params(request).agentId,params(request).crawlId!)}));
 app.post(`${base}/:crawlId/cancel`,async request=>{
  const scope=await options.resolveScope(request),{agentId,crawlId}=params(request);
  const crawl=await operations.cancel(scope,agentId,crawlId!);
  request.log.info({event:"website.crawl.cancelled",organizationId:scope.organizationId,agentId,crawlId: crawl.id,state:crawl.state});
  return{crawl};
 });
 app.post(`${base}/:crawlId/import`,async(request,reply)=>{
  const scope=await options.resolveScope(request),{agentId,crawlId}=params(request);
  return reply.code(202).send(await operations.import(scope,agentId,crawlId!,request.body));
 });
}
