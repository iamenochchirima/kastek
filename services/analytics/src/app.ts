import Fastify, {LogController} from 'fastify';
import type {FastifyBodyParser,FastifyInstance,FastifyRequest,FastifyServerOptions} from 'fastify';
import {randomUUID} from 'node:crypto';
import type {AnalyticsContext} from './context.js';
import type {ProcessKind} from './contracts.js';
import {MetricsAccess} from './metrics.js';
import {registerHealthRoutes} from './health.js';
import {RequestExtractionError,errorType} from './error.js';
import {isSafeCorrelationId,redactTelemetryLogArguments} from '@kasitek-labs/server-support/telemetry';
import {assertNoDuplicateSerdeStructFields,formatSerdeJsonSyntaxError} from '@kasitek-labs/server-support/json';
import {apiJson,parseSerdeValueJson} from './json.js';
import {MAX_BATCH_BYTES,registerIngestionRoutes} from './ingestion.js';
import {registerReconciliationRoutes} from './reconciliation.js';
import {registerMaintenanceRoutes} from './maintenance.js';
import {registerScopeResolutionRoutes} from './scope-resolution.js';
import {registerRolloutRoutes} from './rollout.js';
import {registerReportingRoutes} from './reporting.js';
import type {Pool} from 'pg';
import {SERVICE_NAME} from './contracts.js';
import {installHttpObservability} from './http-observability.js';

export async function buildApp(context:AnalyticsContext,process:ProcessKind='analytics-api',options:FastifyServerOptions={}):Promise<FastifyInstance>{
 const app=Fastify({
  bodyLimit:MAX_BATCH_BYTES,
  requestIdHeader:'x-correlation-id',
  genReqId(request){const supplied=request.headers['x-correlation-id'];return typeof supplied==='string'&&isSafeCorrelationId(supplied)?supplied:randomUUID();},
  logger:{level:logLevel(context.config.log_filter),redact:['req.headers.authorization','req.headers.cookie','res.headers["set-cookie"]'],hooks:{logMethod(args,method){return method.apply(this,redactTelemetryLogArguments(args));}},serializers:{req(request){return {method:request.method,url:request.url.split(/[?#]/,1)[0]};}}},
  logController:new LogController({disableRequestLogging:true}),
  ...options,
 });
 app.setReplySerializer(apiJson);
 app.removeContentTypeParser('application/json');
 const jsonRoutes=new Set(['/internal/ingest/v1/batch','/internal/reconciliation/v1/summary','/internal/rollouts/v1/controls','/v1/reports/query']);
 const stringField={type:'string'};
 const jsonObject=(properties:Record<string,unknown>)=>({type:'object',properties});
 const recordSchema=jsonObject({
  producer_id:stringField,source_stream_key:stringField,source_sequence:{},record_category:stringField,
  record_id:stringField,contract_name:stringField,schema_version:{},scope_kind:stringField,
  scope_external_id:stringField,payload_hash:stringField,envelope:{},
 });
 const typedJsonBodySchemas:Record<string,unknown>={
  '/internal/ingest/v1/batch':jsonObject({records:{type:'array',items:recordSchema},backfill_job_id:stringField}),
  '/internal/reconciliation/v1/summary':jsonObject({
   reconciliation_run_id:stringField,reconciliation_work_id:{},producer_id:stringField,source_domain:stringField,
   source_stream_key:stringField,scope_kind:stringField,scope_external_id:stringField,
   source_highest_outbox_sequence:{},source_highest_delivered_sequence:{},authoritative_count:{},authoritative_checksum:stringField,
  }),
  '/internal/rollouts/v1/controls':jsonObject({
   control_key:stringField,control_kind:stringField,
   target:jsonObject({kind:stringField,key:stringField}),enabled:{},percentage_basis_points:{},reason:stringField,
   issue_ref:stringField,expires_at:stringField,remove:{},
  }),
  '/v1/reports/query':jsonObject({
   reporting_scope_id:{},range_start:stringField,range_end:stringField,timezone:stringField,interval:stringField,
   metrics:{type:'array',items:stringField},metric_set:stringField,breakdowns:{type:'array',items:stringField},
   filters:{type:'object',additionalProperties:{type:'array',items:stringField}},include_descendants:{},
   comparison:jsonObject({kind:stringField}),
  }),
 };
 const needsJson=(request:Pick<FastifyRequest,'method'|'routeOptions'>)=>request.method==='POST'&&jsonRoutes.has(request.routeOptions.url??'');
 const parseRequestBody:FastifyBodyParser<string|Buffer>=(request,body,done)=>{
  const hasJsonExtractor=needsJson(request);
  if(!hasJsonExtractor){done(null,body);return;}
  let text:string;
  try{text=typeof body==='string'?body:new TextDecoder('utf-8',{fatal:true}).decode(body);}
  catch{done(new RequestExtractionError('json'));return;}
  try{
   assertNoDuplicateSerdeStructFields(text,typedJsonBodySchemas[request.routeOptions.url??'']);
   done(null,parseSerdeValueJson(text));
  }
  catch(error){done(new RequestExtractionError(formatSerdeJsonSyntaxError(text,error)));}
 };
 app.addContentTypeParser(/^application\/(?:[a-z0-9.-]+\+)?json$/i,{parseAs:'string'},parseRequestBody);
 app.addContentTypeParser('*',{parseAs:'string'},(request,body,done)=>{
  const hasJsonExtractor=needsJson(request);
  if(hasJsonExtractor)return done(new RequestExtractionError('content type'));
  return done(null,body);
 });
 app.setErrorHandler((error,request,reply)=>{
  if(error instanceof RequestExtractionError){const label=error.kind==='query'?'Query deserialize error':'Json deserialize error';return reply.code(400).type('text/plain; charset=utf-8').send(`${label}: ${error.message}`);}
  if((error as {statusCode?:number}).statusCode===413)return reply.code(413).type('text/plain; charset=utf-8').send('JSON payload is too large');
  request.log.error({event:'request.failed',error_type:errorType(error)},'analytics request failed');
  return reply.code(500).send({error:'internal_error'});
 });
 installHttpObservability(app);
 const access=new MetricsAccess(context.config.metrics_token);
 app.get('/internal/metrics',async(request,reply)=>{
  const authorized=access.authorized(request.headers.authorization);
  context.metrics.recordScrape(authorized);
  if(!authorized)return reply.code(401).header('www-authenticate','Bearer').send();
  return reply.type('text/plain; version=0.0.4; charset=utf-8').send(context.metrics.render(process));
 });
 registerHealthRoutes(app,context.pool,process,context.metrics);
 if(process==='analytics-api'){
  registerIngestionRoutes(app,context);
  registerReconciliationRoutes(app,context);
  registerMaintenanceRoutes(app,context);
  registerScopeResolutionRoutes(app,context);
  registerRolloutRoutes(app,context);
  await registerReportingRoutes(app,context);
 }
 app.addHook('onClose',async()=>{context.metrics.log('info','service.shutdown',{process});});
 return app;
}

export function safeProcessName(process:ProcessKind){return `${SERVICE_NAME}-${process}`;}

function logLevel(filter:string):'trace'|'debug'|'info'|'warn'|'error'|'fatal'|'silent'{
 const levels=filter.split(',').map(part=>part.trim().split(/\s*=/).at(-1)?.split(/::/).at(-1)?.toLowerCase()).filter(Boolean);
 const selected=levels.reverse().find(level=>['trace','debug','info','warn','error','fatal','silent'].includes(level!));
 return (selected==='trace'?'debug':selected??'info') as 'trace'|'debug'|'info'|'warn'|'error'|'fatal'|'silent';
}
