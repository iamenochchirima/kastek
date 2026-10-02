/** Organization-owned lifecycle adapters until billing/referrals get their full ports. */
import { createId } from '@paralleldrive/cuid2';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import type { CoreContext } from '../context.js';
import { transaction } from '../db.js';
import { ApiError } from '../error.js';
import { updateOrg, type OrgRow } from './orgs.js';
export function unsignedSetting(value: string|undefined,fallback: number): number {if(!value||!/^\+?\d+$/.test(value))return fallback;const parsed=Number(value);return Number.isSafeInteger(parsed)&&parsed<=4294967295?parsed:fallback;}
export function trialSettings(context: CoreContext): {credits: bigint;days: number} {return {credits:BigInt(Math.max(1,unsignedSetting(context.config.env.KASITEK_TRIAL_CREDITS,1000))),days:Math.max(1,Math.min(90,unsignedSetting(context.config.env.KASITEK_TRIAL_DURATION_DAYS,14)))};}
export async function ensureReferralCode(pool: Pool,orgId: string): Promise<string> {
 const read=async()=> (await pool.query('SELECT code FROM "ReferralCode" WHERE "orgId"=$1',[orgId])).rows[0]?.code as string|undefined;
 const current=await read();if(current)return current;
 for(let attempt=0;attempt<5;attempt++){const code=`KASI-${createId().slice(0,10).toUpperCase()}`;const inserted=await pool.query('INSERT INTO "ReferralCode"(id,"orgId",code,status,"createdAt","updatedAt") VALUES($1,$2,$3,\'ACTIVE\',NOW(),NOW()) ON CONFLICT("orgId") DO NOTHING',[createId(),orgId,code]);if(inserted.rowCount===1)return code;const existing=await read();if(existing)return existing;}
 throw new ApiError(409,'referral_code_unavailable','Could not create a unique referral code');
}
async function ensureAccount(tx: PoolClient,orgId: string): Promise<{id: string;balance: string;reservedBalance: string}> {
 await tx.query('INSERT INTO "CreditAccount"(id,"orgId",balance,"reservedBalance","createdAt","updatedAt") VALUES($1,$2,0,0,NOW(),NOW()) ON CONFLICT("orgId") DO UPDATE SET "updatedAt"=NOW() RETURNING id',[createId(),orgId]);
 const account=(await tx.query('SELECT id,balance,"reservedBalance" FROM "CreditAccount" WHERE "orgId"=$1 FOR UPDATE',[orgId])).rows[0];
 if(!account)throw new ApiError(404,'not_found','Organization credit account not found');return account;
}
function available(balance: bigint,reserved: bigint): bigint {if(reserved<0n||reserved>balance)throw new ApiError(500,'internal_error','Credit account balance invariant is invalid');return balance-reserved;}
async function expireGrants(pool: Pool,orgId: string): Promise<void> {
 await transaction(pool,async tx=>{const account=await ensureAccount(tx,orgId);let balance=BigInt(account.balance);let usable=available(balance,BigInt(account.reservedBalance));if(!usable)return;
 const grants=(await tx.query('SELECT id,"remainingAmount" FROM "CreditGrant" WHERE "accountId"=$1 AND "remainingAmount">0 AND "startsAt"<=NOW() AND "endsAt" IS NOT NULL AND "endsAt"<=NOW() ORDER BY "endsAt","startsAt",id FOR UPDATE',[account.id])).rows;
 for(const grant of grants){if(!usable)break;const remaining=BigInt(grant.remainingAmount);const amount=remaining<usable?remaining:usable;await tx.query('UPDATE "CreditGrant" SET "remainingAmount"="remainingAmount"-$1,"updatedAt"=NOW() WHERE id=$2',[amount.toString(),grant.id]);balance-=amount;usable-=amount;
 await tx.query('INSERT INTO "CreditLedgerEntry"(id,"accountId","orgId","grantId",type,amount,"balanceAfter","sourceType","sourceId",metadata,"createdAt") VALUES($1,$2,$3,$4,\'EXPIRY\',$5,$6,\'SYSTEM\',$4,$7,NOW())',[createId(),account.id,orgId,grant.id,(-amount).toString(),balance.toString(),{reason:'credit_grant_expired'}]);}
 if(balance!==BigInt(account.balance))await tx.query('UPDATE "CreditAccount" SET balance=$1,"updatedAt"=NOW() WHERE id=$2',[balance.toString(),account.id]);
 });
}
/** Exact initial TRIAL grant/ledger/account and idempotency effects, without an admin operation. */
export async function grantInitialTrial(pool: Pool,orgId: string,amount: bigint,days: number): Promise<void> {
 if(amount<=0n)throw new ApiError(400,'bad_request','Credit amount must be greater than zero');
 const endsAt=new Date(Date.now()+days*86400000);if(endsAt.getTime()<=Date.now())throw new ApiError(400,'bad_request','Credit expiry must be in the future');
 await expireGrants(pool,orgId);
 await transaction(pool,async tx=>{
  const key=`trial-grant:${orgId}`;
  const existing=(await tx.query('SELECT id,"orgId" FROM "CreditLedgerEntry" WHERE "idempotencyKey"=$1',[key])).rows[0];
  if(existing){if(existing.orgId!==orgId)throw new ApiError(409,'conflict','Credit idempotency key belongs to another organization');return;}
  const account=await ensureAccount(tx,orgId);const balance=BigInt(account.balance)+amount;if(balance>9223372036854775807n)throw new ApiError(409,'conflict','Credit balance exceeds the supported maximum');
  const grantId=createId();const reference=`trial:${orgId}`;const metadata={trialDurationDays:days};
  await tx.query('INSERT INTO "CreditGrant"(id,"accountId","orgId",source,amount,"remainingAmount","startsAt","endsAt",reason,reference,metadata,"createdAt","updatedAt") VALUES($1,$2,$3,\'TRIAL\',$4,$4,NOW(),$5,$6,$7,$8,NOW(),NOW())',[grantId,account.id,orgId,amount.toString(),endsAt,'Initial workspace trial credits',reference,metadata]);
  await tx.query('UPDATE "CreditAccount" SET balance=$1,"updatedAt"=NOW() WHERE id=$2',[balance.toString(),account.id]);
  await tx.query('INSERT INTO "CreditLedgerEntry"(id,"accountId","orgId","grantId",type,amount,"balanceAfter","sourceType","sourceId","idempotencyKey",metadata,"createdAt") VALUES($1,$2,$3,$4,\'GRANT\',$5,$6,\'SYSTEM\',$7,$8,$9,NOW())',[createId(),account.id,orgId,grantId,amount.toString(),balance.toString(),reference,key,metadata]);
 });
}
export async function sendOrganizationEmail(context: CoreContext,to: string,subject: string,text: string): Promise<void> {
 const sink=context.config.env.LOCAL_MAILPIT_URL;
 if(context.config.environment.toLowerCase()!=='production'&&sink){let url: URL;try{url=new URL(sink);}catch{throw new ApiError(400,'bad_request','Invalid local mail sink URL');}if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw new ApiError(400,'bad_request','Local mail sink must use loopback');const response=await fetch(`${sink.replace(/\/$/,'')}/api/v1/send`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({From:{Email:'growth@kasitek.local',Name:'KasiTek Growth'},To:[{Email:to}],Subject:subject,Text:text})});if(!response.ok)throw new ApiError(503,'service_unavailable','Local email delivery failed');return;}
 const key=context.config.env.AUTH_RESEND_KEY;if(!key)throw new ApiError(503,'service_unavailable','Email delivery is not configured');
 const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{authorization:`Bearer ${key}`,'content-type':'application/json'},body:JSON.stringify({from:context.config.env.RESEND_FROM_EMAIL??'KasiTek <noreply@kasitek.co.za>',to:[to],subject,text})});if(![200,201].includes(response.status))throw new ApiError(500,'internal_error','Failed to send email');
}
export const MAX_LOGO_BYTES=5*1024*1024;
export function logoMime(bytes: Buffer): string|undefined {if(bytes.subarray(0,3).equals(Buffer.from([255,216,255])))return 'image/jpeg';if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';if(bytes.length>=12&&bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')return 'image/webp';if(['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString()))return 'image/gif';return undefined;}
export function validateLogo(bytes: Buffer,mime: string): void {if(bytes.length>MAX_LOGO_BYTES)throw new ApiError(400,'bad_request','Organization logos must be 5 MB or smaller');if(!bytes.length)throw new ApiError(400,'bad_request','The logo file cannot be empty');if(!['image/jpeg','image/png','image/webp','image/gif'].includes(mime))throw new ApiError(400,'bad_request','Use a PNG, JPEG, WebP, or GIF image for the organization logo');if(logoMime(bytes)!==mime)throw new ApiError(400,'bad_request','The file contents do not match the declared image format');}
function logoPath(context: CoreContext,orgId: string): string {const root=resolve(context.config.mediaStoragePath);const target=join(root,'organization-logos',`${orgId}.image`);const path=relative(root,target);if(path==='..'||path.startsWith(`..${sep}`))throw new ApiError(500,'internal_error','Invalid organization logo path');return target;}
export async function storeLogo(context: CoreContext,orgId: string,bytes: Buffer,mime: string): Promise<OrgRow> {validateLogo(bytes,mime);const path=logoPath(context,orgId);try{await mkdir(dirname(path),{recursive:true});}catch{throw new ApiError(500,'internal_error','Failed to prepare logo storage');}const temporary=path.replace(/\.image$/,`.upload-${createId()}`);try{await writeFile(temporary,bytes);await rename(temporary,path);}catch{await unlink(temporary).catch(()=>{});throw new ApiError(500,'internal_error','Failed to publish logo storage object');}return updateOrg(context.pool,orgId,null,`/api/orgs/${orgId}/logo?v=${createId()}`);}
export async function loadLogo(context: CoreContext,orgId: string): Promise<{bytes: Buffer;mime: string}> {let bytes: Buffer;try{bytes=await readFile(logoPath(context,orgId));}catch(error){if(error instanceof ApiError)throw error;throw new ApiError(404,'not_found','Organization logo not found');}const mime=logoMime(bytes);if(!mime)throw new ApiError(404,'not_found','Organization logo is not available');return {bytes,mime};}

import { coreProducerConfig, buildScopeDefinition, enqueueOutbox } from '@kasitek/server-support/analytics-producer';
export async function enqueueOrganizationScope(tx: PoolClient,orgId: string,sourceVersion: number,reportingTimezone: string,status: string): Promise<void> {const recordId=`core-scope:organization:${orgId}:${sourceVersion}`;const record=buildScopeDefinition(coreProducerConfig(),{record_id:recordId,source_domain:'scopes',source_stream_key:`organization:${orgId}:scopes`,contract_name:'core.scope.definition@1',schema_version:1,scope_kind:'core_organization',scope_external_id:orgId,parent_scope_external_id:null,reporting_timezone:reportingTimezone,status,source_version:sourceVersion,idempotency_key:recordId});await enqueueOutbox(tx,record);}
