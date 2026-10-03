import type { FastifyError, FastifyInstance, FastifyRequest } from 'fastify';
import { formatSerdeValidationError } from '@kasitek-labs/server-support/json';

function extractionDetail(
 issues: NonNullable<FastifyError['validation']>,
 context: string | undefined,
 request: FastifyRequest,
): string {
 const root = context === 'querystring' ? request.query
  : context === 'params' ? request.params
  : context === 'headers' ? request.headers
  : request.body;
 return formatSerdeValidationError(issues, context, root);
}

export class TenantError extends Error {
 constructor(public readonly status:number,message:string) { super(message); this.name='TenantError'; }
}
export const unauthorized=()=>new TenantError(401,'unauthorized');
export const forbidden=()=>new TenantError(403,'forbidden');
export const bad=(message:string)=>new TenantError(400,`bad request: ${message}`);
export const missing=(message:string)=>new TenantError(404,`not found: ${message}`);
export const internal=(message:string)=>new TenantError(500,`internal error: ${message}`);
export class RequestExtractionError extends Error {
 constructor(public readonly extractor: 'json'|'query', message='Invalid request') {
  super(`${extractor === 'json' ? 'Json' : 'Query'} deserialize error: ${message}`);
 }
}
export function installErrorHandler(app:FastifyInstance):void {
 app.setErrorHandler((error,request,reply)=>{
  if(error instanceof RequestExtractionError) return reply.code(400).type('text/plain; charset=utf-8').send(error.message);
  const transport=error as {code?:string;validation?:unknown;validationContext?:string};
  if(Array.isArray(transport.validation)) {
   const context=transport.validationContext;
   const detail=extractionDetail(transport.validation as NonNullable<FastifyError['validation']>,context,request);
   return reply.code(400).type('text/plain; charset=utf-8').send(`${context==='querystring'?'Query':'Json'} deserialize error: ${detail}`);
  }
  if(transport.code==='FST_ERR_CTP_BODY_TOO_LARGE') {
   const bytes=request.headers['content-length'];
   return reply.code(413).type('text/plain; charset=utf-8').send(bytes ? `JSON payload (${bytes} bytes) is larger than allowed (limit: ${request.routeOptions.bodyLimit} bytes).` : `JSON payload has exceeded limit (${request.routeOptions.bodyLimit} bytes).`);
  }
  if(transport.code==='FST_ERR_CTP_INVALID_MEDIA_TYPE') return reply.code(400).type('text/plain; charset=utf-8').send('Content type error');
  if(transport.code==='FST_ERR_CTP_INVALID_JSON_BODY'||transport.code==='FST_ERR_CTP_EMPTY_JSON_BODY') return reply.code(400).type('text/plain; charset=utf-8').send('Json deserialize error: Invalid JSON');
  if(error instanceof TenantError) return reply.code(error.status).send({error:error.message});
  const db = error as Error & {severity?:string;code?:string};
  const database=typeof db.severity==='string' && /^[A-Z0-9]{5}$/.test(db.code??'');
  request.log.error({event:'http.request.failed',service:'kasitek-tenants',error_type:error instanceof Error ? error.name : 'UnknownError',...(database?{sqlstate:db.code}:{})},'Tenant request failed');
  return reply.code(500).send({error:database?'database error':'internal error: unexpected operation failure'});
 });
}
