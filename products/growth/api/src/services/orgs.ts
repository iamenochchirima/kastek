import { enqueueGrowthAgentSetup } from "../agents/setup.js";
import { createId } from '@paralleldrive/cuid2';
import { randomBytes, createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { CoreContext } from '../context.js';
import { ApiError } from '../error.js';
import { transaction } from '../db.js';
import { enqueueOrganizationScope, sendOrganizationEmail } from './org-support.js';
export interface OrgRow { id: string; name: string; slug: string; logo: string | null; ownerId: string; reportingTimezone: string; createdAt: Date; updatedAt: Date }
const columns = 'id,name,slug,logo,"ownerId","reportingTimezone","createdAt" AT TIME ZONE \'UTC\' AS "createdAt","updatedAt" AT TIME ZONE \'UTC\' AS "updatedAt"';
export const bad = (message: string): ApiError => new ApiError(400,'bad_request',message);
const notFound = (message: string): ApiError => new ApiError(404,'not_found',message);
const hash = (token: string): string => createHash('sha256').update(token).digest('hex');
export function slugify(name: string): string { return [...name.toLowerCase().replace(/[^\p{L}\p{N}]/gu,'-').split('-').filter(Boolean).join('-')].slice(0,48).join(''); }
export async function uniqueSlug(pool: Pool, base: string): Promise<string> { let candidate=base;let suffix=2;while((await pool.query('SELECT EXISTS(SELECT 1 FROM "Organization" WHERE slug=$1) AS exists',[candidate])).rows[0].exists){candidate=`${base}-${suffix++}`;}return candidate; }
export async function getOrg(pool: Pool | PoolClient, id: string): Promise<OrgRow | undefined> { return (await pool.query<OrgRow>(`SELECT ${columns} FROM "Organization" WHERE id=$1`,[id])).rows[0]; }
export async function listOrgsForUser(pool: Pool,userId: string): Promise<OrgRow[]> { return (await pool.query<OrgRow>(`SELECT o.id,o.name,o.slug,o.logo,o."ownerId",o."reportingTimezone",o."createdAt" AT TIME ZONE 'UTC' AS "createdAt",o."updatedAt" AT TIME ZONE 'UTC' AS "updatedAt" FROM "Organization" o JOIN "OrganizationMember" m ON m."orgId"=o.id WHERE m."userId"=$1 ORDER BY o."createdAt" ASC`,[userId])).rows; }
export async function getMemberRole(pool: Pool,orgId: string,userId: string): Promise<string | undefined> { return (await pool.query('SELECT role::text FROM "OrganizationMember" WHERE "orgId"=$1 AND "userId"=$2',[orgId,userId])).rows[0]?.role; }
export async function requireMember(pool: Pool,orgId: string,userId: string): Promise<string> { const role=await getMemberRole(pool,orgId,userId);if(!role)throw new ApiError(403,'forbidden','Not a member of this organisation');return role; }
export async function requireAdmin(pool: Pool,orgId: string,userId: string): Promise<void> { if(!['OWNER','ADMIN'].includes(await requireMember(pool,orgId,userId)))throw new ApiError(403,'forbidden','Admin or Owner role required'); }
export async function requireOwner(pool: Pool,orgId: string,userId: string): Promise<void> { if(await requireMember(pool,orgId,userId)!=='OWNER')throw new ApiError(403,'forbidden','Owner role required'); }
export async function createOrg(context: CoreContext,userId: string,name: string,slug: string,logo: string|null): Promise<OrgRow> {
 const orgId=createId();
 const org=await transaction(context.pool,async tx=>{
  let created: OrgRow;
  try { created=(await tx.query<OrgRow>(`INSERT INTO "Organization"(id,name,slug,logo,"ownerId","reportingTimezone","createdAt","updatedAt") VALUES($1,$2,$3,$4,$5,'UTC',NOW(),NOW()) RETURNING ${columns}`,[orgId,name,slug,logo,userId])).rows[0]!; }
  catch(error){if((error as {code?:string}).code==='23505')throw new ApiError(409,'conflict','An organisation with that slug already exists');throw error;}
  await tx.query('INSERT INTO "OrganizationMember"(id,"orgId","userId",role,"joinedAt","createdAt","updatedAt") VALUES($1,$2,$3,\'OWNER\'::"OrgRole",NOW(),NOW(),NOW())',[createId(),orgId,userId]);
  try {await enqueueOrganizationScope(tx,orgId,Math.max(1,created.createdAt.getTime()),created.reportingTimezone,'active');}catch(error){throw new ApiError(500,'internal_error',`failed to queue organization Analytics scope: ${error instanceof Error ? error.message : 'unknown error'}`);}
  await enqueueGrowthAgentSetup(tx,orgId,context.config);
  return created;
 });
 return org;
}
export async function updateOrg(pool: Pool,id: string,name: string|null,logo: string|null|undefined): Promise<OrgRow> { const row=(await pool.query<OrgRow>(`UPDATE "Organization" SET name=COALESCE($1,name),logo=CASE WHEN $2 THEN $3 ELSE logo END,"updatedAt"=NOW() WHERE id=$4 RETURNING ${columns}`,[name,logo!==undefined,logo??null,id])).rows[0];if(!row)throw new ApiError(500,'internal_error','Database operation failed');return row; }
export async function deleteOrg(pool: Pool,id: string): Promise<void> {await pool.query('DELETE FROM "Organization" WHERE id=$1',[id]);}
export async function listMembers(pool: Pool,id: string): Promise<Record<string,unknown>[]> {return (await pool.query(`SELECT m.id,m."orgId",m."userId",m.role::text AS role,m."joinedAt" AT TIME ZONE 'UTC' AS "joinedAt",u.name,u.email,u.image FROM "OrganizationMember" m JOIN "User" u ON u.id=m."userId" WHERE m."orgId"=$1 ORDER BY m."joinedAt" ASC`,[id])).rows;}
export async function updateMemberRole(pool: Pool,id: string,userId: string,role: string): Promise<void> {
 if(!['OWNER','ADMIN','MEMBER'].includes(role))throw bad(`Invalid role: ${role}`);
 const updated=await pool.query('UPDATE "OrganizationMember" SET role=$1::"OrgRole","updatedAt"=NOW() WHERE "orgId"=$2 AND "userId"=$3',[role,id,userId]);
 if(!updated.rowCount)throw notFound('Member not found');
 if(role==='OWNER') {await pool.query('UPDATE "OrganizationMember" SET role=\'ADMIN\'::"OrgRole","updatedAt"=NOW() WHERE "orgId"=$1 AND "userId"!=$2 AND role=\'OWNER\'::"OrgRole"',[id,userId]);await pool.query('UPDATE "Organization" SET "ownerId"=$1,"updatedAt"=NOW() WHERE id=$2',[userId,id]);}
}
export async function removeMember(pool: Pool,id: string,userId: string): Promise<void> {if(await getMemberRole(pool,id,userId)==='OWNER')throw bad('Cannot remove the organisation owner. Transfer ownership first.');await pool.query('DELETE FROM "OrganizationMember" WHERE "orgId"=$1 AND "userId"=$2',[id,userId]);}
export async function listInvitations(pool: Pool,id: string): Promise<Record<string,unknown>[]> {return (await pool.query(`SELECT i.id,i."orgId",i.email,i.role::text AS role,''::text AS token,i."invitedById",i."expiresAt" AT TIME ZONE 'UTC' AS "expiresAt",i."acceptedAt" AT TIME ZONE 'UTC' AS "acceptedAt",i."createdAt" AT TIME ZONE 'UTC' AS "createdAt",u.name AS "invitedByName" FROM "OrganizationInvitation" i JOIN "User" u ON u.id=i."invitedById" WHERE i."orgId"=$1 AND i."revokedAt" IS NULL ORDER BY i."createdAt" DESC`,[id])).rows;}
export async function createInvitation(context: CoreContext,orgId: string,orgName: string,invitedById: string,invitedByName: string|null,email: string,role: string,allowExistingMember=false): Promise<Record<string,unknown>> {
 if(!['ADMIN','MEMBER'].includes(role))throw bad(`Invalid role '${role}'. Must be ADMIN or MEMBER.`);
 const already=(await context.pool.query(`SELECT EXISTS(SELECT 1 FROM "OrganizationMember" m JOIN "User" u ON u.id=m."userId" WHERE m."orgId"=$1 AND LOWER(u.email)=LOWER($2) AND u."emailVerified" IS NOT NULL) AS exists`,[orgId,email])).rows[0].exists;
 if(already&&!allowExistingMember)throw new ApiError(409,'conflict','That person is already a member of this organisation');
 const token=randomBytes(48).toString('base64url');const expires=new Date(Date.now()+7*86400000);
 await context.pool.query('DELETE FROM "OrganizationInvitation" WHERE "orgId"=$1 AND LOWER(email)=LOWER($2) AND "acceptedAt" IS NULL',[orgId,email]);
 const inv=(await context.pool.query(`INSERT INTO "OrganizationInvitation"(id,"orgId",email,role,"tokenHash","invitedById","expiresAt","createdAt","updatedAt") VALUES($1,$2,$3,$4::"OrgRole",$5,$6,$7,NOW(),NOW()) RETURNING id,"orgId",email,role::text AS role,''::text AS token,"invitedById","expiresAt" AT TIME ZONE 'UTC' AS "expiresAt","acceptedAt" AT TIME ZONE 'UTC' AS "acceptedAt","createdAt" AT TIME ZONE 'UTC' AS "createdAt",$8::text AS "invitedByName"`,[createId(),orgId,email,role,hash(token),invitedById,expires,invitedByName])).rows[0]!;
 try {await sendOrganizationEmail(context,email,`You're invited to join ${orgName} on KasiTek`,`${invitedByName??'A team member'} has invited you to join the "${orgName}" organisation on KasiTek.\n\nAccept the invitation here:\n${context.config.frontendUrl}/invite/${token}\n\nThis link expires in 7 days.`);}catch(error){if(error instanceof Error)Object.assign(error,{invitationId:inv.id});throw error;}
 return inv;
}
export async function acceptInvitation(pool: Pool,token: string,userId: string): Promise<OrgRow> {
 const orgId=await transaction(pool,async tx=>{
  const inv=(await tx.query(`SELECT i.id,i."orgId",i.email,i.role::text AS role,i."expiresAt" AT TIME ZONE 'UTC' AS "expiresAt",i."acceptedAt" AT TIME ZONE 'UTC' AS "acceptedAt" FROM "OrganizationInvitation" i WHERE i."tokenHash"=$1 AND i."revokedAt" IS NULL FOR UPDATE`,[hash(token)])).rows[0];
  if(!inv)throw notFound('Invitation not found');if(inv.acceptedAt)throw bad('This invitation has already been accepted');if(inv.expiresAt<Date.now())throw bad('This invitation has expired');
  const userEmail=(await tx.query('SELECT email FROM "User" WHERE id=$1',[userId])).rows[0]?.email??'';
  if(userEmail.toLowerCase()!==inv.email.toLowerCase())throw new ApiError(403,'forbidden','Sign in with the email address that received this invitation');
  await tx.query('INSERT INTO "OrganizationMember"(id,"orgId","userId",role,"joinedAt","createdAt","updatedAt") VALUES($1,$2,$3,$4::"OrgRole",NOW(),NOW(),NOW()) ON CONFLICT("orgId","userId") DO NOTHING',[createId(),inv.orgId,userId,inv.role]);
  await tx.query('UPDATE "OrganizationInvitation" SET "acceptedAt"=NOW(),"updatedAt"=NOW() WHERE id=$1',[inv.id]);return inv.orgId as string;
 });
 const org=await getOrg(pool,orgId);if(!org)throw notFound('Organisation not found');return org;
}
export async function revokeInvitation(pool: Pool,id: string,invId: string): Promise<void> {const result=await pool.query('UPDATE "OrganizationInvitation" SET "revokedAt"=NOW(),"updatedAt"=NOW() WHERE id=$1 AND "orgId"=$2 AND "acceptedAt" IS NULL AND "revokedAt" IS NULL',[invId,id]);if(!result.rowCount)throw notFound('Pending invitation not found');}
export async function getInvitationByToken(pool: Pool,token: string): Promise<Record<string,unknown>|undefined> {return(await pool.query(`SELECT i.id,i."orgId",i.email,i.role::text AS role,i."expiresAt" AT TIME ZONE 'UTC' AS "expiresAt",i."acceptedAt" AT TIME ZONE 'UTC' AS "acceptedAt",o.name AS "orgName",o.logo AS "orgLogo",u.name AS "invitedByName" FROM "OrganizationInvitation" i JOIN "Organization" o ON o.id=i."orgId" JOIN "User" u ON u.id=i."invitedById" WHERE i."tokenHash"=$1 AND i."revokedAt" IS NULL`,[hash(token)])).rows[0];}
/** Early-access provisioning is the sole caller allowed to reinvite an existing active member. */
export async function createInvitationForExistingMember(context: CoreContext,orgId: string,orgName: string,invitedById: string,invitedByName: string|null,email: string,role: string): Promise<Record<string,unknown>> {return createInvitation(context,orgId,orgName,invitedById,invitedByName,email,role,true);}
