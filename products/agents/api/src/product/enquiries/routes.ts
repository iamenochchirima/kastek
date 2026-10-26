import type {FastifyInstance,FastifyRequest} from "fastify";
import {z} from "zod";
import type {ActionScope} from "../../contracts/connections";
import {EnquiryStore} from "../../capabilities/enquiries/enquiries";
export function registerEnquiryRoutes(app:FastifyInstance,options:{store:EnquiryStore;resolveScope(request:FastifyRequest):Promise<ActionScope>;resolveTask(request:FastifyRequest):Promise<{taskId:string;principal:unknown}>}){
 const base="/api/organizations/:organizationId",params=(request:FastifyRequest)=>request.params as Record<string,string>;
 app.get(`${base}/enquiries`,async request=>({enquiries:await options.store.listStaff(await options.resolveScope(request),z.object({agentId:z.uuid().optional(),conversationId:z.uuid().optional(),before:z.iso.datetime({offset:true}).optional(),limit:z.coerce.number().int().min(1).max(100).default(50)}).parse(request.query))}));
 app.get(`${base}/enquiries/:enquiryId`,async request=>({enquiry:await options.store.readStaff(await options.resolveScope(request),z.uuid().parse(params(request).enquiryId))}));
 app.get(`${base}/tasks/:taskId/enquiries`,async request=>{const scope=await options.resolveTask(request);return {enquiries:await options.store.listForPrincipal(scope.taskId,scope.principal)};});
 app.post(`${base}/tasks/:taskId/enquiries/:enquiryId/decision`,async request=>{const scope=await options.resolveTask(request);return {enquiry:await options.store.decide(scope.taskId,scope.principal,z.uuid().parse(params(request).enquiryId),z.strictObject({decision:z.enum(["approve","reject"]),requestDigest:z.string().regex(/^[a-f0-9]{64}$/)}).parse(request.body))};});
}
