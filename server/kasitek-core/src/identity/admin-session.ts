import { compare } from 'bcryptjs';
import type { CookieSerializeOptions } from '@fastify/cookie';
import type { FastifyRequest } from 'fastify';
import type { CoreContext } from '../context.js';
import { ApiError } from '../error.js';
import { unauthorized } from './provider.js';
import type { RequestContext } from './request-context.js';
export const ADMIN_SESSION_COOKIE='kasitek_admin_session';
export interface AdminUser {id:string;name:string;email:string;password:string;role:string;createdAt:Date;updatedAt:Date}
export function adminProfile(admin:AdminUser):{id:string;name:string;email:string;role:string}{const {id,name,email,role}=admin;return {id,name,email,role};}
export function adminCookieOptions(core:CoreContext):CookieSerializeOptions {
  const production=core.config.environment.toLowerCase()==='production';return {path:'/',httpOnly:true,secure:production,sameSite:production?'none':'lax',...(core.config.env.COOKIE_DOMAIN?{domain:core.config.env.COOKIE_DOMAIN}:{})};
}
export async function extractAdmin(request:FastifyRequest,core:CoreContext):Promise<AdminUser> {
  const id=request.cookies[ADMIN_SESSION_COOKIE];if(!id)throw unauthorized();
  const result=await core.pool.query<AdminUser>('SELECT id,name,email,password,role,"createdAt","updatedAt" FROM "AdminUser" WHERE id=$1',[id]);if(!result.rows[0])throw unauthorized();return result.rows[0];
}
export async function authenticateAdmin(core:CoreContext,email:string,password:string):Promise<AdminUser> {
  const result=await core.pool.query<AdminUser>('SELECT id,name,email,password,role,"createdAt","updatedAt" FROM "AdminUser" WHERE lower(email)=lower($1) LIMIT 1',[email.trim().toLowerCase()]);
  const admin=result.rows[0];if(!admin||!await compare(password.trim(),admin.password))throw unauthorized();return admin;
}
export function requireAdminRole(admin:AdminUser,roles:string[]):void {if(!roles.some(role=>role.toLowerCase()===admin.role.trim().toLowerCase()))throw new ApiError(403,'forbidden','Insufficient permissions');}
const normalize=(role:string):string=>role.trim().toLowerCase();
export function grantsForRole(role:string):Set<string> {
  switch(normalize(role)) {
    case 'viewer':return new Set(['admin:read']);
    case 'support':return new Set(['admin:read','admin:support']);
    case 'security':return new Set(['admin:read','admin:security']);
    case 'operator':case 'admin':return new Set(['admin:read','admin:write','admin:operate']);
    case 'superadmin':case 'owner':return new Set(['admin:read','admin:write','admin:operate','admin:support','admin:security','admin:emergency']);
    default:return new Set();
  }
}
export const canViewCustomerContent=(role:string):boolean=>['support','operator','admin','superadmin','owner'].includes(normalize(role));
export const canExecuteOperatorCommand=(role:string):boolean=>grantsForRole(role).has('admin:operate');
export const canManageSupportAccess=(role:string):boolean=>['admin','superadmin','owner'].includes(normalize(role));
export const canViewSupportAccess=(role:string):boolean=>['support','security','operator','admin','superadmin','owner'].includes(normalize(role));
export const canUseEmergencyAccess=(role:string):boolean=>['superadmin','owner'].includes(normalize(role));
export async function resolveAdminContext(request:FastifyRequest,core:CoreContext):Promise<RequestContext> {
  const admin=await extractAdmin(request,core);const grants=grantsForRole(admin.role);if(grants.size===0)throw new ApiError(403,'forbidden','Unsupported administrator role');
  return {principal:{kind:'platform_admin',id:admin.id,subjectUserId:null,clientId:null},organizationId:'platform',userId:null,clientId:null,installationId:null,effectiveGrants:grants,apiScopes:null,correlationId:null,causationId:null,idempotencyKey:null};
}
