import type {FastifyInstance,FastifyRequest} from "fastify";
import {z} from "zod";
import type {ConnectionStore,ActionScope} from "./connections";
import type {ActionService} from "./actions";
export function registerActionRoutes(app:FastifyInstance,options:{connections:ConnectionStore;actions:ActionService;resolveScope(request:FastifyRequest):Promise<ActionScope>;resolveTask(request:FastifyRequest):Promise<ActionScope&{taskId:string}>}){
 const base="/api/organizations/:organizationId",params=(request:FastifyRequest)=>request.params as Record<string,string>;
 app.get(`${base}/connections`,async request=>({connections:await options.connections.list(await options.resolveScope(request)),targets:options.connections.targets.map(({id,label,resource})=>({id,label,resource}))}));
 app.post(`${base}/connections`,async request=>({connection:await options.connections.create(await options.resolveScope(request),z.strictObject({operationId:z.string(),name:z.string(),targetId:z.string(),apiKey:z.string(),expiresAt:z.iso.datetime().optional()}).parse(request.body))}));
 app.post(`${base}/connections/:connectionId/rotate`,async request=>({connection:await options.connections.mutate(await options.resolveScope(request),z.uuid().parse(params(request).connectionId),z.strictObject({operationId:z.string(),expectedRevision:z.number(),apiKey:z.string(),expiresAt:z.iso.datetime().optional()}).parse(request.body),"rotate")}));
 app.post(`${base}/connections/:connectionId/revoke`,async request=>({connection:await options.connections.mutate(await options.resolveScope(request),z.uuid().parse(params(request).connectionId),z.strictObject({operationId:z.string(),expectedRevision:z.number()}).parse(request.body),"revoke")}));
 app.get(`${base}/tasks/:taskId/actions`,async request=>{const scope=await options.resolveTask(request);return{actions:await options.actions.listForTask(scope,scope.taskId)};});
 app.post(`${base}/tasks/:taskId/actions/:actionId/decision`,async request=>{const scope=await options.resolveTask(request);return{action:await options.actions.decide(scope,scope.taskId,z.uuid().parse(params(request).actionId),z.strictObject({operationId:z.string(),decision:z.enum(["approve","reject"]),expectedDigest:z.string()}).parse(request.body))};});
}
