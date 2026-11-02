import { adminRawBodies, verifiedAdminActors } from "./admin-authority.js";
import Fastify, {LogController,type FastifyInstance} from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import {Readable} from 'node:stream';
import cors from '@fastify/cors';
import { environmentAllowsLoopbackOrigins, isLoopbackOrigin } from '@kasitek-labs/server-support/config';
import { redactTelemetryLogArguments } from '@kasitek-labs/server-support/telemetry';
import { assertNoDuplicateSerdeStructFields, assertSerdeUnicodeEscapes, formatSerdeJsonSyntaxError } from '@kasitek-labs/server-support/json';
import type {TenantContext} from './context.js';
import {installErrorHandler,RequestExtractionError} from './error.js';
import {apiJson,parseSerdeValueJson} from './json.js';
import {installHttpObservability} from './observability/http.js';

const bodylessRequest=(method:string,url:string)=>method==='DELETE'||(method==='POST'&&(/\/(?:logout|logout-all)$/.test(url)||/\/domains\/:domain_id\/(verify|primary)$/.test(url)));
const reportQueryBodySchema={type:'object',properties:{
 range_start:{},range_end:{},timezone:{},interval:{},metrics:{type:'array',items:{}},metric_set:{},
 breakdowns:{type:'array',items:{}},filters:{type:'object',additionalProperties:{type:'array',items:{}}},
 include_descendants:{},comparison:{type:'object',properties:{kind:{}}},
}};
export type RouteRegistrar=(app:FastifyInstance,context:TenantContext)=>void|Promise<void>;
/** Preserve main.rs's platform-domain matching, including its source host extraction. */
export function originMatchesPlatformDomain(origin:string,base:string):boolean {
 const match=/^(http|https):\/\/(.*)$/.exec(origin);
 if(!match)return false;
 const host=match[2]!.split('/')[0]!.split(':')[0]!.toLowerCase();
 const normalized=base.trim().replace(/^\.+|\.+$/g,'').toLowerCase();
 return !!host&&!!normalized&&(host===normalized||host.endsWith(`.${normalized}`));
}
export async function buildApp(context:TenantContext,registrars:RouteRegistrar[]=[]):Promise<FastifyInstance> {
 const app=Fastify({bodyLimit:2097152,exposeHeadRoutes:false,
  ajv:{customOptions:{coerceTypes:false,removeAdditional:false,useDefaults:false}},
  logger:{level:context.config.env.LOG_LEVEL??'info',redact:['req.headers["x-kasitek-admin-authority"]','req.headers.authorization','req.headers.cookie','res.headers["set-cookie"]'],hooks:{logMethod(args,method){return method.apply(this,redactTelemetryLogArguments(args));}}},logController:new LogController({disableRequestLogging:true})});
 installHttpObservability(app);installErrorHandler(app);
 app.setReplySerializer(apiJson);
 app.addHook('preParsing',async(request,_reply,payload)=>{
  if(!bodylessRequest(request.method,request.routeOptions.url??''))return payload;
  // These source handlers have no body extractor: drain bytes without decoding or buffering.
  payload.resume();
  request.headers['content-length']='0';
  request.headers['content-type']='application/json';
  return Readable.from([]);
 });
 const safeJson=app.getDefaultJsonParser('error','error');
 app.removeContentTypeParser('application/json');
 app.addContentTypeParser(/^application\/(?:[a-z0-9.-]+\+)?json$/i,{parseAs:'string'},(request,body,done)=>{
  if(bodylessRequest(request.method,request.routeOptions.url??''))return done(null,undefined);
  const text=typeof body==='string'?body:body.toString('utf8');
  if (request.url.startsWith('/api/admin/')) adminRawBodies.set(request, text);
  safeJson(request,text,(error,value)=>{
   if(error){
    try { JSON.parse(text); }
    catch(syntaxError){return done(new RequestExtractionError('json',formatSerdeJsonSyntaxError(text,syntaxError)));}
    return done(error);
   }
   try { assertSerdeUnicodeEscapes(text); }
   catch(syntaxError){return done(new RequestExtractionError('json',formatSerdeJsonSyntaxError(text,syntaxError)));}
   try {
    // This source handler accepts arbitrary serde_json::Value, not a typed DTO.
    const valueBody=request.method==='PATCH'&&request.routeOptions.url==='/api/admin/workspaces/:id';
    if(!valueBody){
     const route=request.routeOptions.url??'';
     const bodySchema=request.routeOptions.schema?.body??(
      route==='/api/analytics/query'||route==='/api/client/analytics/query'?reportQueryBodySchema:undefined
     );
     try { assertNoDuplicateSerdeStructFields(text,bodySchema); }
     catch(syntaxError){return done(new RequestExtractionError('json',formatSerdeJsonSyntaxError(text,syntaxError)));}
    }
    // Source update_workspace takes Json<Value>; scopes inside create_api_key is also Value.
    if(request.method==='PATCH'&&request.routeOptions.url==='/api/admin/workspaces/:id')value=parseSerdeValueJson(text);
    else if(request.method==='POST'&&request.routeOptions.url==='/api/admin/workspaces/:id/api-keys'){
     const serde=parseSerdeValueJson(text) as Record<string,unknown>;
     if(value&&typeof value==='object'&&!Array.isArray(value)&&Object.hasOwn(serde,'scopes'))(value as Record<string,unknown>).scopes=serde.scopes;
    }
    done(null,value);
   } catch(error){done(error instanceof Error?error:new Error('Invalid JSON'));}
  });
 });
 app.setNotFoundHandler((_request,reply)=>reply.code(404).send());
 app.addHook('onRequest',async(request,reply)=>{if(request.is404)return reply.code(404).send();});
 await app.register(cookie);
 await app.register(formbody);
 const config=context.config;
 await app.register(cors,{origin:(origin,done)=>done(null,!!origin&&(config.allowed_origins.includes(origin)||
  (environmentAllowsLoopbackOrigins(config.environment)&&isLoopbackOrigin(origin))||
  (!!config.platform_base_domain&&originMatchesPlatformDomain(origin,config.platform_base_domain)))),
  credentials:config.cors_allow_credentials,methods:['GET','POST','PATCH','PUT','DELETE','OPTIONS'],
  allowedHeaders:['Content-Type','Authorization','x-admin-secret'],maxAge:3600});
 app.addHook('onResponse', async (request, reply) => {
  const actor = verifiedAdminActors.get(request);
  if (actor && (!['GET','HEAD','OPTIONS'].includes(request.method) || /export/.test(request.routeOptions.url ?? ''))) request.log.info({event:'admin.action', service:'agency', actor_id:actor.id, actor_role:actor.role, capability:actor.capability, request_id:request.id, route:request.routeOptions.url, method:request.method, status_code:reply.statusCode}, 'Admin action');
 });
 const health=()=>({status:'ok',service:'tenant-server',timestamp:new Date()});
 app.get('/',health);app.get('/health',health);
 for(const register of registrars)await register(app,context);
 return app;
}
