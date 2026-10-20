import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ActionScope } from "../../contracts/connections";
import { RemoteConnectionStore } from "./remote-connections";

export function registerRemoteConnectionRoutes(app: FastifyInstance,options:{store:RemoteConnectionStore;
  resolveScope(request:FastifyRequest):Promise<ActionScope>;accountId(request:FastifyRequest):Promise<string>}) {
  const base="/api/organizations/:organizationId/remote-connections";
  const id=(request:FastifyRequest)=>z.uuid().parse((request.params as Record<string,string>).connectionId);
  const generation=(request:FastifyRequest)=>z.strictObject({generation:z.number().int().positive()}).parse(request.body).generation;
  app.get(base,async request=>({connections:await options.store.list(await options.resolveScope(request))}));
  app.post(base,async request=>({connection:await options.store.create(await options.resolveScope(request),request.body)}));
  app.get(`${base}/:connectionId`,async request=>({connection:await options.store.get(await options.resolveScope(request),id(request))}));
  app.post(`${base}/:connectionId/authorize`,async request=>options.store.beginAuthorization(await options.resolveScope(request),id(request),generation(request)));
  app.post(`${base}/:connectionId/discover`,async request=>options.store.discover(await options.resolveScope(request),id(request),generation(request)));
  app.post(`${base}/:connectionId/disconnect`,async request=>options.store.disconnect(await options.resolveScope(request),id(request),generation(request)));
  app.get("/api/connections/oauth/callback",async(request,reply)=>{
    const query=z.object({state:z.string().min(1).max(128),code:z.string().min(1).max(4096).optional(),iss:z.string().max(2048).optional(),error:z.string().max(128).optional()}).parse(request.query);
    const scope=await options.store.callbackScope(await options.accountId(request),query.state);
    const connection=await options.store.completeAuthorization(scope,query.state,query.error?undefined:query.code,query.iss);
    return reply.redirect(`/app/connections?setup=${encodeURIComponent(connection.id)}`);
  });
}
