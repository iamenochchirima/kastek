import Fastify, {type FastifyInstance} from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import { environmentAllowsLoopbackOrigins, isLoopbackOrigin } from '@kasitek/server-support/config';
import type {TenantContext} from './context.js';
import {installErrorHandler} from './error.js';
import {apiJson,parseSerdeValueJson} from './json.js';
import {installHttpObservability} from './observability/http.js';

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
  logger:{level:context.config.env.LOG_LEVEL??'info',redact:['req.headers.authorization','req.headers.cookie','res.headers["set-cookie"]']},disableRequestLogging:true});
 installHttpObservability(app);installErrorHandler(app);
 app.setReplySerializer(apiJson);
 const safeJson=app.getDefaultJsonParser('error','error');
 app.removeContentTypeParser('application/json');
 app.addContentTypeParser('application/json',{parseAs:'string'},(request,body,done)=>{
  const text=typeof body==='string'?body:body.toString('utf8');
  safeJson(request,text,(error,value)=>{
   if(error)return done(error);
   try {
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
 const config=context.config;
 await app.register(cors,{origin:(origin,done)=>done(null,!!origin&&(config.allowed_origins.includes(origin)||
  (environmentAllowsLoopbackOrigins(config.environment)&&isLoopbackOrigin(origin))||
  (!!config.platform_base_domain&&originMatchesPlatformDomain(origin,config.platform_base_domain)))),
  credentials:config.cors_allow_credentials,methods:['GET','POST','PATCH','PUT','DELETE','OPTIONS'],
  allowedHeaders:['Content-Type','Authorization','x-admin-secret'],maxAge:3600});
 const health=()=>({status:'ok',service:'tenant-server',timestamp:new Date()});
 app.get('/',health);app.get('/health',health);
 for(const register of registrars)await register(app,context);
 return app;
}
