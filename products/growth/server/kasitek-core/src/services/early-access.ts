import { createId } from '@paralleldrive/cuid2';
import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { ApiError } from '../error.js';
import { EARLY_ACCESS_SQL as sql } from './early-access-sql.js';
import type { CoreContext } from '../context.js';
import { sendOrganizationEmail } from './org-support.js';
import { createManualGrant, expireManualGrant } from './billing.js';
import { grantSystemCredits, revokeUnspentSystemGrant } from './credits.js';
import { createOrg, deleteOrg, requireAdmin, slugify, uniqueSlug } from './orgs.js';
import { publishAdminNotification } from './admin-notification-publisher.js';

export const BETA_PACKAGE_KEY = 'beta-2026-01';
export const DEFAULT_CAPABILITIES = [
  'feature.analytics.view', 'feature.inbox.access', 'feature.agents.manage',
  'feature.campaigns.manage', 'feature.content.manage',
] as const;
export type ApplicationStatus = 'new' | 'approved' | 'invited' | 'active' | 'rejected' | 'expired' | 'revoked';
const transitions: Record<ApplicationStatus, readonly ApplicationStatus[]> = {
  new: ['approved', 'rejected'], approved: ['invited', 'active', 'revoked'],
  invited: ['active', 'revoked', 'expired'], active: ['expired', 'revoked'],
  rejected: [], expired: [], revoked: ['approved', 'invited', 'active'],
};
export function transitionAllowed(from: string, to: string): boolean {
  return Object.hasOwn(transitions, from) && transitions[from as ApplicationStatus].includes(to as ApplicationStatus);
}
export function boundedText(value: string | null | undefined, field: string, max: number): string | null {
  const result = value?.trim() || null;
  if (result !== null && Buffer.byteLength(result, 'utf8') > max) {
    throw new ApiError(400, 'bad_request', `${field} must be at most ${max} characters`);
  }
  return result;
}
export function requiredText(value: string | null | undefined, field: string, max: number): string {
  const result = boundedText(value, field, max);
  if (result === null) throw new ApiError(400, 'bad_request', `${field} is required`);
  return result;
}
export function selectedCapabilities(keys?: string[] | null): string[] {
  const selected: string[] = [];
  for (const raw of keys ?? DEFAULT_CAPABILITIES) {
    const key = raw.trim();
    if (!key || selected.includes(key)) continue;
    if (!(DEFAULT_CAPABILITIES as readonly string[]).includes(key)) {
      throw new ApiError(400, 'bad_request', `Unsupported early-access capability: ${key}`);
    }
    selected.push(key);
  }
  if (!selected.length) throw new ApiError(400, 'bad_request', 'At least one capability is required');
  return selected;
}
export function validPackageKey(key?: string | null): string {
  const clean = key?.trim();
  if (clean && clean !== BETA_PACKAGE_KEY) throw new ApiError(400, 'bad_request', 'Unsupported early-access package');
  return BETA_PACKAGE_KEY;
}
export function betaPackageSnapshot() {
  return { key: BETA_PACKAGE_KEY, durationDays: 30, credits: 1000, capabilities: [...DEFAULT_CAPABILITIES] };
}
export function packageParameters(snapshot: unknown): { durationDays: number; credits: bigint; capabilities: string[] } {
  if (snapshot == null) throw new ApiError(409, 'conflict', 'The approved early-access package is missing');
  const row = typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot as Record<string, unknown> : {};
  if (typeof row.key !== 'string') throw new ApiError(409, 'conflict', 'The approved early-access package is invalid');
  validPackageKey(row.key);
  const integer = (value: unknown, max: number, message: string): bigint => {
    const number = typeof value === 'bigint' ? value : typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : null;
    if (number === null || number < 1n || number > BigInt(max)) throw new ApiError(409, 'conflict', message);
    return number;
  };
  const days = integer(row.durationDays, 365, 'The early-access duration is invalid');
  const credits = integer(row.credits, 1_000_000, 'The early-access credit allocation is invalid');
  if (!Array.isArray(row.capabilities)) throw new ApiError(409, 'conflict', 'The early-access capabilities are invalid');
  // Rust filters non-string JSON values before validating the remaining capability keys.
  return { durationDays: Number(days), credits,
    capabilities: selectedCapabilities(row.capabilities.filter((key): key is string => typeof key === 'string')) };
}

