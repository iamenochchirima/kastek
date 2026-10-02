import { createId } from '@paralleldrive/cuid2';
import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { ApiError } from '../error.js';
import { EARLY_ACCESS_SQL as sql } from './early-access-sql.js';

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
