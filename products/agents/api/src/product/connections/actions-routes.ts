import type { FastifyInstance,FastifyRequest } from "fastify";
import { z } from "zod";
import { selectCatalogBindingsSchema,type CatalogCandidateDTO,type ConnectedCatalogStore } from "../../capabilities/connected-tools/connected-catalog-store";
import type { ActionService } from "../../workflows/report-delivery/actions";
import { connectionProfiles,createConnectionSchema,type ActionScope,type ConnectionStore } from "./connections";
export function registerActionRoutes(app:FastifyInstance,options:{connections:ConnectionStore;actions:ActionService;catalogs?:ConnectedCatalogStore;
 discoverCatalog?(scope:ActionScope,input:{connectionId:string;operationId:string;expectedRevision:number;transport:"native_http"|"mcp_http"}):Promise<CatalogCandidateDTO>;
 resolveScope(request:FastifyRequest):Promise<ActionScope>;resolveTask(request:FastifyRequest):Promise<ActionScope&{taskId:string}>}){
 const base="/api/organizations/:organizationId",params=(request:FastifyRequest)=>request.params as Record<string,string>;
 app.get(`${base}/connections`,async request=>({connections:await options.connections.list(await options.resolveScope(request)),targets:options.connections.targets.map(({id,label,resource})=>({id,label,resource})),profiles:connectionProfiles}));
 app.post(`${base}/connections`,async request=>({connection:await options.connections.create(await options.resolveScope(request),createConnectionSchema.parse(request.body))}));
 app.post(`${base}/connections/:connectionId/rotate`,async request=>({connection:await options.connections.mutate(await options.resolveScope(request),z.uuid().parse(params(request).connectionId),z.strictObject({operationId:z.string(),expectedRevision:z.number(),apiKey:z.string(),expiresAt:z.iso.datetime().optional()}).parse(request.body),"rotate")}));
 app.post(`${base}/connections/:connectionId/revoke`,async request=>({connection:await options.connections.mutate(await options.resolveScope(request),z.uuid().parse(params(request).connectionId),z.strictObject({operationId:z.string(),expectedRevision:z.number()}).parse(request.body),"revoke")}));
 if(options.catalogs){
  const catalogs=options.catalogs;
  const selectionBody=selectCatalogBindingsSchema.omit({connectionId:true,catalogId:true});
  app.get(`${base}/tool-bindings`,async request=>({bindings:await catalogs.listBindings(await options.resolveScope(request))}));
  app.get(`${base}/connections/:connectionId/catalogs`,async request=>({catalogs:await catalogs.listCandidates(await options.resolveScope(request),z.uuid().parse(params(request).connectionId))}));
  app.post(`${base}/connections/:connectionId/catalogs/:catalogId/select`,async request=>({bindings:await catalogs.selectBindings(await options.resolveScope(request),selectCatalogBindingsSchema.parse({...selectionBody.parse(request.body),connectionId:z.uuid().parse(params(request).connectionId),catalogId:z.uuid().parse(params(request).catalogId)}))}));
 }
 if(options.discoverCatalog){const discover=options.discoverCatalog;
  app.post(`${base}/connections/:connectionId/catalogs/discover`,async request=>({catalog:await discover(await options.resolveScope(request),{...z.strictObject({operationId:z.string().min(1).max(128),expectedRevision:z.number().int().positive(),transport:z.enum(["native_http","mcp_http"])}).parse(request.body),connectionId:z.uuid().parse(params(request).connectionId)})}));
 }
 app.get(`${base}/tasks/:taskId/actions`,async request=>{const scope=await options.resolveTask(request);return{actions:await options.actions.listForTask(scope,scope.taskId)};});
 app.post(`${base}/tasks/:taskId/actions/:actionId/decision`,async request=>{const scope=await options.resolveTask(request);return{action:await options.actions.decide(scope,scope.taskId,z.uuid().parse(params(request).actionId),z.strictObject({operationId:z.string(),decision:z.enum(["approve","reject"]),expectedDigest:z.string()}).parse(request.body))};});
}
