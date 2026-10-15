import { createId } from '@paralleldrive/cuid2';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { CoreContext } from '../context.js';
import { ApiError } from '../error.js';
import { extractUser, resolveActiveOrgId, type UserRecord } from '../identity/session.js';
import * as sql from './profile-sql.js';

interface ProfileInput { name?: string | null; phone?: string | null; image?: string | null }
interface OnboardingInput { companyName?: string | null; website?: string | null; primaryGoal?: string | null;
  primaryGoals?: string[] | null; teamRole?: string | null; industry?: string | null; referralSource?: string | null;
  complete?: boolean | null; skip?: boolean | null }
interface TourRow { primaryGoal: string | null; status: string | null; currentStep: number | null;
  completedAt: Date | null; skippedAt: Date | null }
const nullableString = { type: ['string', 'null'] };
const nullableBoolean = { type: ['boolean', 'null'] };
const profileSchema = { type: 'object', properties: { name: nullableString, phone: nullableString, image: nullableString } };
const clean = (value: string | null | undefined) => value?.trim() || null;
export function cleanBounded(value: string | null | undefined, label: string, limit: number): string | null {
  const normalized = clean(value);
  // Rust String::len counts UTF-8 bytes, despite the existing message saying characters.
  if (normalized && Buffer.byteLength(normalized, 'utf8') > limit) {
    throw new ApiError(400, 'bad_request', `${label} must be ${limit} characters or fewer`);
  }
  return normalized;
}

async function active(request: FastifyRequest, context: CoreContext) {
  const user = await extractUser(request, context);
  const orgId = await resolveActiveOrgId(request, context, user.id);
  const member = await context.pool.query<{ role: string }>(
    'SELECT role::text FROM "OrganizationMember" WHERE "orgId"=$1 AND "userId"=$2', [orgId, user.id]);
  const role = member.rows[0]?.role;
  if (!role) throw new ApiError(403, 'forbidden', 'Not a member of this organisation');
  return { user, orgId, role };
}

async function onboarding(request: FastifyRequest, context: CoreContext) {
  const { orgId, role } = await active(request, context);
  const row = (await context.pool.query(sql.ONBOARDING_SQL_0, [orgId])).rows[0];
  if (!row) throw new ApiError(500, 'internal_error', 'Database operation failed');
  const canManage = role === 'OWNER' || role === 'ADMIN';
  return { profile: row, canManage, needsOnboarding: canManage && row.completedAt === null && row.skippedAt === null };
}

const boundedStep = (step: number | null | undefined) => Math.max(0, Math.min(9, step ?? 0));
export function tourStatus(row: TourRow) {
  return { shouldShow: (row.completedAt !== null || row.skippedAt !== null)
    && !['COMPLETED', 'DISMISSED'].includes(row.status ?? ''), currentStep: boundedStep(row.currentStep), primaryGoal: row.primaryGoal };
}

