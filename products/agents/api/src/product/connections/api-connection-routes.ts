import type { FastifyInstance,FastifyRequest } from "fastify";
import { z } from "zod";
import type { ActionScope } from "../../contracts/connections";
import { ApiConnectionStore } from "./api-connections";

export function registerApiConnectionRoutes(app:FastifyInstance,options:{store:ApiConnectionStore;resolveScope(request:FastifyRequest):Promise<ActionScope>}) {
  const base="/api/organizations/:organizationId/api-connections";
  const id=(request:FastifyRequest)=>z.uuid().parse((request.params as Record<string,string>).connectionId);
  app.get(base,async request=>({connections:await options.store.list(await options.resolveScope(request))}));
  app.post(`${base}/preview`,{bodyLimit:800000},async request=>({preview:await options.store.preview(await options.resolveScope(request),request.body)}));
  app.post(base,{bodyLimit:900000},async request=>({connection:await options.store.create(await options.resolveScope(request),request.body)}));
  app.get(`${base}/:connectionId`,async request=>({connection:await options.store.get(await options.resolveScope(request),id(request))}));
  app.get(`${base}/:connectionId/operations`,async request=>({operations:await options.store.operations(await options.resolveScope(request),id(request))}));
  app.post(`${base}/:connectionId/operations`,async request=>options.store.select(await options.resolveScope(request),id(request),request.body));
  app.post(`${base}/:connectionId/credentials`,{bodyLimit:70000},async request=>({connection:await options.store.updateCredentials(await options.resolveScope(request),id(request),request.body)}));
  app.post(`${base}/:connectionId/probe`,async request=>options.store.probe(await options.resolveScope(request),id(request),request.body));
  app.post(`${base}/:connectionId/disconnect`,async request=>options.store.disconnect(await options.resolveScope(request),id(request),z.strictObject({expectedGeneration:z.number().int().positive()}).parse(request.body).expectedGeneration));
}
