import { createHash, randomBytes } from "node:crypto";
import { adminCapabilities, requiredAdminCapability } from "@kasitek-labs/server-support/admin-authority";
import { compare } from 'bcryptjs';
import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyRequest } from 'fastify';
import type { CoreContext } from '../context.js';
import { ApiError } from '../error.js';
import { unauthorized } from './provider.js';
import type { RequestContext } from './request-context.js';
export const adminAuditActors = new WeakMap<object, {id:string;role:string}>();
export const ADMIN_SESSION_COOKIE='kasitek_admin_session';
export interface AdminUser {id:string;name:string;email:string;password:string;role:string;createdAt:Date;updatedAt:Date}
export function adminProfile(admin:AdminUser):{id:string;name:string;email:string;role:string}{const {id,name,email,role}=admin;return {id,name,email,role};}
export function adminCookieOptions(core:CoreContext):CookieSerializeOptions {
  const production=core.config.environment.toLowerCase()==='production';return {path:'/',httpOnly:true,secure:production,sameSite:'lax',...(core.config.env.COOKIE_DOMAIN?{domain:core.config.env.COOKIE_DOMAIN}:{})};
}
export const ADMIN_SESSION_SECONDS = 8 * 60 * 60;
const sessionHash = (token: string) => createHash('sha256').update(token).digest('hex');
export async function createAdminSession(core: CoreContext, adminId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await core.pool.query('INSERT INTO "AdminSession" ("tokenHash","adminId","expiresAt") VALUES ($1,$2,NOW()+INTERVAL \'8 hours\')', [sessionHash(token),adminId]);
  return token;
}
export async function revokeAdminSession(core: CoreContext, token: string | undefined): Promise<void> {
  if (token) await core.pool.query('UPDATE "AdminSession" SET "revokedAt"=NOW() WHERE "tokenHash"=$1 AND "revokedAt" IS NULL', [sessionHash(token)]);
}
export async function extractAdmin(request:FastifyRequest,core:CoreContext):Promise<AdminUser> {
  if (!['GET','HEAD','OPTIONS'].includes(request.method)) {
    const origin = request.headers.origin;
    if (!origin || ![core.config.adminFrontendUrl, core.config.frontendUrl].map(value => new URL(value).origin).includes(origin) || request.headers['sec-fetch-site'] === 'cross-site') throw new ApiError(403,'forbidden','Invalid request origin');
  }
  const token=request.cookies[ADMIN_SESSION_COOKIE];if(!token || !/^[A-Za-z0-9_-]{43}$/.test(token))throw unauthorized();
  const result=await core.pool.query<AdminUser>('SELECT a.id,a.name,a.email,a.password,a.role,a."createdAt",a."updatedAt" FROM "AdminSession" s JOIN "AdminUser" a ON a.id=s."adminId" WHERE s."tokenHash"=$1 AND s."expiresAt">NOW() AND s."revokedAt" IS NULL',[sessionHash(token)]);
  const admin=result.rows[0];if(!admin)throw unauthorized();
  adminAuditActors.set(request, {id:admin.id,role:admin.role});
  if(!grantsForRole(admin.role).has(requiredAdminCapability(request.method,request.url)))throw new ApiError(403,'forbidden','Insufficient permissions');
  return admin;
}
export async function authenticateAdmin(core:CoreContext,email:string,password:string):Promise<AdminUser> {
  const result=await core.pool.query<AdminUser>('SELECT id,name,email,password,role,"createdAt","updatedAt" FROM "AdminUser" WHERE lower(email)=lower($1) LIMIT 1',[email.trim().toLowerCase()]);
  const admin=result.rows[0];if(!admin||!await compare(password.trim(),admin.password))throw unauthorized();return admin;
}
export function requireAdminRole(admin:AdminUser,roles:string[]):void {if(!roles.some(role=>role.toLowerCase()===admin.role.trim().toLowerCase()))throw new ApiError(403,'forbidden','Insufficient permissions');}
const normalize=(role:string):string=>role.trim().toLowerCase();
export function grantsForRole(role:string):Set<string> { return adminCapabilities(role); }
export const canViewCustomerContent=(role:string):boolean=>['support','operator','admin','superadmin','owner'].includes(normalize(role));
export const canExecuteOperatorCommand=(role:string):boolean=>grantsForRole(role).has('admin:operate');
export const canManageSupportAccess=(role:string):boolean=>['admin','superadmin','owner'].includes(normalize(role));
export const canViewSupportAccess=(role:string):boolean=>['support','security','operator','admin','superadmin','owner'].includes(normalize(role));
export const canUseEmergencyAccess=(role:string):boolean=>['superadmin','owner'].includes(normalize(role));
export async function resolveAdminContext(request:FastifyRequest,core:CoreContext):Promise<RequestContext> {
  const admin=await extractAdmin(request,core);const grants=grantsForRole(admin.role);if(grants.size===0)throw new ApiError(403,'forbidden','Unsupported administrator role');
  return {principal:{kind:'platform_admin',id:admin.id,subjectUserId:null,clientId:null},organizationId:'platform',userId:null,clientId:null,effectiveGrants:grants,apiScopes:null,correlationId:null,causationId:null,idempotencyKey:null};
}
