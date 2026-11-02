import {createHash} from 'node:crypto';
export interface IngestionCredential {source_service:string;producer_id:string;token_sha256:string;}
export interface ReportingResolverCredential {source_service:string;token_sha256:string;}
export interface AnalyticsConfig {
 admin_reporting_secret?:string|null;
 reporting_database_url?:string|null;
 environment:string;api_host:string;api_port:number;database_url:string;redis_url:string|null;
 metrics_token:string|null;rollout_admin_producers:string[];
 reporting_public_key:string|null;reporting_public_keys_json:string|null;reporting_issuers:string[];reporting_audience:string;
 reporting_resolver_credentials:ReportingResolverCredential[];ingestion_credentials:IngestionCredential[];
 database_max_connections:number;database_acquire_timeout_ms:number|bigint;database_connect_timeout_ms:number|bigint;log_filter:string;
}
export class ConfigError extends Error {
 constructor(public readonly variable:string,public readonly value?:string){super(value===undefined?`missing environment variable: ${variable}`:`invalid value for ${variable}: ${value}`);}
}
const optional=(value:string|undefined)=>value?.trim()||null;
const str=(value:string|undefined,fallback:string)=>optional(value)??fallback;
const csv=(value:string|undefined,fallback:string[])=>{const values=(value??'').split(',').map(value=>value.trim()).filter(Boolean);return values.length?values:fallback;};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
function unsigned(variable:string,value:string|undefined,fallback:number,max:bigint):number|bigint {
 if(value===undefined||!value.trim())return fallback;
 if(!/^\+?\d+$/.test(value))throw new ConfigError(variable,value);
 const parsed=BigInt(value);if(parsed===0n||parsed>max)throw new ConfigError(variable,value);
 return parsed<=BigInt(Number.MAX_SAFE_INTEGER)?Number(parsed):parsed;
}
function credentials(value:string|null,key:string):Record<string,unknown>[] {
 if(value===null)return [];
 try{const parsed:unknown=JSON.parse(value);if(!Array.isArray(parsed)||parsed.some(row=>!row||typeof row!=='object'||Array.isArray(row)))throw Error();return parsed as Record<string,unknown>[];}
 catch{throw new ConfigError(key,'invalid credential configuration');}
}
export function readConfig(source:Record<string,string|undefined>=process.env):AnalyticsConfig {
 const database_url=optional(source.ANALYTICS_DATABASE_URL);if(!database_url)throw new ConfigError('ANALYTICS_DATABASE_URL');
 const identities=new Set<string>(),digests=new Set<string>();
 const ingestionKey='ANALYTICS_INGESTION_CREDENTIALS_JSON';
 const ingestion_credentials=credentials(optional(source[ingestionKey]),ingestionKey).map(raw=>{
  if(typeof raw.source_service!=='string'||typeof raw.producer_id!=='string'||typeof raw.token!=='string')throw new ConfigError(ingestionKey,'invalid credential configuration');
  const source_service=raw.source_service.trim(),producer_id=raw.producer_id.trim(),token=raw.token.trim();
  const identity=JSON.stringify([source_service,producer_id]),token_sha256=hash(token);
  if(!['core','agent-platform','tenant-platform'].includes(source_service)||!producer_id||!token||identities.has(identity)||digests.has(token_sha256))throw new ConfigError(ingestionKey,'invalid credential configuration');
  identities.add(identity);digests.add(token_sha256);return {source_service,producer_id,token_sha256};
 });
 const resolverKey='ANALYTICS_REPORTING_RESOLVER_CREDENTIALS_JSON',seen=new Set<string>();
 const reporting_resolver_credentials=credentials(optional(source[resolverKey]),resolverKey).map(raw=>{
  if(typeof raw.source_service!=='string'||typeof raw.token!=='string')throw new ConfigError(resolverKey,'invalid credential configuration');
  const source_service=raw.source_service.trim(),token=raw.token.trim();
  if(!source_service||!token)throw new ConfigError(resolverKey,'source_service and token are required');
  if(seen.has(source_service))throw new ConfigError(resolverKey,`duplicate source_service ${source_service}`);
  seen.add(source_service);return {source_service,token_sha256:hash(token)};
 });
 return {reporting_database_url:optional(source.ANALYTICS_REPORTING_DATABASE_URL),admin_reporting_secret:optional(source.KASITEK_ADMIN_SERVICE_SECRET),environment:str(source.ANALYTICS_ENVIRONMENT,'development'),api_host:str(source.ANALYTICS_API_HOST,'0.0.0.0'),
  api_port:Number(unsigned('ANALYTICS_API_PORT',source.ANALYTICS_API_PORT??source.PORT,4300,65535n)),database_url,
  redis_url:optional(source.ANALYTICS_REDIS_URL),metrics_token:optional(source.ANALYTICS_METRICS_TOKEN),rollout_admin_producers:csv(source.ANALYTICS_ROLLOUT_ADMIN_PRODUCERS,[]),
  reporting_public_key:optional(source.ANALYTICS_REPORTING_PUBLIC_KEY),reporting_public_keys_json:optional(source.ANALYTICS_REPORTING_PUBLIC_KEYS_JSON),
  reporting_issuers:csv(source.ANALYTICS_REPORTING_ISSUERS,['kasitek-core','kasitek-agent-platform','kasitek-tenant-platform']),
  reporting_audience:str(source.ANALYTICS_REPORTING_AUDIENCE,'kasitek-analytics-reporting'),reporting_resolver_credentials,ingestion_credentials,
  database_max_connections:Number(unsigned('ANALYTICS_DATABASE_MAX_CONNECTIONS',source.ANALYTICS_DATABASE_MAX_CONNECTIONS,10,4294967295n)),
  database_acquire_timeout_ms:unsigned('ANALYTICS_DATABASE_ACQUIRE_TIMEOUT_MS',source.ANALYTICS_DATABASE_ACQUIRE_TIMEOUT_MS,5000,18446744073709551615n),
  database_connect_timeout_ms:unsigned('ANALYTICS_DATABASE_CONNECT_TIMEOUT_MS',source.ANALYTICS_DATABASE_CONNECT_TIMEOUT_MS,5000,18446744073709551615n),
  log_filter:str(source.ANALYTICS_LOG_FILTER,'info')};
}
