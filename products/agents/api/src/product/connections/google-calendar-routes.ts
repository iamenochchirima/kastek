import { googleCalendarConnector } from "../../adapters/providers/connector-registry";
import type { FastifyInstance,FastifyRequest } from "fastify";
import { z } from "zod";
import type { ActionScope } from "../../contracts/connections";
import type { GoogleCalendarConnectionStore } from "./google-calendar-connections";
export function registerGoogleCalendarRoutes(app:FastifyInstance,options:{store:GoogleCalendarConnectionStore;resolveScope(request:FastifyRequest):Promise<ActionScope>;resolveCallbackAccount(request:FastifyRequest):Promise<string>}){
 const base="/api/organizations/:organizationId/google-calendar",id=(request:FastifyRequest)=>z.uuid().parse((request.params as Record<string,string>).connectionId);
 app.get(`${base}/status`,async request=>{await options.resolveScope(request);return options.store.providerStatus();});
 app.get(`${base}/connections`,async request=>({connections:await options.store.list(await options.resolveScope(request))}));
 app.post(`${base}/connections`,async request=>({connection:await options.store.create(await options.resolveScope(request),request.body)}));
 app.get(`${base}/connections/:connectionId`,async request=>({connection:await options.store.get(await options.resolveScope(request),id(request))}));
 app.post(`${base}/connections/:connectionId/authorize`,async request=>options.store.authorize(await options.resolveScope(request),id(request)));
 app.get(`${base}/connections/:connectionId/calendars`,async request=>options.store.calendars(await options.resolveScope(request),id(request)));
 app.post(`${base}/connections/:connectionId/calendar`,async request=>({connection:await options.store.selectCalendar(await options.resolveScope(request),id(request),request.body)}));
 app.post(`${base}/connections/:connectionId/sharing`,async request=>({connection:await options.store.sharing(await options.resolveScope(request),id(request),request.body)}));
 app.post(`${base}/connections/:connectionId/disconnect`,async request=>({connection:await options.store.disconnect(await options.resolveScope(request),id(request),request.body)}));
 app.get(googleCalendarConnector.auth.callbackPath,async(request,reply)=>{const index=request.url.indexOf("?"),query=index<0?"":request.url.slice(index);const result=await options.store.complete(await options.resolveCallbackAccount(request),query);return reply.redirect(result.redirectTo);});
}
