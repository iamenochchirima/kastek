import type { FastifyInstance,FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AutomationService,automationInputSchema,type AutomationScope } from './automations';
export function registerAutomationRoutes(app:FastifyInstance,service:AutomationService,scope:(request:FastifyRequest)=>Promise<AutomationScope>) {
 const base='/api/organizations/:organizationId/automations',id=(r:FastifyRequest)=>z.uuid().parse((r.params as {automationId:string}).automationId);
 const mutation=z.strictObject({operationId:z.uuid(),expectedRevision:z.number().int().positive()});
 app.get(base,async r=>({automations:await service.list(await scope(r))}));
 app.post(base,async(r,reply)=>{const body=automationInputSchema.extend({operationId:z.uuid()}).parse(r.body);const {operationId,...input}=body;return reply.code(201).send({automation:await service.create(await scope(r),operationId,input)});});
 app.patch(`${base}/:automationId`,async r=>{const {operationId,expectedRevision,...input}=automationInputSchema.extend(mutation.shape).parse(r.body);return {automation:await service.change(await scope(r),id(r),operationId,expectedRevision,'edit',input)};});
 for(const kind of ['pause','resume','revoke'] as const)app.post(`${base}/:automationId/${kind}`,async r=>{const body=mutation.parse(r.body);return {automation:await service.change(await scope(r),id(r),body.operationId,body.expectedRevision,kind)};});
 app.get(`${base}/:automationId/occurrences`,async r=>({occurrences:await service.occurrences(await scope(r),id(r))}));
 app.post(`${base}/:automationId/event-key`,async r=>{const body=mutation.parse(r.body);return service.rotateEventKey(await scope(r),id(r),body.operationId,body.expectedRevision);});
 app.post('/api/automation-events/:automationId',{bodyLimit:12_000},async(r,reply)=>{const body=z.strictObject({eventId:z.string().min(1).max(128),payload:z.unknown()}).parse(r.body);return reply.code(202).send({occurrence:await service.event(id(r),r.headers.authorization?.replace(/^Bearer /,'')??'',body.eventId,body.payload)});});
}
