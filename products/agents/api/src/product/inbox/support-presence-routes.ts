import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";
import { z } from "zod";
import type { InboxScope } from "./inbox-store";
import { readSupportPresence, renewSupportPresence, setSupportPresence } from "./support-presence";

export function registerSupportPresenceRoutes(app:FastifyInstance,pool:Pool,resolveScope:(request:FastifyRequest)=>Promise<InboxScope>) {
  const base="/api/organizations/:organizationId/inbox-presence";
  app.get(base,async request=>{const scope=await resolveScope(request);return readSupportPresence(pool,scope.organizationId,scope.accountId);});
  app.post(base,async request=>{const scope=await resolveScope(request),input=z.strictObject({state:z.enum(["available","away"])}).parse(request.body);return setSupportPresence(pool,scope.organizationId,scope.accountId,input.state);});
  app.post(`${base}/renew`,async request=>{const scope=await resolveScope(request),input=z.strictObject({leaseId:z.uuid()}).parse(request.body);return renewSupportPresence(pool,scope.organizationId,scope.accountId,input.leaseId);});
}