export async function expireDueInvitations(pool: Pool): Promise<void> {
  await pool.query(sql.expire_due_invitations[0]);
}
export async function markInvitationDelivery(pool: Pool, invitationId: string, delivered: boolean): Promise<void> {
  await pool.query(sql.mark_invitation_delivery[0], [delivered ? 'sent' : 'failed',
    delivered ? null : 'EMAIL_DELIVERY_FAILED', invitationId]);
}
export async function releaseActivationClaim(pool: Pool, invitationId: string): Promise<void> {
  // Source cleanup is best effort; it must not replace the activation's original failure.
  try { await pool.query(sql.release_activation_claim[0], [invitationId]); } catch { /* preserve original error */ }
}
export async function signupInvitationPreview(pool: Pool, token: string): Promise<Record<string, unknown>> {
  await expireDueInvitations(pool);
  const hash = createHash('sha256').update(token).digest('hex');
  const row = (await pool.query(sql.signup_invitation_preview[0], [hash])).rows[0];
  if (!row) throw new ApiError(404, 'not_found', 'Early-access invitation not found');
  return camel(row);
}
export async function recordEvent(pool: Pool, applicationId: string, fromStatus: string | null,
  toStatus: string, action: string, actorId: string | null, reason: string | null, metadata: unknown): Promise<void> {
  await pool.query(sql.record_event[0], [createId(), applicationId, fromStatus, toStatus, action, actorId, reason, metadata]);
}
export async function recordSubmission(pool: Pool, applicationId: string): Promise<void> {
  await recordEvent(pool, applicationId, null, 'new', 'submitted', null, null, {});
}

function camel(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase()), value]));
}
export interface EarlyAccessApplication extends Record<string, unknown> { id: string; status: string }
export async function getApplication(pool: Pool, applicationId: string): Promise<{ application: EarlyAccessApplication; events: Record<string, unknown>[] }> {
  const row = (await pool.query(sql.application_select[0] + ' WHERE id = $1', [applicationId])).rows[0];
  if (!row) throw new ApiError(404, 'not_found', 'Early-access application not found');
  const events = (await pool.query(sql.get_application[0], [applicationId])).rows.map(camel);
  return { application: camel(row) as EarlyAccessApplication, events };
}
export async function rejectApplication(pool: Pool, applicationId: string, actorId: string, input: { reason?: string | null }): Promise<EarlyAccessApplication> {
  const reason = requiredText(input.reason, 'Rejection reason', 2000);
  const { application } = await getApplication(pool, applicationId);
  if (application.status === 'rejected') return application;
  if (!transitionAllowed(application.status, 'rejected')) {
    throw new ApiError(409, 'conflict', `Cannot reject an early-access application from ${application.status}`);
  }
  await pool.query(sql.reject_application[0], ['rejected', reason, actorId, applicationId]);
  await recordEvent(pool, applicationId, application.status, 'rejected', 'rejected', actorId, reason, {});
  return (await getApplication(pool, applicationId)).application;
}

