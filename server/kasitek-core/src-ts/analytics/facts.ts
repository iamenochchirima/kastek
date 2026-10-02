import type {PoolClient} from 'pg';
import type {Timestamp,JsonValue,Integer} from '@kasitek/contracts';
import {wireInteger as genericWireInteger,integer,timestamp} from '@kasitek/server-support/json';
export function wireInteger(value:Integer):number|bigint {const parsed=integer(value);if(parsed<-(1n<<63n)||parsed>=(1n<<63n))throw new Error('integer outside signed 64-bit range');return genericWireInteger(parsed);}
import {buildEvent,coreProducerConfig,enqueueOutbox,buildManifest} from '@kasitek/server-support/analytics-producer';
export type {Timestamp,Integer};
export function iso(value:Timestamp):string {
 const input=typeof value==='string'?value:value.toISOString();timestamp(input); // Validate before normalizing Chrono's AutoSi fraction.
 const base=new Date(input).toISOString().replace(/\.\d{3}Z$/,'');
 const nanos=(input.match(/\.(\d+)/)?.[1]??'').padEnd(9,'0').slice(0,9);
 const fraction=/^0+$/.test(nanos)?'':nanos.endsWith('000000')?nanos.slice(0,3):nanos.endsWith('000')?nanos.slice(0,6):nanos;
 return `${base}${fraction?'.'+fraction:''}Z`;
}
/** Split seconds/fraction instead of rounding through Date milliseconds. */
export function epochMicros(value:Timestamp):bigint {const text=iso(value);const fraction=(text.match(/\.(\d+)/)?.[1]??'').padEnd(6,'0').slice(0,6);const seconds=Math.floor(new Date(text).getTime()/1000);if(!Number.isFinite(seconds))throw new Error('invalid timestamp');return BigInt(seconds)*1000000n+BigInt(fraction);}
export function epochMillis(value:Timestamp):bigint {const micros=epochMicros(value);return micros>=0n?micros/1000n:(micros-999n)/1000n;}
export function fact(domain:string,org:string,id:string,contract:string,subjectType:string,subjectId:string,time:Timestamp,attributes:Record<string,unknown>){
 // Shared lossless JSON canonicalization accepts bigint; public JsonValue currently omits it.
 return buildEvent(coreProducerConfig(),{record_id:id,source_domain:domain,source_stream_key:`organization:${org}:${domain}`,contract_name:contract,schema_version:1,scope_kind:'core_organization',scope_external_id:org,subject_type:subjectType,subject_id:subjectId,occurred_at:iso(time),attributes:attributes as JsonValue,correlation_id:null,causation_id:null,idempotency_key:id});
}
export function enqueueFact(tx:PoolClient,...args:Parameters<typeof fact>){return enqueueOutbox(tx,fact(...args));}
export async function sourceManifest(tx:PoolClient,domain:string,key:string,org:string,count:Integer,time:Timestamp,contracts:string[],metrics:string[],dimensions:string[],provider:string|null){
 const version=BigInt(Math.max(1,Math.floor(new Date(iso(time)).getTime()/3600000)));const stream=`organization:${org}:${domain}`;
 const next=new Date(new Date(iso(time)).getTime()+3600000).toISOString().replace(/\.\d{3}Z$/,iso(time).match(/(\.\d+)?Z$/)?.[0]??'Z');
 const record=buildManifest(coreProducerConfig(),{record_id:`manifest:${stream}:${key}:${version}`,source_domain:domain,source_stream_key:stream,contract_name:'source.manifest@1',schema_version:1,scope_kind:'core_organization',scope_external_id:org,manifest_key:key,manifest_version:version,provider,connection_ref:null,supported_contracts:contracts,supported_observation_contracts:[],supported_metrics:metrics,supported_dimensions:dimensions,expected_refresh_seconds:3600,reliable_coverage_start:null,highest_authoritative_source_sequence:null,approved_checkpoint_count:wireInteger(count),approved_checkpoint_hash:null,last_successful_collection_at:iso(time),last_attempted_collection_at:iso(time),safe_failure_code:null,next_expected_at:next,manifest_state:'active',generated_at:iso(time),idempotency_key:null});
 const result=await enqueueOutbox(tx,record);return result.kind==='conflict'?{...result,kind:'duplicate' as const}:result;
}
