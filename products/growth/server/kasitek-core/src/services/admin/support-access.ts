import type { Pool } from 'pg';
import { createId } from '@paralleldrive/cuid2';
import type { AdminUser } from '../../identity/admin-session.js';
import * as sql from './support_access-sql.js';
import {
  bad,
  missing,
  byteLength,
  requireString,
  json,
  type ObjectValue,
} from './common.js';
export function validateSupportGrant(input: ObjectValue) {
  const resourceType = requireString(input, 'resourceType').trim(),
    resourceId =
      typeof input.resourceId === 'string' ? input.resourceId.trim() : '';
  if (
    !['organization', 'conversation', 'customer', 'run'].includes(resourceType)
  )
    bad('resourceType must be organization, conversation, customer, or run');
  if ((resourceType === 'organization') !== (resourceId === ''))
    bad('organization grants omit resourceId; narrower grants require it');
  const reason = requireString(input, 'reason').trim();
  if (byteLength(reason) < 8 || byteLength(reason) > 500)
    bad('reason must be 8-500 characters');
  const rawDuration = input.durationMinutes;
  if (
    typeof rawDuration !== 'bigint' &&
    (typeof rawDuration !== 'number' || !Number.isSafeInteger(rawDuration))
  )
    bad('Invalid request');
  const duration = Number(rawDuration);
  if (!Number.isInteger(duration) || duration < 1 || duration > 60)
    bad('durationMinutes must be between 1 and 60');
  const adminId = requireString(input, 'adminId').trim(),
    organizationId = requireString(input, 'organizationId').trim();
  if (!adminId || !organizationId)
    bad('adminId and organizationId are required');
  return {
    resourceType,
    resourceId,
    reason,
    duration,
    adminId,
    organizationId,
  };
}
async function audit(
  pool: Pool,
  id: string,
  actorId: string,
  action: string,
  metadata: ObjectValue,
) {
  await pool.query(sql.RECORD_AUDIT_0, [
    createId(),
    id,
    actorId,
    action,
    json(metadata),
  ]);
}
export async function createSupportGrant(
  pool: Pool,
  actor: AdminUser,
  input: ObjectValue,
) {
  const data = validateSupportGrant(input),
    grant = (
      await pool.query(sql.CREATE_0, [
        createId(),
        data.adminId,
        data.organizationId,
        data.resourceType,
        data.resourceId,
        data.reason,
        actor.id.trim(),
        new Date(Date.now() + data.duration * 60_000),
      ])
    ).rows[0]!;
  await audit(pool, grant.id, actor.id, 'granted', {
    organizationId: grant.organizationId,
    resourceType: grant.resourceType,
    resourceId: grant.resourceId,
    expiresAt: grant.expiresAt,
  });
  return grant;
}
export async function listSupportGrants(
  pool: Pool,
  organizationId: string | null,
) {
  return (await pool.query(sql.LIST_0, [organizationId])).rows;
}
export async function revokeSupportGrant(
  pool: Pool,
  actor: AdminUser,
  id: string,
) {
  const grant =
    (await pool.query(sql.REVOKE_0, [id.trim()])).rows[0] ??
    missing('active support grant not found');
  await audit(pool, grant.id, actor.id, 'revoked', {
    organizationId: grant.organizationId,
    resourceType: grant.resourceType,
    resourceId: grant.resourceId,
  });
  return grant;
}
export async function supportAllows(
  pool: Pool,
  adminId: string,
  organizationId: string,
  resourceType: string,
  resourceId: string | null,
) {
  return Boolean(
    (
      await pool.query(sql.ALLOWS_0, [
        adminId,
        organizationId,
        resourceType,
        resourceId,
      ])
    ).rows[0]?.exists,
  );
}
