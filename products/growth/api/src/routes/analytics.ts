import type { FastifyInstance,FastifyRequest } from 'fastify';
import type { ReportQueryInput } from '@kasitek-labs/contracts';
import type { CoreContext } from '../context.js';
import { ApiError } from '../error.js';
import { extractUser,resolveActiveOrgId } from '../identity/session.js';
import { requireMember } from '../services/orgs.js';
import { reportForOrganization } from '../services/analytics-reporting.js';
import { billingEnforcementEnabled, requireCapability } from '../services/billing.js';
import { parseChronoTimestamp } from '../chrono-timestamp.js';
const bad=()=>new ApiError(400,'bad_request','Invalid request');
const OVERVIEW_METRIC_SET='overview.summary@1';
export function analyticsQueryNeedsPlan(input:ReportQueryInput):boolean{return input.metric_set!==OVERVIEW_METRIC_SET||(input.metrics?.length??0)>0||(input.breakdowns?.length??0)>0;}
export function parseReportQuery(value:unknown):ReportQueryInput {
 if(!value||typeof value!=='object'||Array.isArray(value))throw bad();const data=value as Record<string,unknown>;
 const allowed=new Set(['range_start','range_end','timezone','interval','metrics','metric_set','breakdowns','filters','include_descendants','comparison']);if(Object.keys(data).some(key=>!allowed.has(key)))throw bad();
 const time=(value:unknown):string=>{try{return parseChronoTimestamp(value);}catch{throw bad();}};
 const strings=(value:unknown):string[]=>{if(value===undefined)return [];if(!Array.isArray(value)||value.some(item=>typeof item!=='string'))throw bad();return value as string[];};
 if(typeof data.timezone!=='string')throw bad();const filters=data.filters??{};if(data.filters===null||typeof filters!=='object'||Array.isArray(filters))throw bad();for(const values of Object.values(filters))strings(values);
 for(const key of ['interval','metric_set'])if(data[key]!=null&&typeof data[key]!=='string')throw bad();if(data.include_descendants!==undefined&&typeof data.include_descendants!=='boolean')throw bad();
 let comparison:ReportQueryInput['comparison'];if(data.comparison!=null){if(typeof data.comparison!=='object'||Array.isArray(data.comparison)||Object.keys(data.comparison).some(key=>key!=='kind')||typeof(data.comparison as Record<string,unknown>).kind!=='string')throw bad();comparison=data.comparison as {kind:string};}
 return {range_start:time(data.range_start),range_end:time(data.range_end),timezone:data.timezone,metrics:strings(data.metrics),breakdowns:strings(data.breakdowns),filters:filters as Record<string,string[]>,include_descendants:data.include_descendants===true,...(data.interval!=null?{interval:data.interval as string}:{}),...(data.metric_set!=null?{metric_set:data.metric_set as string}:{}),...(comparison?{comparison}:{})};
}
async function scope(request:FastifyRequest,context:CoreContext):Promise<{userId:string;orgId:string}>{const user=await extractUser(request,context);const orgId=await resolveActiveOrgId(request,context,user.id);await requireMember(context.pool,orgId,user.id);return {userId:user.id,orgId};}
async function gateway(request:FastifyRequest,context:CoreContext,userId:string,orgId:string,input?:ReportQueryInput):Promise<unknown> {
 try{return await reportForOrganization(context,userId,orgId,input);}catch(error){if(error instanceof ApiError){const fields={event:error.status===503?'dependency.unavailable':'provider.call.failed',dependency:'customer_analytics',operation:error.message.includes('configured')?'configuration':'report',status:error.status,error_type:error.code};if(error.status>=500)request.log.error(fields,'customer analytics gateway request failed');else request.log.warn(fields,'customer analytics gateway request rejected');}throw error;}
}
export function registerAnalyticsRoutes(app:FastifyInstance,context:CoreContext):void {
 app.get('/api/analytics/catalog',async request=>{const auth=await scope(request,context);return gateway(request,context,auth.userId,auth.orgId);});
 app.post('/api/analytics/query',async request=>{const auth=await scope(request,context);const input=parseReportQuery(request.body);if(input.include_descendants)throw new ApiError(400,'bad_request','Core organization reports do not support descendant scopes');if(analyticsQueryNeedsPlan(input)&&billingEnforcementEnabled())await requireCapability(context.pool,auth.orgId,'feature.analytics.view');return gateway(request,context,auth.userId,auth.orgId,input);});
}
