import type { FastifyInstance,FastifyRequest } from "fastify";
import { z } from "zod";
import type { ActionScope } from "../../contracts/connections";
import type { BookingService } from "./bookings";

export function registerBookingRoutes(app:FastifyInstance,options:{bookings:BookingService;resolveScope(request:FastifyRequest):Promise<ActionScope>;resolveTask(request:FastifyRequest):Promise<{taskId:string;principal:unknown}>}) {
  const base="/api/organizations/:organizationId",params=(request:FastifyRequest)=>request.params as Record<string,string>;
  app.get(`${base}/agents/:agentId/booking-policies`,async request=>({policies:await options.bookings.listPolicies(await options.resolveScope(request),z.uuid().parse(params(request).agentId))}));
  app.post(`${base}/agents/:agentId/booking-policies`,async request=>({policy:await options.bookings.createPolicy(await options.resolveScope(request),z.uuid().parse(params(request).agentId),request.body)}));
  app.post(`${base}/agents/:agentId/booking-policies/:policyId/withdraw`,async request=>options.bookings.withdrawPolicy(await options.resolveScope(request),z.uuid().parse(params(request).agentId),z.uuid().parse(params(request).policyId)));
  app.get(`${base}/tasks/:taskId/bookings`,async request=>{const scope=await options.resolveTask(request);return {bookings:await options.bookings.listForPrincipal(scope.taskId,scope.principal)};});
  app.post(`${base}/tasks/:taskId/bookings/:bookingId/reconcile`,async request=>{const scope=await options.resolveTask(request);return {booking:await options.bookings.reconcile(scope.taskId,scope.principal,z.uuid().parse(params(request).bookingId))};});
  app.post(`${base}/tasks/:taskId/bookings/:bookingId/decision`,async request=>{const scope=await options.resolveTask(request);return {booking:await options.bookings.decide(scope.taskId,scope.principal,z.uuid().parse(params(request).bookingId),z.strictObject({decision:z.enum(["approve","reject"]),requestDigest:z.string().regex(/^[a-f0-9]{64}$/)}).parse(request.body))};});
}
