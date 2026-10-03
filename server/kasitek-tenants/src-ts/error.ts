import type { FastifyError, FastifyInstance, FastifyRequest } from 'fastify';

type ValidationIssue = NonNullable<FastifyError['validation']>[number];

function pointerParts(instancePath: string | undefined): string[] {
 if (!instancePath) return [];
 return instancePath.split('/').slice(1).map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function valueAtPath(value: unknown, path: readonly string[]): unknown {
 let current = value;
 for (const part of path) {
  if (current === null || typeof current !== 'object') return undefined;
  current = (current as Record<string, unknown>)[part];
 }
 return current;
}

function actualType(value: unknown): string {
 if (value === undefined) return 'a missing value';
 if (value === null) return 'null';
 if (Array.isArray(value)) return 'a sequence';
 if (typeof value === 'string') return 'a string';
 if (typeof value === 'boolean') return 'a boolean';
 if (typeof value === 'bigint') return 'an integer';
 if (typeof value === 'number') return Number.isInteger(value) ? 'an integer' : 'a number';
 return 'a map';
}

function expectedType(value: unknown): string {
 const labels: Record<string, string> = {
  array: 'a sequence', boolean: 'a boolean', integer: 'an integer',
  null: 'null', number: 'a number', object: 'a map', string: 'a string',
 };
 if (Array.isArray(value)) return value.map((item) => labels[String(item)] ?? String(item)).join(' or ');
 return labels[String(value)] ?? 'a valid value';
}

function issueLocation(context: string | undefined, parts: readonly string[]): string {
 const root = context === 'querystring' ? 'query' : context ?? 'request';
 return parts.length ? ` at \`${root}.${parts.join('.')}\`` : '';
}

function extractionDetail(
 issues: NonNullable<FastifyError['validation']>,
 context: string | undefined,
 request: FastifyRequest,
): string {
 const root = context === 'querystring' ? request.query
  : context === 'params' ? request.params
  : context === 'headers' ? request.headers
  : request.body;
 const issue = issues[0] as ValidationIssue | undefined;
 if (!issue) return 'Invalid request';

 const parts = pointerParts(issue.instancePath);
 const location = issueLocation(context, parts);
 const params = issue.params as Record<string, unknown> | undefined;
 if (issue.keyword === 'required' && typeof params?.missingProperty === 'string')
  return `missing field \`${params.missingProperty}\`${location}`;
 if (issue.keyword === 'additionalProperties' && typeof params?.additionalProperty === 'string')
  return `unknown field \`${params.additionalProperty}\`${location}`;
 if (issue.keyword === 'type')
  return `invalid type: ${actualType(valueAtPath(root, parts))}, expected ${expectedType(params?.type)}${location}`;
 if (issue.keyword === 'enum')
  return `invalid value${location}; ${issue.message ?? 'value is not allowed'}`;
 return `${issue.message ?? 'invalid value'}${location}`;
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
