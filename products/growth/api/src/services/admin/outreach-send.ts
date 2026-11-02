import type { Pool } from 'pg';
import { createId } from '@paralleldrive/cuid2';
import { createHash } from 'node:crypto';
import { ApiError } from '../../error.js';
import { transaction, obj, requireString, bad, missing } from './common.js';

type Attempt = { id: string; campaignId: string; leadId: string; fingerprint: string; recipients: string[]; rejected: string[]; subject: string; status: string };
const emails = (value: unknown): string[] => {
  if (!Array.isArray(value) || value.length > 100 || value.some(v => typeof v !== 'string' || !/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(v))) bad('Invalid recipients');
  return [...new Set((value as string[]).map(v => v.toLowerCase()))].sort();
};
export async function claimSend(pool: Pool, actorId: string, campaignId: string, leadId: string, raw: unknown) {
  const body = obj(raw), original = requireString(body, 'fingerprint'), recipients = emails(body.recipients), subject = requireString(body, 'subject');
  if (!/^[a-f0-9]{64}$/.test(original) || !recipients.length || !subject || subject.length > 998) bad('Invalid send claim');
  return transaction(pool, async tx => {
    if (!(await tx.query('SELECT id FROM "OutreachLead" WHERE id=$1 AND "campaignId"=$2 FOR UPDATE', [leadId,campaignId])).rows.length) missing('Lead not found');
    let fingerprint=original;
    if (typeof body.retryOf==='string') {
      const prior=(await tx.query<Attempt>('SELECT * FROM "AdminOutreachSendAttempt" WHERE id=$1 AND "leadId"=$2',[body.retryOf,leadId])).rows[0];
      if (!prior || !['rejected','not_submitted','partial'].includes(prior.status)) bad('Retry requires confirmed non-submission or rejection');
      if (prior.status==='partial' && recipients.some(recipient=>!prior.rejected.includes(recipient))) bad('Retry can include only rejected recipients');
      fingerprint=createHash('sha256').update(`${original}:${prior.id}`).digest('hex');
    }
    const existing = (await tx.query('SELECT * FROM "AdminOutreachSendAttempt" WHERE fingerprint=$1 OR ("leadId"=$2 AND status IN (\'submitting\',\'uncertain\')) ORDER BY "createdAt" DESC LIMIT 1', [fingerprint,leadId])).rows[0];
    if (existing) throw new ApiError(409,'send_attempt_exists',`Send attempt ${existing.id} is ${existing.status}; reconcile before retrying`);
    const id=createId();
    const row=(await tx.query('INSERT INTO "AdminOutreachSendAttempt" (id,"campaignId","leadId",fingerprint,"actorId",recipients,subject,status) VALUES ($1,$2,$3,$4,$5,$6,$7,\'submitting\') RETURNING *',[id,campaignId,leadId,fingerprint,actorId,JSON.stringify(recipients),subject])).rows[0];
    await tx.query('UPDATE "OutreachLead" SET "emailStatus"=\'submitting\',"updatedAt"=NOW() WHERE id=$1',[leadId]);
    await tx.query('INSERT INTO "AdminCommercialAudit" (id,"actorId",action,"resourceId",details) VALUES ($1,$2,$3,$4,$5)',[createId(),actorId,'outreach.claim',id,JSON.stringify({retryOf:body.retryOf ?? null})]);
    return row;
  });
}
export async function listSendAttempts(pool: Pool, campaignId: string, leadId: string) {
  return (await pool.query('SELECT * FROM "AdminOutreachSendAttempt" WHERE "campaignId"=$1 AND "leadId"=$2 ORDER BY "createdAt" DESC LIMIT 100',[campaignId,leadId])).rows;
}
export async function completeSend(pool: Pool, actorId: string, attemptId: string, raw: unknown, reconcile=false) {
  const body=obj(raw), accepted=emails(body.accepted ?? []), rejected=emails(body.rejected ?? []);
  const evidence=typeof body.evidence==='string' ? body.evidence.trim() : '';
  if (reconcile && (!evidence || evidence.length>2000)) bad('Reconciliation evidence is required (maximum 2000 characters)');
  return transaction(pool, async tx => {
    const attempt=(await tx.query<Attempt>('SELECT * FROM "AdminOutreachSendAttempt" WHERE id=$1 FOR UPDATE',[attemptId])).rows[0] ?? missing('Send attempt not found');
    if (!['submitting','uncertain'].includes(attempt.status)) throw new ApiError(409,'send_attempt_final','Attempt is already finalized');
    if (accepted.some(v=>!attempt.recipients.includes(v)) || rejected.some(v=>!attempt.recipients.includes(v) || accepted.includes(v))) bad('Recipient outcome mismatch');
    if (body.notSubmitted===true && (accepted.length || rejected.length)) bad('Non-submission cannot include SMTP outcomes');
    const known=accepted.length+rejected.length===attempt.recipients.length;
    const status=body.notSubmitted===true && reconcile ? 'not_submitted' : !known ? 'uncertain' : accepted.length===0 ? 'rejected' : rejected.length ? 'partial' : 'accepted';
    const messageId=typeof body.messageId==='string' ? body.messageId.slice(0,998) : null;
    const updated=(await tx.query('UPDATE "AdminOutreachSendAttempt" SET status=$1,accepted=$2,rejected=$3,"providerMessageId"=$4,"updatedAt"=NOW() WHERE id=$5 RETURNING *',[status,JSON.stringify(accepted),JSON.stringify(rejected),messageId,attemptId])).rows[0];
    for (const recipient of attempt.recipients) {
      const state=accepted.includes(recipient)?'accepted':rejected.includes(recipient)?'rejected':status==='not_submitted'?'not_submitted':'uncertain';
      await tx.query('INSERT INTO "OutreachEmailDeliveryLog" (id,"campaignId","leadId",recipient,subject,status,provider,"providerMessageId","attemptedAt","isTest") VALUES ($1,$2,$3,$4,$5,$6,\'smtp\',$7,NOW(),$8)',[createId(),attempt.campaignId,attempt.leadId,recipient,attempt.subject,state,messageId,attempt.campaignId==='admin-system-test-sends']);
    }
    await tx.query('UPDATE "OutreachLead" SET "emailStatus"=$1,"emailSentAt"=CASE WHEN $2 THEN NOW() ELSE "emailSentAt" END,"updatedAt"=NOW() WHERE id=$3',[status,accepted.length>0,attempt.leadId]);
    await tx.query('INSERT INTO "AdminCommercialAudit" (id,"actorId",action,"resourceId",details) VALUES ($1,$2,$3,$4,$5)',[createId(),actorId,reconcile?'outreach.reconcile':'outreach.smtp_result',attemptId,JSON.stringify({status,evidence:reconcile?evidence:undefined})]);
    return updated;
  });
}

export async function ensureTestRecipient(pool: Pool, raw: unknown) {
  const recipient=emails([obj(raw).email])[0]!;
  return transaction(pool,async tx=>{
    const campaignId='admin-system-test-sends';
    const leadId=`admin-test-${createHash('sha256').update(recipient).digest('hex')}`;
    await tx.query('INSERT INTO "OutreachCampaign" (id,name,category,status,"totalLeads","emailsSent",replies,"createdAt","updatedAt") VALUES ($1,\'System Test Sends\',\'system-test\',\'active\',0,0,0,NOW(),NOW()) ON CONFLICT (id) DO NOTHING',[campaignId]);
    await tx.query('INSERT INTO "OutreachLead" (id,"campaignId","businessName",category,"emailAddress","emailStatus","followUpCount","createdAt","updatedAt") VALUES ($1,$2,\'SMTP test recipient\',\'system-test\',$3,\'pending\',0,NOW(),NOW()) ON CONFLICT (id) DO NOTHING',[leadId,campaignId,recipient]);
    return {campaignId,leadId};
  });
}
