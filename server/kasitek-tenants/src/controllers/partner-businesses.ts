import { createId } from '@paralleldrive/cuid2';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { TenantContext } from '../context.js';
import { transaction } from '../db.js';
import { TenantError, bad, forbidden, missing } from '../error.js';
import { createWorkspaceBase } from '../workspace-provisioning.js';
import {
  requireAgencyPartner,
  requirePartnerSameOrigin,
} from '../partner-session.js';

const businessBody = {
  type: 'object',
  additionalProperties: false,
  required: ['name'],
  properties: {
    name: { type: 'string' },
    reportingTimezone: { type: 'string' },
    primaryColor: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
};

const brandingBody = {
  type: 'object',
  additionalProperties: false,
  required: [],
  properties: {
    displayName: { type: 'string' },
    primaryColor: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    secondaryColor: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    logoUrl: { anyOf: [{ type: 'string' }, { type: 'null' }] },
  },
};

function businessName(value: unknown) {
  if (typeof value !== 'string') throw bad('name is required');
  const name = value.trim();
  if (name.length < 2 || name.length > 80) throw bad('name must be between 2 and 80 characters');
  return name;
}

function slugBase(name: string) {
  const slug = name.normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42)
    .replace(/-+$/g, '');
  const reserved = new Set([
    'admin', 'agency', 'api', 'app', 'assets', 'auth', 'client', 'clients',
    'dashboard', 'health', 'kasitek', 'labs', 'login', 'localhost', 'portal',
    'register', 'settings', 'setup', 'www',
  ]);
  if (!slug) throw bad('name must include letters or numbers');
  return reserved.has(slug) ? `${slug}-business` : slug;
}

function chooseSlug(base: string, attempt: number) {
  if (attempt === 0) return base;
  const suffix = randomBytes(3).toString('hex');
  return `${base.slice(0, 41 - suffix.length)}-${suffix}`;
}

function normalizeColor(value: string | null | undefined, name: string) {
  if (value === undefined || value === null || value === '') return null;
  const color = value.trim();
  if (!/^#[\da-fA-F]{6}$/.test(color)) throw bad(`${name} must be a six-digit hex color`);
  return color.toLowerCase();
}

function normalizeReportingTimezone(value: string | undefined) {
  const timezone = value?.trim() || 'UTC';
  if (Buffer.byteLength(timezone) > 64 || !/^[A-Za-z0-9/_+\-]+$/.test(timezone))
    throw bad('reportingTimezone must be a valid timezone identifier');
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(); }
  catch { throw bad('reportingTimezone must be a valid timezone identifier'); }
  return timezone;
}

