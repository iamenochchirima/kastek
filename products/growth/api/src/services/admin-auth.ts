import { createId } from '@paralleldrive/cuid2';
import { compare, hash } from 'bcryptjs';
import type { CoreContext } from '../context.js';
import { ApiError } from '../error.js';
import type { AdminUser } from '../identity/admin-session.js';
import { sendOrganizationEmail } from './org-support.js';

const bad = (message: string): ApiError => new ApiError(400, 'bad_request', message);
export const resetIdentifier = (adminId: string): string => `admin-password-reset:${adminId}`;

export async function issueVerificationToken(context: CoreContext, identifier: string): Promise<string> {
  const token = `${createId()}${createId()}`;
  await context.pool.query('DELETE FROM "VerificationToken" WHERE identifier=$1', [identifier]);
  await context.pool.query('INSERT INTO "VerificationToken" (identifier,token,expires) VALUES ($1,$2,NOW()+INTERVAL \'24 hours\')', [identifier, token]);
  return token;
}

export async function requestAdminPasswordReset(context: CoreContext, value: string | undefined): Promise<void> {
  const email = (value ?? '').trim().toLowerCase();
  if (!email) throw bad('Email is required');
  const result = await context.pool.query<AdminUser>('SELECT id,name,email,password,role,"createdAt","updatedAt" FROM "AdminUser" WHERE lower(email)=lower($1) LIMIT 1', [email]);
  const admin = result.rows[0];
  if (admin) {
    const token = await issueVerificationToken(context, resetIdentifier(admin.id));
    const resetUrl = `${context.config.adminFrontendUrl.replace(/\/$/, '')}/reset-password?token=${token}&email=${encodeURIComponent(admin.email)}`;
    await sendOrganizationEmail(context, admin.email, 'Reset your KasiTek admin password', `Use this link to reset your KasiTek admin password: ${resetUrl}`);
  }
}

export async function resetAdminPassword(context: CoreContext, values: { email?: string; token?: string; password?: string }): Promise<void> {
  const email = (values.email ?? '').trim().toLowerCase();
  const token = (values.token ?? '').trim();
  const password = (values.password ?? '').trim();
  if (!email || !token || !password) throw bad('Email, token, and password are required');
  if (Buffer.byteLength(password) < 8) throw bad('Password must be at least 8 characters');
  const result = await context.pool.query<AdminUser>('SELECT id,name,email,password,role,"createdAt","updatedAt" FROM "AdminUser" WHERE lower(email)=lower($1) LIMIT 1', [email]);
  const admin = result.rows[0];
  if (!admin) throw bad('Invalid or expired password reset token');
  const valid = await context.pool.query<{ token: string }>('DELETE FROM "VerificationToken" WHERE identifier=$1 AND token=$2 AND expires>NOW() RETURNING token', [resetIdentifier(admin.id), token]);
  if (!valid.rows[0]) throw bad('Invalid or expired password reset token');
  const passwordHash = await hash(password, 12);
  await context.pool.query('UPDATE "AdminUser" SET password=$1,"updatedAt"=NOW() WHERE id=$2', [passwordHash, admin.id]);
  await context.pool.query('UPDATE \"AdminSession\" SET \"revokedAt\"=NOW() WHERE \"adminId\"=$1 AND \"revokedAt\" IS NULL', [admin.id]);
}

export async function changeAdminPassword(context: CoreContext, admin: AdminUser, current: string | undefined, next: string | undefined): Promise<void> {
  const currentPassword = current ?? '';
  const nextPassword = next ?? '';
  if (!currentPassword) throw bad('Current password is required');
  if (Buffer.byteLength(nextPassword) < 8) throw bad('New password must be at least 8 characters');
  if (!await compare(currentPassword, admin.password)) throw bad('Current password is incorrect');
  const passwordHash = await hash(nextPassword, 12);
  await context.pool.query('UPDATE "AdminUser" SET password=$1,"updatedAt"=NOW() WHERE id=$2', [passwordHash, admin.id]);
  await context.pool.query('UPDATE \"AdminSession\" SET \"revokedAt\"=NOW() WHERE \"adminId\"=$1 AND \"revokedAt\" IS NULL', [admin.id]);
}
