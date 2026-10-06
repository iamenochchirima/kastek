export interface TenantConfig {
  port: number;
  environment: string;
  database_url: string;
  database_max_connections: number;
  allowed_origins: string[];
  cors_allow_credentials: boolean;
  app_base_url: string | null;
  portal_host_target: string | null;
  platform_base_domain: string | null;
  default_workspace_slug: string | null;
  session_cookie_name: string;
  session_cookie_domain: string | null;
  session_cookie_secure: boolean;
  session_cookie_same_site: 'lax' | 'strict' | 'none';
  session_ttl_hours: number;
  client_session_cookie_name: string;
  client_session_ttl_hours: number;
  invite_ttl_hours: number;
  admin_secret: string | null;
  resend_api_key: string | null;
  resend_from_email: string;
  shared_email_domain: string;
  analytics_reporting_url: string;
  analytics_reporting_private_key: string | null;
  analytics_reporting_key_id: string | null;
  analytics_reporting_resolver_token: string | null;
  analytics_reporting_issuer: string;
  analytics_reporting_audience: string;
  analytics_reporting_timeout_ms: number;
  env: Record<string, string | undefined>;
}
const uint = (value: string | undefined, max: number): number | undefined => {
  if (!value || !/^\+?\d+$/.test(value)) return;
  const n = Number(value); return Number.isSafeInteger(n) && n <= max ? n : undefined;
};
export function readConfig(source: Record<string,string|undefined> = process.env): TenantConfig {
 const env = Object.fromEntries(Object.entries(source).map(([key,value])=>[key,value?.trim() || undefined]));
 const str = (key:string,fallback:string)=>env[key] ?? fallback;
 const optional = (key:string)=>env[key] ?? null;
 const bool = (key:string,fallback:boolean)=>env[key] === undefined ? fallback : ['1','true','yes','on'].includes(env[key]!.toLowerCase());
 const n = (key:string,fallback:number)=>uint(env[key],4294967295) ?? fallback;
 const environment = str('TENANT_SERVER_ENVIRONMENT','development');
 const database_url = env.KASITEK_TENANTS_DATABASE_URL ?? env.TENANT_DATABASE_URL;
 if (!database_url) throw Error('Missing tenant database url (KASITEK_TENANTS_DATABASE_URL or TENANT_DATABASE_URL)');
 const app_base_url = optional('TENANT_APP_BASE_URL');
 const inferredHost = app_base_url?.replace(/^http:\/\//,'').replace(/^https:\/\//,'').split('/')[0]?.split(':')[0]?.toLowerCase() || null;
 const origins = (env.TENANT_ALLOWED_ORIGINS ?? '').split(',').map(v=>v.trim()).filter(Boolean);
 const site = str('TENANT_SESSION_COOKIE_SAME_SITE','lax').toLowerCase();
 return {
  port: uint(env.TENANT_SERVER_PORT,65535) ?? uint(env.PORT,65535) ?? 8090,
  environment,database_url,
  database_max_connections:uint(env.TENANT_DATABASE_MAX_CONNECTIONS,4294967295) ?? uint(env.DATABASE_MAX_CONNECTIONS,4294967295) ?? 10,
  allowed_origins:origins.length ? origins : ['http://localhost:3000','http://localhost:3001'],
  cors_allow_credentials:bool('TENANT_CORS_ALLOW_CREDENTIALS',true), app_base_url,
  portal_host_target:optional('TENANT_PORTAL_HOST_TARGET') ?? inferredHost,
  platform_base_domain:env.TENANT_PLATFORM_BASE_DOMAIN?.replace(/^\.+|\.+$/g,'').toLowerCase() || null,
  default_workspace_slug:optional('TENANT_DEFAULT_WORKSPACE_SLUG'),
  session_cookie_name:str('TENANT_SESSION_COOKIE_NAME','kasitenant.session'),
  session_cookie_domain:optional('TENANT_SESSION_COOKIE_DOMAIN'),
  session_cookie_secure:bool('TENANT_SESSION_COOKIE_SECURE',environment.toLowerCase()==='production'),
  session_cookie_same_site:site==='strict'||site==='none' ? site : 'lax',
  session_ttl_hours:n('TENANT_SESSION_TTL_HOURS',336),
  client_session_cookie_name:str('TENANT_CLIENT_SESSION_COOKIE_NAME','kasitenant.client.session'),
  client_session_ttl_hours:n('TENANT_CLIENT_SESSION_TTL_HOURS',336),invite_ttl_hours:n('TENANT_INVITE_TTL_HOURS',168),
  admin_secret:optional('TENANT_ADMIN_SECRET'),resend_api_key:optional('TENANT_RESEND_API_KEY') ?? optional('AUTH_RESEND_KEY'),
  resend_from_email:env.TENANT_RESEND_FROM_EMAIL ?? env.RESEND_FROM_EMAIL ?? 'KasiTek <onboarding@resend.dev>',
  shared_email_domain:str('TENANT_SHARED_EMAIL_DOMAIN','send.kasitek.co.za').replace(/^\.+|\.+$/g,'').toLowerCase(),
  analytics_reporting_url:str('ANALYTICS_REPORTING_URL','http://127.0.0.1:4300'),
  analytics_reporting_private_key:optional('ANALYTICS_REPORTING_PRIVATE_KEY'),analytics_reporting_key_id:optional('ANALYTICS_REPORTING_KEY_ID'),
  analytics_reporting_resolver_token:optional('ANALYTICS_REPORTING_RESOLVER_TOKEN'),
  analytics_reporting_issuer:str('ANALYTICS_REPORTING_ISSUER','kasitek-tenant-platform'),
  analytics_reporting_audience:str('ANALYTICS_REPORTING_AUDIENCE','kasitek-analytics-reporting'),
  analytics_reporting_timeout_ms:Math.min(120000,Math.max(250,n('ANALYTICS_REPORTING_TIMEOUT_MS',5000))),env,
 };
}
