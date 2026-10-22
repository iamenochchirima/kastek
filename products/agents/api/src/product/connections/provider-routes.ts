import type { FastifyInstance,FastifyRequest } from "fastify";
import { z } from "zod";
import type { ActionScope } from "../../contracts/connections";
import type { ProviderServices } from "./provider-services";

export function registerProviderRoutes(app:FastifyInstance,options:{providers:ProviderServices;resolveScope(request:FastifyRequest):Promise<ActionScope>;resolveCallbackAccount(request:FastifyRequest):Promise<string>}){
  const base="/api/organizations/:organizationId/providers/:providerId",params=(request:FastifyRequest)=>request.params as Record<string,string>,store=(request:FastifyRequest)=>options.providers.store(params(request).providerId!),id=(request:FastifyRequest)=>z.uuid().parse(params(request).connectionId);
  app.get("/api/organizations/:organizationId/provider-calendars/connections",async request=>({connections:await options.providers.calendars(await options.resolveScope(request))}));
  app.get(`${base}/status`,async request=>{await options.resolveScope(request);return store(request).providerStatus();});
  app.get(`${base}/connections`,async request=>({connections:await store(request).list(await options.resolveScope(request))}));
  app.post(`${base}/connections`,async request=>({connection:await store(request).create(await options.resolveScope(request),request.body)}));
  app.get(`${base}/connections/:connectionId`,async request=>({connection:await store(request).get(await options.resolveScope(request),id(request))}));
  app.post(`${base}/connections/:connectionId/authorize`,async request=>store(request).authorize(await options.resolveScope(request),id(request),request.body??{}));
  app.get(`${base}/connections/:connectionId/calendars`,async request=>store(request).calendars(await options.resolveScope(request),id(request)));
  app.post(`${base}/connections/:connectionId/calendar`,async request=>({connection:await store(request).selectCalendar(await options.resolveScope(request),id(request),request.body)}));
  app.get(`${base}/connections/:connectionId/operations`,async request=>store(request).operationChoices(await options.resolveScope(request),id(request)));
  app.post(`${base}/connections/:connectionId/operations`,async request=>({connection:await store(request).selectOperations(await options.resolveScope(request),id(request),request.body)}));
  app.post(`${base}/connections/:connectionId/sharing`,async request=>({connection:await store(request).sharing(await options.resolveScope(request),id(request),request.body)}));
  app.post(`${base}/connections/:connectionId/disconnect`,async request=>({connection:await store(request).disconnect(await options.resolveScope(request),id(request),request.body)}));
  for(const provider of options.providers.stores.values())app.get(provider.definition.auth.callbackPath,async(request,reply)=>{const index=request.url.indexOf("?"),query=index<0?"":request.url.slice(index);const result=await provider.complete(await options.resolveCallbackAccount(request),query);return reply.redirect(result.redirectTo);});
}