function normalizeLogoUrl(value: string | null | undefined) {
  if (value === undefined || value === null || value === '') return null;
  const raw = value.trim();
  if (raw.length > 2048) throw bad('logoUrl is too long');
  let url: URL;
  try { url = new URL(raw); }
  catch { throw bad('logoUrl must be a secure URL'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
    throw bad('logoUrl must use HTTPS');
  return url.toString();
}

function requestFingerprint(name: string, reportingTimezone: string, primaryColor: string | null) {
  const payload = JSON.stringify({ name, reportingTimezone, primaryColor });
  return createHash('sha256').update(payload).digest('hex');
}

async function ownedBusiness(context: TenantContext, partnerId: string, id: string) {
  const row = (await context.pool.query(
    `SELECT w.id,w.slug,w.display_name,w.status,w.created_at,b.primary_color,b.secondary_color,b.logo_url,
       (SELECT COUNT(*) FROM tenant_users u WHERE u.workspace_id=w.id
         AND NOT EXISTS(SELECT 1 FROM agency_partner_memberships own WHERE own.workspace_id=w.id AND own.tenant_user_id=u.id)) AS staff_count,
       (SELECT COUNT(*) FROM tenant_clients c WHERE c.workspace_id=w.id AND c.status='active') AS client_count
     FROM agency_partner_memberships m
     JOIN workspaces w ON w.id=m.workspace_id
     LEFT JOIN workspace_branding b ON b.workspace_id=w.id
     WHERE m.partner_id=$1 AND (w.id=$2 OR w.slug=$2) AND w.status='active' LIMIT 1`,
    [partnerId, id],
  )).rows[0];
  if (!row) throw missing('business not found');
  return row;
}

async function createBusiness(
  request: FastifyRequest,
  context: TenantContext,
  partner: Awaited<ReturnType<typeof requireAgencyPartner>>,
  name: string,
  reportingTimezone: string,
  initialPrimaryColor: string | null,
) {
  const rawKey = request.headers['idempotency-key'];
  if (typeof rawKey !== 'string' || rawKey.length < 16 || rawKey.length > 100)
    throw bad('Idempotency-Key header is required');
  const base = slugBase(name);
  const fingerprint = requestFingerprint(name, reportingTimezone, initialPrimaryColor);
  const time = new Date();
  return transaction(context.pool, async (tx) => {
    const account = (await tx.query(
      "SELECT status FROM agency_partners WHERE id=$1 FOR UPDATE",
      [partner.id],
    )).rows[0];
    if (!account || account.status !== 'active') throw forbidden();
    const existing = (await tx.query(
      `SELECT w.id,w.slug,w.display_name,w.status,w.created_at,b.primary_color,b.secondary_color,b.logo_url,r.request_fingerprint
       FROM agency_partner_business_requests r JOIN workspaces w ON w.id=r.workspace_id
       LEFT JOIN workspace_branding b ON b.workspace_id=w.id
       WHERE r.partner_id=$1 AND r.request_key=$2 LIMIT 1`,
      [partner.id, rawKey],
    )).rows[0];
    if (existing) {
      if (existing.request_fingerprint && existing.request_fingerprint !== fingerprint)
        throw new TenantError(409, 'Idempotency-Key was already used for a different business');
      return { row: existing, replayed: true };
    }
    const count = Number((await tx.query(
      'SELECT COUNT(*) AS count FROM agency_partner_memberships WHERE partner_id=$1',
      [partner.id],
    )).rows[0]?.count ?? 0);
    if (count >= context.config.partner_max_businesses)
      throw new TenantError(409, 'business creation limit reached');

    let workspaceId = '';
    let slug = '';
    const ownerUserId = createId();
    for (let attempt = 0; attempt < 6; attempt++) {
      slug = chooseSlug(base, attempt);
      workspaceId = createId();
      const inserted = await createWorkspaceBase(tx, {
        id: workspaceId,
        slug,
        name,
        reportingTimezone,
        primaryColor: initialPrimaryColor ?? '#0f766e',
        secondaryColor: '#e0f2f1',
        createdAt: time,
      }, { ignoreSlugConflict: true });
      if (inserted) break;
      if (attempt === 5) throw new TenantError(409, 'unable to reserve a business URL');
    }
    await tx.query(
      `INSERT INTO tenant_users(id,workspace_id,email,password_hash,name,status,created_at,updated_at)
       VALUES($1,$2,$3,NULL,$4,'active',NOW(),NOW())`,
      [ownerUserId, workspaceId, partner.email, partner.display_name],
    );
    await tx.query(
      `INSERT INTO tenant_user_roles(tenant_user_id,role,created_at) VALUES($1,'owner',NOW())`,
      [ownerUserId],
    );
    await tx.query(
      `INSERT INTO agency_partner_memberships(partner_id,workspace_id,tenant_user_id,role,created_at)
       VALUES($1,$2,$3,'owner',NOW())`,
      [partner.id, workspaceId, ownerUserId],
    );
    await tx.query(
      `INSERT INTO agency_partner_business_requests(partner_id,request_key,workspace_id,request_fingerprint,created_at)
       VALUES($1,$2,$3,$4,NOW())`,
      [partner.id, rawKey, workspaceId, fingerprint],
    );
    await tx.query(
      `INSERT INTO audit_logs(id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,metadata,created_at)
       VALUES($1,$2,'agency_partner',$3,'business.created','workspace',$4,$5,NOW())`,
      [createId(), workspaceId, partner.id, workspaceId, JSON.stringify({ slug })],
    );
    return {
      row: {
        id: workspaceId,
        slug,
        display_name: name,
        status: 'active',
        created_at: time,
        primary_color: initialPrimaryColor ?? '#0f766e',
        secondary_color: '#e0f2f1',
        logo_url: null,
      },
      replayed: false,
    };
  });
}

function businessView(row: Record<string, unknown>) {
  return {
    id: row.id,
    slug: row.slug,
    portalPath: `/portal/${String(row.slug)}`,
    displayName: row.display_name,
    status: row.status,
    createdAt: row.created_at,
    branding: {
      primaryColor: row.primary_color ?? null,
      secondaryColor: row.secondary_color ?? null,
      logoUrl: row.logo_url ?? null,
    },
    ...(row.staff_count !== undefined ? { staffCount: Number(row.staff_count) } : {}),
    ...(row.client_count !== undefined ? { clientCount: Number(row.client_count) } : {}),
  };
}

export function registerPartnerBusinessRoutes(app: FastifyInstance, context: TenantContext) {
  app.get('/api/partner/businesses', async (request) => {
    const partner = await requireAgencyPartner(request, context);
    const rows = (await context.pool.query(
      `SELECT w.id,w.slug,w.display_name,w.status,w.created_at,b.primary_color,b.secondary_color,b.logo_url
       FROM agency_partner_memberships m JOIN workspaces w ON w.id=m.workspace_id
       LEFT JOIN workspace_branding b ON b.workspace_id=w.id
       WHERE m.partner_id=$1 AND w.status='active' ORDER BY m.created_at ASC`,
      [partner.id],
    )).rows;
    return { businesses: rows.map(businessView) };
  });

  app.post<{ Body: { name: string; reportingTimezone?: string; primaryColor?: string | null } }>(
    '/api/partner/businesses',
    { schema: { body: businessBody } },
    async (request, reply) => {
      requirePartnerSameOrigin(request, context);
      if (request.cookies[context.config.client_session_cookie_name]?.trim())
        throw forbidden();
      const partner = await requireAgencyPartner(request, context);
      const name = businessName(request.body.name);
      const timezone = normalizeReportingTimezone(request.body.reportingTimezone);
      const primaryColor = normalizeColor(request.body.primaryColor, 'primaryColor');
      const created = await createBusiness(request, context, partner, name, timezone, primaryColor);
      return reply.code(created.replayed ? 200 : 201).send({ business: businessView(created.row) });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/partner/businesses/:id',
    async (request) => {
      const partner = await requireAgencyPartner(request, context);
      const row = await ownedBusiness(context, partner.id, request.params.id);
      const workspace = (await context.pool.query(
        'SELECT reporting_timezone FROM workspaces WHERE id=$1', [row.id],
      )).rows[0];
      return { business: businessView(row), reportingTimezone: workspace?.reporting_timezone ?? 'UTC' };
    },
  );

  app.patch<{ Params: { id: string }; Body: {
    displayName?: string; primaryColor?: string | null; secondaryColor?: string | null; logoUrl?: string | null;
  } }>(
    '/api/partner/businesses/:id/branding',
    { schema: { body: brandingBody } },
    async (request) => {
      requirePartnerSameOrigin(request, context);
      const partner = await requireAgencyPartner(request, context);
      const current = await ownedBusiness(context, partner.id, request.params.id);
      const displayName = request.body.displayName === undefined
        ? String(current.display_name)
        : businessName(request.body.displayName);
      const primaryColor = request.body.primaryColor === undefined
        ? current.primary_color as string | null
        : normalizeColor(request.body.primaryColor, 'primaryColor');
      const secondaryColor = request.body.secondaryColor === undefined
        ? current.secondary_color as string | null
        : normalizeColor(request.body.secondaryColor, 'secondaryColor');
      const logoUrl = request.body.logoUrl === undefined
        ? current.logo_url as string | null
        : normalizeLogoUrl(request.body.logoUrl);
      await transaction(context.pool, async (tx) => {
        await tx.query(
          'UPDATE workspaces SET display_name=$1,updated_at=NOW() WHERE id=$2',
          [displayName, current.id],
        );
        await tx.query(
          `UPDATE workspace_branding SET display_name=$1,primary_color=$2,secondary_color=$3,logo_url=$4,updated_at=NOW()
           WHERE workspace_id=$5`,
          [displayName, primaryColor, secondaryColor, logoUrl, current.id],
        );
        await tx.query(
          `INSERT INTO audit_logs(id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,metadata,created_at)
           VALUES($1,$2,'agency_partner',$3,'business.branding.updated','workspace',$4,$5,NOW())`,
          [createId(), current.id, partner.id, current.id, JSON.stringify({ displayName })],
        );
      });
      return { business: businessView(await ownedBusiness(context, partner.id, current.id)) };
    },
  );
}