export async function registerProfileRoutes(app: FastifyInstance, context: CoreContext): Promise<void> {
  app.get('/api/profile', async (request) => {
    const user = await extractUser(request, context);
    const result = await context.pool.query<{ hasPassword: boolean }>('SELECT password IS NOT NULL AS "hasPassword" FROM "User" WHERE id=$1', [user.id]);
    if (!result.rows[0]) throw new ApiError(401, 'unauthorized', 'Unauthorized');
    return { user, hasPassword: result.rows[0].hasPassword };
  });
  app.patch<{ Body: ProfileInput }>('/api/profile', { schema: { body: profileSchema } }, async (request) => {
    const user = await extractUser(request, context);
    const body = request.body;
    const image = clean(body.image);
    if (image && !image.startsWith('http://') && !image.startsWith('https://')) {
      throw new ApiError(400, 'bad_request', 'Photo URL must start with http:// or https://');
    }
    const updated = (await context.pool.query<UserRecord & { password: string | null }>(sql.PROFILE_SQL_0,
      [clean(body.name), clean(body.phone), image, user.id])).rows[0];
    if (!updated) throw new ApiError(500, 'internal_error', 'Database operation failed');
    const { password: _password, ...profile } = updated;
    return { user: profile };
  });
  app.post<{ Body: { phone?: string | null; phoneVerified?: boolean | null } }>('/api/onboarding/phone', {
    schema: { body: { type: 'object', properties: { phone: nullableString, phoneVerified: nullableBoolean } } },
  }, async (request) => {
    const user = await extractUser(request, context);
    const phone = clean(request.body.phone);
    if (!phone) throw new ApiError(400, 'bad_request', 'Phone number is required');
    await context.pool.query(sql.PROFILE_SQL_1, [phone, user.id]);
    return { message: 'Phone number saved' };
  });
  app.get('/api/onboarding', (request) => onboarding(request, context));
  app.patch<{ Body: OnboardingInput }>('/api/onboarding', { schema: { body: { type: 'object', properties: {
    companyName: nullableString, website: nullableString, primaryGoal: nullableString,
    primaryGoals: { type: ['array', 'null'], items: { type: 'string' } }, teamRole: nullableString,
    industry: nullableString, referralSource: nullableString, complete: nullableBoolean, skip: nullableBoolean,
  } } } }, async (request) => {
    const { orgId, role } = await active(request, context);
    if (role !== 'OWNER' && role !== 'ADMIN') throw new ApiError(403, 'forbidden', 'Admin or Owner role required');
    const body = request.body;
    const companyName = cleanBounded(body.companyName, 'Company name', 80);
    const website = cleanBounded(body.website, 'Website', 500);
    const primaryGoals = body.primaryGoals == null ? null
      : [...new Set(body.primaryGoals.map((value) => cleanBounded(value, 'Primary goal', 80)).filter((value): value is string => value !== null))];
    const suppliedGoal = cleanBounded(body.primaryGoal, 'Primary goal', 80);
    const primaryGoal = primaryGoals?.[0] ?? suppliedGoal;
    const teamRole = cleanBounded(body.teamRole, 'Team role', 80);
    const industry = cleanBounded(body.industry, 'Industry', 80);
    const referralSource = cleanBounded(body.referralSource, 'Referral source', 80);
    if (body.complete === true && !companyName) throw new ApiError(400, 'bad_request', 'Company name is required to complete onboarding');
    if (companyName) await context.pool.query('UPDATE "Organization" SET name=$1,"updatedAt"=NOW() WHERE id=$2', [companyName, orgId]);
    await context.pool.query(sql.ONBOARDING_SQL_1, [createId(), orgId, website, primaryGoal, primaryGoals,
      teamRole, industry, referralSource, body.complete === true, body.skip === true]);
    return onboarding(request, context);
  });
  app.get('/api/product-tour', async (request) => {
    const { orgId, user } = await active(request, context);
    const row = (await context.pool.query<TourRow>(sql.PRODUCT_TOUR_SQL_0, [orgId, user.id])).rows[0];
    if (!row) throw new ApiError(500, 'internal_error', 'Database operation failed');
    return tourStatus(row);
  });
  app.patch<{ Body: { action: string; currentStep?: number | null } }>('/api/product-tour', { schema: { body: {
    type: 'object', required: ['action'], properties: { action: { type: 'string' },
      currentStep: { type: ['integer', 'null'], minimum: -2_147_483_648, maximum: 2_147_483_647 } },
  } } }, async (request) => {
    const { orgId, user } = await active(request, context);
    const action = request.body.action.trim().toLowerCase();
    let status: string;
    let step = boundedStep(request.body.currentStep);
    switch (action) {
      case 'start': case 'advance': status = 'IN_PROGRESS'; break;
      case 'complete': status = 'COMPLETED'; step = 9; break;
      case 'dismiss': status = 'DISMISSED'; break;
      case 'restart': status = 'PENDING'; step = 0; break;
      default: throw new ApiError(400, 'bad_request', 'Unknown tour action');
    }
    const row = (await context.pool.query<TourRow>(sql.PRODUCT_TOUR_SQL_0, [orgId, user.id])).rows[0];
    if (!row) throw new ApiError(500, 'internal_error', 'Database operation failed');
    if (row.completedAt === null && row.skippedAt === null) {
      throw new ApiError(403, 'forbidden', 'Finish workspace onboarding before starting the tour');
    }
    await context.pool.query(sql.PRODUCT_TOUR_SQL_1, [createId(), user.id, orgId, status, step]);
    const updated = (await context.pool.query<TourRow>(sql.PRODUCT_TOUR_SQL_0, [orgId, user.id])).rows[0];
    if (!updated) throw new ApiError(500, 'internal_error', 'Database operation failed');
    return tourStatus(updated);
  });
}
