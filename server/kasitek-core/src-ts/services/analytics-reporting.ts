import { createId } from '@paralleldrive/cuid2';
import { AnalyticsReportingClient,ReportingGrantIssuer,ReportingClientError,redactScopeId,withScope } from '@kasitek-labs/server-support/analytics-reporting';
import { integer } from '@kasitek-labs/server-support/json';
import type { ReportQueryInput,ScopeResolution } from '@kasitek-labs/contracts';
import type { CoreContext } from '../context.js';
import { ApiError } from '../error.js';
import { unsignedSetting } from './org-support.js';
export const SOURCE_SERVICE='core',SCOPE_KIND='core_organization';
const unavailable=(message:string)=>new ApiError(503,'service_unavailable',message);
export function mapReportingError(error:unknown,phase:'request'|'configuration'|'signing'='request'):ApiError {
 if(error instanceof ApiError)return error;
 if(phase==='configuration')return unavailable('Customer analytics is not configured');
 if(phase==='signing')return new ApiError(500,'internal_error','Customer analytics authorization failed');
 if(error instanceof ReportingClientError){if([400,422].includes(error.status))return new ApiError(400,'bad_request','Customer analytics rejected the report request');if([401,403].includes(error.status))return new ApiError(502,'bad_gateway','Customer analytics authorization failed');if(error.status===404)return unavailable('Customer analytics scope is not ready');return unavailable('Customer analytics is temporarily unavailable');}
 if(error instanceof SyntaxError)return new ApiError(502,'bad_gateway','Customer analytics returned an invalid response');
 return unavailable('Customer analytics is temporarily unavailable');
}
export async function reportingDependencies(context:CoreContext):Promise<{client:AnalyticsReportingClient;issuer:ReportingGrantIssuer}> {
 const env=context.config.env;const token=env.ANALYTICS_REPORTING_RESOLVER_TOKEN,privateKey=env.ANALYTICS_REPORTING_PRIVATE_KEY;
 if(!token?.trim()||!privateKey?.trim())throw unavailable('Customer analytics is not configured');
 try{return {client:new AnalyticsReportingClient(env.ANALYTICS_REPORTING_URL??'http://127.0.0.1:4300',token,Math.max(250,Math.min(120000,unsignedSetting(env.ANALYTICS_REPORTING_TIMEOUT_MS,5000)))),issuer:await ReportingGrantIssuer.fromPem(privateKey,env.ANALYTICS_REPORTING_ISSUER??'kasitek-core',env.ANALYTICS_REPORTING_AUDIENCE?.trim()||'kasitek-analytics-reporting',env.ANALYTICS_REPORTING_KEY_ID)};}catch(error){throw mapReportingError(error,'configuration');}
}
function scopeResponse(value:unknown):ScopeResolution {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new SyntaxError('invalid scope resolution');const scope=value as Record<string,unknown>;
 try{for(const key of ['scope_id','root_scope_id']){const raw=scope[key];if(typeof raw!=='number'&&typeof raw!=='bigint')throw Error('invalid integer');const id=integer(raw);if(id< -9223372036854775808n||id>9223372036854775807n)throw Error('invalid integer');}if(scope.parent_scope_id!=null){const raw=scope.parent_scope_id;if(typeof raw!=='number'&&typeof raw!=='bigint')throw Error('invalid integer');integer(raw);}for(const key of ['scope_kind','owning_source_service','external_source_id','reporting_timezone'])if(typeof scope[key]!=='string')throw Error('invalid string');}catch{throw new SyntaxError('invalid scope resolution');}
 return scope as unknown as ScopeResolution;
}
export async function reportForOrganization(context:CoreContext,userId:string,organizationId:string,input?:ReportQueryInput):Promise<unknown> {
 const {client,issuer}=await reportingDependencies(context);let scope:ScopeResolution;
 try{scope=scopeResponse(await client.resolveScope(SOURCE_SERVICE,SCOPE_KIND,organizationId));}catch(error){throw mapReportingError(error);}
 let grant:string;try{grant=await issuer.issue({principal_id:userId,scope_id:scope.scope_id,root_scope_id:scope.root_scope_id,descendant_mode:'none',permissions:['analytics:read'],metric_keys:[],dimension_keys:[],correlation_id:`core-${createId()}`});}catch(error){throw mapReportingError(error,'signing');}
 try{const response=input?await client.report(grant,withScope(input,scope.scope_id)):await client.catalog(grant,scope.scope_id);return redactScopeId(response,SCOPE_KIND,organizationId);}catch(error){throw mapReportingError(error);}
}