export function selfServiceEnabled(core: CoreContext): boolean {
  return !['0', 'false', 'no', 'off'].includes(core.config.env.EARLY_ACCESS_SELF_SERVICE_ENABLED?.toLowerCase() ?? '');
}
async function createSignupInvitation(core: CoreContext, application: EarlyAccessApplication, actorId: string): Promise<EarlyAccessApplication> {
  if (!selfServiceEnabled(core)) throw new ApiError(409, 'conflict', 'Early-access self-service is disabled');
  const pool = core.pool;
  await pool.query(sql.create_signup_invitation[0], [application.id]);
  const token = randomBytes(48).toString('base64url'), invitationId = createId();
  const expiresAt = new Date(Date.now() + 7 * 86400000);
  await pool.query(sql.create_signup_invitation[1], [invitationId, application.id, application.email,
    createHash('sha256').update(token).digest('hex'), expiresAt, actorId]);
  const fromStatus = application.status;
  await pool.query(sql.create_signup_invitation[2], [actorId, invitationId, BETA_PACKAGE_KEY, betaPackageSnapshot(), application.id]);
  if (!['approved', 'invited'].includes(fromStatus)) {
    await recordEvent(pool, application.id, fromStatus, 'approved', fromStatus === 'revoked' ? 'restored' : 'approved', actorId, null,
      { packageKey: BETA_PACKAGE_KEY });
  }
  const url = `${core.config.frontendUrl.replace(/\/+$/, '')}/early-access/${token}`;
  let delivered = false;
  try {
    await sendOrganizationEmail(core, String(application.email), 'Your KasiTek early access is approved',
      `Your early access is approved. Create or sign in to your account here:\n${url}\n\nThis link expires in 7 days.`);
    delivered = true;
  } catch { /* Delivery failure is persisted, and the operator can resend. */ }
  await markInvitationDelivery(pool, invitationId, delivered);
  if (delivered) {
    await pool.query(sql.create_signup_invitation[3], [application.id]);
    await recordEvent(pool, application.id, fromStatus === 'invited' ? 'invited' : 'approved', 'invited',
      fromStatus === 'invited' ? 'invite_resent' : 'invited', actorId, null, { invitationId });
  }
  return (await getApplication(pool, application.id)).application;
}
export async function approveApplication(core: CoreContext, applicationId: string, actorId: string,
  input: { packageKey?: string | null }): Promise<EarlyAccessApplication> {
  validPackageKey(input.packageKey);
  const { application } = await getApplication(core.pool, applicationId);
  if (['rejected', 'revoked', 'expired'].includes(application.status)) {
    throw new ApiError(409, 'conflict', `Cannot approve an application in ${application.status} state`);
  }
  if (application.status === 'active') return application;
  if (typeof application.earlyAccessInvitationId === 'string') {
    const pending = (await core.pool.query(sql.approve_self_service_application[0], [application.earlyAccessInvitationId])).rows[0]?.exists;
    if (pending) return application;
  }
  return createSignupInvitation(core, application, actorId);
}
export async function resendInvitation(core: CoreContext, applicationId: string, actorId: string): Promise<EarlyAccessApplication> {
  const { application } = await getApplication(core.pool, applicationId);
  if (!['approved', 'invited'].includes(application.status)) {
    throw new ApiError(409, 'conflict', 'Only approved or invited applications can be resent');
  }
  return createSignupInvitation(core, application, actorId);
}
export async function restoreApplication(core: CoreContext, applicationId: string, actorId: string, reasonInput: string): Promise<EarlyAccessApplication> {
  const reason = requiredText(reasonInput, 'Restoration reason', 2000);
  const { application } = await getApplication(core.pool, applicationId);
  if (application.status !== 'revoked') throw new ApiError(409, 'conflict', 'Only revoked applications can have access restored');
  await core.pool.query(sql.restore_application[0], [reason, applicationId]);
  await recordEvent(core.pool, applicationId, 'revoked', 'approved', 'restored', actorId, reason, {});
  return createSignupInvitation(core, (await getApplication(core.pool, applicationId)).application, actorId);
}
export async function batchApprove(core: CoreContext, actorId: string, input: { applicationIds: string[]; packageKey?: string | null }) {
  validPackageKey(input.packageKey);
  const ids = input.applicationIds;
  if (!ids.length || ids.length > 100) throw new ApiError(400, 'bad_request', 'Select between 1 and 100 applications');
  if (ids.some((id) => !id.trim()) || new Set(ids).size !== ids.length) throw new ApiError(400, 'bad_request', 'Application IDs must be unique');
  const result = { requested: ids.length, approved: 0, invited: 0, alreadyProcessed: 0, failed: 0,
    results: [] as { id: string; outcome: string; status: string; errorCode: string | null }[] };
  for (const id of ids) {
    try {
      const application = await approveApplication(core, id, actorId, { packageKey: BETA_PACKAGE_KEY });
      const failed = application.invitationDeliveryStatus === 'failed';
      const outcome = failed ? 'failed' : application.status === 'invited' ? 'invited' : 'approved';
      result[outcome] += 1;
      result.results.push({ id, outcome, status: application.status, errorCode: failed ? 'EMAIL_DELIVERY_FAILED' : null });
    } catch (error) {
      const skipped = error instanceof ApiError && error.status === 409;
      if (skipped) result.alreadyProcessed += 1; else result.failed += 1;
      result.results.push({ id, outcome: skipped ? 'skipped' : 'failed', status: 'unchanged',
        errorCode: skipped ? 'NOT_APPROVABLE' : 'APPROVAL_FAILED' });
    }
  }
  return result;
}
async function ensureEntitlement(pool: Pool, orgId: string, key: string, endsAt: Date, reason: string, actorId: string): Promise<string> {
  const existing = (await pool.query(sql.ensure_entitlement_grant[0], [orgId, key, reason])).rows[0]?.id;
  return typeof existing === 'string' ? existing : String((await createManualGrant(pool, orgId, key, true, endsAt, reason, actorId)).id);
}
// The original service serializes activation in-process, then claims the invitation atomically in PostgreSQL.
let activationTail: Promise<void> = Promise.resolve();
export async function activateInvitation(core: CoreContext, token: string, userId: string,
  input: { organizationId?: string | null; workspaceName?: string | null }): Promise<EarlyAccessApplication> {
  const previous = activationTail;
  let unlock!: () => void;
  activationTail = new Promise<void>((resolve) => { unlock = resolve; });
  await previous;
  try { return await activateClaimedInvitation(core, token, userId, input); } finally { unlock(); }
}
async function activateClaimedInvitation(core: CoreContext, token: string, userId: string,
  input: { organizationId?: string | null; workspaceName?: string | null }): Promise<EarlyAccessApplication> {
  const pool = core.pool;
  await expireDueInvitations(pool);
  const invitation = (await pool.query(sql.activate_signup_invitation[0], [createHash('sha256').update(token).digest('hex')])).rows[0];
  const invalid = () => new ApiError(409, 'conflict', 'This invitation is invalid, expired, or already used');
  if (!invitation) throw invalid();
  const user = (await pool.query(sql.activate_signup_invitation[1], [userId])).rows[0];
  if (!user) throw new ApiError(500, 'internal_error', 'Database operation failed');
  // Rust eq_ignore_ascii_case compares only ASCII case.
  const asciiLower = (text: string) => text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  if (asciiLower(user.email) !== asciiLower(invitation.email)) throw new ApiError(403, 'forbidden', 'Sign in with the approved email address');
  const { application } = await getApplication(pool, invitation.waitlistEntryId);
  if (invitation.status === 'accepted') {
    if (application.status === 'active' && application.organizationId != null) return application;
    throw new ApiError(409, 'conflict', 'This invitation was accepted but activation did not complete');
  }
  if (invitation.status !== 'pending' || invitation.expires_at.getTime() <= Date.now()) throw invalid();
  const existingOrg = input.organizationId?.trim() || null;
  let name: string | null = null, slug: string | null = null;
  if (existingOrg) await requireAdmin(pool, existingOrg, userId);
  else {
    name = requiredText(input.workspaceName, 'Workspace name', 80);
    slug = await uniqueSlug(pool, slugify(name));
  }
  const { durationDays, credits, capabilities } = packageParameters(application.packageSnapshot);
  const claimed = await pool.query(sql.activate_signup_invitation[2], [invitation.id]);
  if (!claimed.rows.length) throw invalid();
  let orgId: string;
  const created = existingOrg === null;
  if (existingOrg) orgId = existingOrg;
  else {
    try { orgId = (await createOrg(core, userId, name!, slug!, null, 0n, durationDays)).id; }
    catch (error) { await releaseActivationClaim(pool, invitation.id); throw error; }
  }
  const cleanup = async () => {
    if (created) { try { await deleteOrg(pool, orgId); } catch { /* source cleanup remains best effort */ } }
    await releaseActivationClaim(pool, invitation.id);
  };
  const endsAt = new Date(Date.now() + durationDays * 86400000), reason = `Early-access package ${BETA_PACKAGE_KEY}`;
  const grants: string[] = [];
  try {
    for (const key of capabilities) grants.push(await ensureEntitlement(pool, orgId, key, endsAt, reason, userId));
  } catch (error) { await cleanup(); throw error; }
  let credit: Record<string, unknown>;
  try {
    credit = await grantSystemCredits(pool, orgId, credits, 'EARLY_ACCESS', endsAt, reason, userId,
      { applicationId: application.id, packageKey: BETA_PACKAGE_KEY }, `early-access-credits:${application.id}`);
  } catch (error) { await cleanup(); throw error; }
  // SQL errors propagate at this step, matching the source's claim semantics.
  const updated = await pool.query(sql.activate_signup_invitation[3], [orgId, endsAt, JSON.stringify(grants), credit.grantId, application.id]);
  if (updated.rowCount !== 1) {
    await cleanup();
    throw new ApiError(409, 'conflict', 'This application is no longer available for activation');
  }
  try { await recordEvent(pool, application.id, application.status, 'active', 'activated', userId, null,
    { organizationId: orgId, packageKey: BETA_PACKAGE_KEY }); } catch { /* successful activation remains successful */ }
  return (await getApplication(pool, application.id)).application;
}
export async function revokeApplication(pool: Pool, applicationId: string, actorId: string, reasonInput: string): Promise<EarlyAccessApplication> {
  const reason = requiredText(reasonInput, 'Revocation reason', 2000);
  const { application } = await getApplication(pool, applicationId);
  if (application.status === 'revoked') return application;
  if (!['approved', 'invited', 'active'].includes(application.status)) throw new ApiError(409, 'conflict', 'Only approved, invited, or active access can be revoked');
  await pool.query(sql.revoke_application[0], [applicationId]);
  const orgId = application.organizationId;
  if (typeof orgId === 'string') {
    const grants = Array.isArray(application.entitlementGrantIds) ? application.entitlementGrantIds : [];
    for (const grant of grants) {
      if (typeof grant === 'string') { try { await expireManualGrant(pool, orgId, grant); } catch { /* source best effort */ } }
    }
    if (typeof application.creditGrantId === 'string') {
      try { await revokeUnspentSystemGrant(pool, orgId, application.creditGrantId, reason,
        `early-access-revoke:${applicationId}:${application.creditGrantId}`); } catch { /* source best effort */ }
    }
  }
  await pool.query(sql.revoke_application[1], [reason, applicationId]);
  await recordEvent(pool, applicationId, application.status, 'revoked', 'revoked', actorId, reason, {});
  try { await publishAdminNotification(pool, 'early_access.revoked', 'Early access revoked',
    `Early access for ${application.businessName} was revoked.`, 'product_waitlist_entry', applicationId,
    { organizationId: application.organizationId }, `early_access.revoked:${applicationId}`); } catch { /* source best effort */ }
  return (await getApplication(pool, applicationId)).application;
}
export async function expireDueAccess(pool: Pool): Promise<void> {
  const applications = (await pool.query(sql.expire_due_access[0])).rows;
  for (const application of applications) {
    if (!transitionAllowed(application.status, 'expired')) continue;
    await pool.query(sql.expire_due_access[1], [application.id, application.status]);
    await recordEvent(pool, application.id, application.status, 'expired', 'expired', null, 'Early-access period ended', {});
    try { await publishAdminNotification(pool, 'early_access.expired', 'Early access expired',
      `Early access for ${application.coalesce} has ended.`, 'product_waitlist_entry', application.id, {},
      `early_access.expired:${application.id}`); } catch { /* source best effort */ }
  }
}
export async function statusForOrg(pool: Pool, orgId: string): Promise<Record<string, unknown> | null> {
  await expireDueAccess(pool);
  const row = (await pool.query(sql.status_for_org[0], [orgId])).rows[0];
  return row ? { applicationId: row.id, status: row.status, endsAt: row.earlyAccessEndsAt, activatedAt: row.activatedAt } : null;
}
export async function listApplications(pool: Pool, input: { status?: string | null; search?: string | null; cohort?: string | null; limit?: number | bigint | null }) {
  await expireDueInvitations(pool);
  await expireDueAccess(pool);
  const status = input.status?.trim() || null, search = input.search?.trim() || null, cohort = input.cohort?.trim() || null;
  if (status && !Object.hasOwn(transitions, status)) throw new ApiError(400, 'bad_request', 'Invalid early-access status filter');
  if (cohort && (Buffer.byteLength(cohort) > 80 || !/^[a-zA-Z0-9_-]+$/.test(cohort))) throw new ApiError(400, 'bad_request', 'Invalid early-access cohort filter');
  const requested = BigInt(input.limit ?? 100), limit = Number(requested < 1n ? 1n : requested > 200n ? 200n : requested);
  const query = sql.application_select[0] + ` WHERE ($1::text IS NULL OR status=$1)
    AND ($2::text IS NULL OR "businessName" ILIKE '%'||$2||'%' OR "contactPerson" ILIKE '%'||$2||'%' OR email ILIKE '%'||$2||'%')
    AND ($3::text IS NULL OR cohort=$3) ORDER BY "createdAt" DESC LIMIT $4`;
  return (await pool.query(query, [status, search, cohort, limit])).rows.map(camel);
}
