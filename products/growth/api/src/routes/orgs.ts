import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { CoreContext } from '../context.js';
import { ApiError } from '../error.js';
import { ACTIVE_ORG_COOKIE, USER_SESSION_COOKIE, activeOrgCookie, extractUser, requireOrigin } from '../identity/session.js';
import * as orgs from '../services/orgs.js';
import { loadLogo, storeLogo, trialSettings, MAX_LOGO_BYTES } from '../services/org-support.js';
type Params={id: string;userId: string;invId: string;token: string};
function params(request: FastifyRequest): Params{return request.params as Params;}
function body(request: FastifyRequest): Record<string,unknown>{if(!request.body||typeof request.body!=='object'||Array.isArray(request.body))throw orgs.bad('Invalid request');return request.body as Record<string,unknown>;}
function string(value: unknown,required=false): string|undefined {if(value===undefined||value===null){if(required)throw orgs.bad('Invalid request');return undefined;}if(typeof value!=='string')throw orgs.bad('Invalid request');return value;}
export function registerOrganizationRoutes(app: FastifyInstance,context: CoreContext): void {
 app.get('/api/orgs',async(request,reply)=>{
  const user=await extractUser(request,context);
  const memberships=await orgs.listOrgsForUser(context.pool,user.id);
  const preferred=activeOrgCookie(request);
  const selected=memberships.find(org=>org.id===preferred)??memberships[0];
  if(preferred&&!memberships.some(org=>org.id===preferred))reply.clearCookie(ACTIVE_ORG_COOKIE,{path:'/',httpOnly:true,secure:new URL(context.config.frontendUrl).protocol==='https:',sameSite:'lax'});
  return reply.header('cache-control','no-store').send({orgs:memberships,activeOrgId:selected?.id??null});
 });
 app.post('/api/orgs/set-active',async(request,reply)=>{
  const frontend=new URL(context.config.frontendUrl);
  const allowedHosts=new Set([frontend.host,new URL(context.config.publicApiUrl).host]);
  if(!allowedHosts.has(request.headers.host??''))throw new ApiError(403,'forbidden','Invalid request host');
  requireOrigin(request,context);
  if(!request.cookies[USER_SESSION_COOKIE])throw new ApiError(401,'unauthorized','Sign in required');
  const user=await extractUser(request,context);
  const orgId=body(request).orgId;
  if(typeof orgId!=='string'||!orgId)throw orgs.bad('orgId required');
  const memberships=await orgs.listOrgsForUser(context.pool,user.id);
  if(!memberships.some(org=>org.id===orgId))throw new ApiError(403,'forbidden','Organization access denied');
  return reply.header('cache-control','no-store').setCookie(ACTIVE_ORG_COOKIE,orgId,{
   path:'/',httpOnly:true,secure:frontend.protocol==='https:',sameSite:'lax',maxAge:60*60*24*365,
  }).send({ok:true});
 });
 app.post<{Body:{name:string;slug?:string|null;logo?:string|null}}>('/api/orgs',{
  schema:{body:{type:'object',required:['name'],properties:{name:{type:'string'},slug:{type:['string','null']},logo:{type:['string','null']}}}},
 },async(request,reply)=>{
  const user=await extractUser(request,context);const input=body(request);const name=string(input.name,true)!.trim();if(!name)throw orgs.bad('Organisation name is required');if(Buffer.byteLength(name)>80)throw orgs.bad('Organisation name must be 80 characters or fewer');
  const requested=string(input.slug)?.trim();const base=orgs.slugify(requested||name);if(!base)throw orgs.bad('Could not generate a valid slug from the name');const logo=string(input.logo)?.trim()||null;const trial=trialSettings(context);
  return reply.code(201).send({org:await orgs.createOrg(context,user.id,name,await orgs.uniqueSlug(context.pool,base),logo,trial.credits,trial.days)});
 });
 app.get('/api/orgs/:id',async request=>{const user=await extractUser(request,context);const {id}=params(request);await orgs.requireMember(context.pool,id,user.id);const org=await orgs.getOrg(context.pool,id);if(!org)throw new ApiError(404,'not_found','Organisation not found');return {org};});
 app.patch('/api/orgs/:id',async request=>{const user=await extractUser(request,context);const {id}=params(request);await orgs.requireAdmin(context.pool,id,user.id);const input=body(request);const name=string(input.name)?.trim()||null;let logo: string|null|undefined;if(input.logo===null)logo=null;else if(typeof input.logo==='string')logo=input.logo.trim()||null;return {org:await orgs.updateOrg(context.pool,id,name,logo)};});
 app.delete('/api/orgs/:id',async request=>{const user=await extractUser(request,context);const {id}=params(request);await orgs.requireOwner(context.pool,id,user.id);const result=await context.pool.query('SELECT COUNT(*) FROM "OrganizationMember" WHERE "orgId"=$1',[id]);if(BigInt(result.rows[0].count)>1n)throw orgs.bad('Remove all other members before deleting the organisation');await orgs.deleteOrg(context.pool,id);return {message:'Organisation deleted'};});
 app.get('/api/orgs/:id/logo',async(request,reply)=>{const user=await extractUser(request,context);const {id}=params(request);await orgs.requireMember(context.pool,id,user.id);const logo=await loadLogo(context,id);return reply.type(logo.mime).header('cache-control','private, max-age=300, must-revalidate').send(logo.bytes);});
 app.post('/api/orgs/:id/logo',async request=>{
  const user=await extractUser(request,context);const {id}=params(request);await orgs.requireAdmin(context.pool,id,user.id);let upload:{bytes: Buffer;mime: string}|undefined;
  try{for await(const part of request.parts({limits:{fileSize:MAX_LOGO_BYTES}})){
   if(part.type!=='file')continue;if(part.fieldname!=='file'){part.file.resume();continue;}const chunks:Buffer[]=[];let size=0;for await(const chunk of part.file){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>MAX_LOGO_BYTES)throw orgs.bad('Organization logos must be 5 MB or smaller');chunks.push(bytes);}if(part.file.truncated)throw orgs.bad('Organization logos must be 5 MB or smaller');upload={bytes:Buffer.concat(chunks),mime:part.mimetype.toLowerCase().split(';')[0]!};
  }}catch(error){if(error instanceof ApiError)throw error;const code=(error as {code?:string}).code;if(code==='FST_REQ_FILE_TOO_LARGE')throw orgs.bad('Organization logos must be 5 MB or smaller');throw orgs.bad('Failed to read logo upload');}
  if(!upload)throw orgs.bad('A logo file is required in form-data field: file');return {org:await storeLogo(context,id,upload.bytes,upload.mime)};
 });
 app.get('/api/orgs/:id/members',async request=>{const user=await extractUser(request,context);const {id}=params(request);await orgs.requireMember(context.pool,id,user.id);return {members:await orgs.listMembers(context.pool,id)};});
 app.patch('/api/orgs/:id/members/:userId',async request=>{const user=await extractUser(request,context);const {id,userId}=params(request);await orgs.requireAdmin(context.pool,id,user.id);const role=string(body(request).role,true)!;if(role==='OWNER')await orgs.requireOwner(context.pool,id,user.id);if(userId===user.id)throw orgs.bad('You cannot change your own role');await orgs.updateMemberRole(context.pool,id,userId,role);return {message:'Role updated'};});
 app.delete('/api/orgs/:id/members/:userId',async request=>{const user=await extractUser(request,context);const {id,userId}=params(request);if(userId!==user.id)await orgs.requireAdmin(context.pool,id,user.id);else await orgs.requireMember(context.pool,id,user.id);await orgs.removeMember(context.pool,id,userId);return {message:'Member removed'};});
 app.get('/api/orgs/:id/invitations',async request=>{const user=await extractUser(request,context);const {id}=params(request);await orgs.requireAdmin(context.pool,id,user.id);return {invitations:await orgs.listInvitations(context.pool,id)};});
 app.post('/api/orgs/:id/invitations',async(request,reply)=>{const user=await extractUser(request,context);const {id}=params(request);await orgs.requireAdmin(context.pool,id,user.id);const input=body(request);const email=string(input.email,true)!.trim().toLowerCase();if(!email.includes('@'))throw orgs.bad('Invalid email address');const role=string(input.role)??'MEMBER';const org=await orgs.getOrg(context.pool,id);if(!org)throw new ApiError(404,'not_found','Organisation not found');try{return reply.code(201).send({invitation:await orgs.createInvitation(context,id,org.name,user.id,user.name,email,role)});}catch(error){const failed=error as Error&{invitationId?:string};if(failed.invitationId)request.log.error({event:'provider.call.failed',provider:'resend',operation:'organization_invitation.email',invitation_id:failed.invitationId,error_type:failed.name},'invitation email delivery failed');throw error;}});
 app.delete('/api/orgs/:id/invitations/:invId',async request=>{const user=await extractUser(request,context);const {id,invId}=params(request);await orgs.requireAdmin(context.pool,id,user.id);await orgs.revokeInvitation(context.pool,id,invId);return {message:'Invitation revoked'};});
 app.get('/api/invitations/:token',async request=>{const inv=await orgs.getInvitationByToken(context.pool,params(request).token);if(!inv)throw new ApiError(404,'not_found','Invitation not found');return {invitation:inv};});
 app.post('/api/invitations/:token/accept',async request=>{const user=await extractUser(request,context);return {org:await orgs.acceptInvitation(context.pool,params(request).token,user.id)};});
}
