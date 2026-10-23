import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { CoreContext } from '../../context.js';
import {
  extractAdmin,
  requireAdminRole,
} from '../../identity/admin-session.js';
import * as billing from '../billing.js';
import * as credits from '../credits.js';
import * as referrals from '../referrals.js';
import { paystackProvider } from '../../routes/billing.js';
import { missing, obj, type ObjectValue } from './common.js';
import { validateBody } from './validation.js';
import { queryI64, typedQuery } from '../../typed-query.js';
export function registerAdminBillingRoutes(
  app: FastifyInstance,
  context: CoreContext,
) {
  const pool = context.pool;
  async function access(request: FastifyRequest) {
    const admin = await extractAdmin(request, context);
    requireAdminRole(admin, ['superadmin', 'owner', 'admin', 'operator']);
    return admin;
  }
  const body = (name: string, r: FastifyRequest) =>
      validateBody('billing.' + name, r.body),
    org = (r: FastifyRequest) => String(obj(r.params).orgId),
    id = (r: FastifyRequest, key: string) => String(obj(r.params)[key]);
  app.get('/api/admin/billing/orgs/:orgId/grants', async (r) => {
    await access(r);
    return { grants: await billing.listManualGrants(pool, org(r)) };
  });
  app.post('/api/admin/billing/orgs/:orgId/grants', async (r, reply) => {
    const admin = await access(r),
      b = body('CreateGrantRequest', r);
    return reply
      .code(201)
      .send(
        await billing.createManualGrant(
          pool,
          org(r),
          b.key as string,
          b.value,
          b.endsAt as Date | null,
          b.reason as string,
          admin.id,
        ),
      );
  });
  app.post(
    '/api/admin/billing/orgs/:orgId/grants/:grantId/expire',
    async (r) => {
      await access(r);
      if (!(await billing.expireManualGrant(pool, org(r), id(r, 'grantId'))))
        missing('Active manual grant not found');
      return { expired: true };
    },
  );
  app.get('/api/admin/billing/orgs/:orgId/credits', async (r) => {
    await access(r);
    return credits.getCreditAccount(pool, org(r));
  });
  app.get('/api/admin/billing/organizations', async (r) => {
    const query = typedQuery<{ q?: string; limit?: string }>(r.query, [
        'q',
        'limit',
      ]),
      requestedLimit = queryI64(query.limit, 'limit');
    await access(r);
    return {
      organizations: await credits.searchCreditOrganizations(
        pool,
        query.q ?? null,
        Number(requestedLimit ?? 25n),
      ),
    };
  });
  app.post(
    '/api/admin/billing/orgs/:orgId/credits/grants',
    async (r, reply) => {
      const admin = await access(r),
        b = body('CreditGrantRequest', r);
      return reply
        .code(201)
        .send(
          await credits.grantCredits(
            pool,
            org(r),
            b.amount as bigint,
            b.source as string,
            b.endsAt as Date | null,
            b.reason as string,
            b.reference as string | null,
            admin.id,
            b.idempotencyKey as string,
          ),
        );
    },
  );
  app.post('/api/admin/billing/orgs/:orgId/credits/balance', async (r) => {
    const admin = await access(r),
      b = body('CreditSetBalanceRequest', r);
    return credits.setCreditBalance(
      pool,
      org(r),
      b.targetBalance as bigint,
      b.reason as string,
      b.reference as string | null,
      admin.id,
      b.idempotencyKey as string,
    );
  });
  app.get('/api/admin/referrals', async (r) => {
    const query = typedQuery<{
      orgId?: string;
      status?: string;
      limit?: string;
    }>(r.query, ['orgId', 'status', 'limit']);
    const requestedLimit = queryI64(query.limit, 'limit');
    await access(r);
    return {
      referrals: await referrals.listReferralAttributions(
        pool,
        query.orgId ?? null,
        query.status ?? null,
        Number(requestedLimit ?? 100n),
      ),
    };
  });
  app.post('/api/admin/referrals/orgs/:orgId/code', async (r) => {
    const admin = await access(r),
      b = body('ReferralCodeStatusRequest', r);
    if (
      !(await referrals.setReferralCodeStatus(
        pool,
        org(r),
        b.status as string,
        `admin:${admin.id} ${(b.reason as string).trim()}`,
      ))
    )
      missing('Referral code not found');
    return { updated: true };
  });
  app.post('/api/admin/referrals/:attributionId/reject', async (r) => {
    const admin = await access(r),
      b = body('ReferralActionRequest', r);
    return {
      rejected: await referrals.rejectReferralAttribution(
        pool,
        id(r, 'attributionId'),
        b.reason as string,
        `admin:${admin.id}:${(b.reference as string).trim()}`,
      ),
    };
  });
  app.post('/api/admin/referrals/:attributionId/reverse', async (r) => {
    const admin = await access(r),
      b = body('ReferralActionRequest', r);
    return {
      reversed: await referrals.reverseReferralAttribution(
        pool,
        id(r, 'attributionId'),
        b.reason as string,
        `admin:${admin.id}:${(b.reference as string).trim()}`,
      ),
    };
  });
  app.post('/api/admin/billing/reconcile/paystack', async (r) => {
    await access(r);
    const provider = paystackProvider(context);
    return {
      provider: provider.name,
      mode: (context.config.env.PAYSTACK_MODE?.trim() ?? 'test').toLowerCase(),
      result: await billing.reconcileBilling(
        pool,
        provider,
        100,
        referrals.referralRewardConfig(context.config),
      ),
    };
  });
  app.get('/api/admin/billing/reconciliation-issues', async (r) => {
    const query = typedQuery<{ status?: string }>(r.query, ['status']);
    await access(r);
    const status = query.status?.trim() ?? '';
    return {
      issues: await billing.listReconciliationIssues(pool, status || null),
    };
  });
  app.get('/api/admin/billing/catalog', async (r) => {
    await access(r);
    return billing.adminCatalog(pool);
  });
  app.post('/api/admin/billing/products', async (r) => {
    await access(r);
    const b = body('UpsertProductRequest', r);
    return billing.upsertProduct(
      pool,
      b.key as string,
      b.name as string,
      b.description as string | null,
      b.active as boolean,
    );
  });
  app.post('/api/admin/billing/plans', async (r) => {
    await access(r);
    const b = body('UpsertPlanRequest', r);
    return billing.upsertPlan(
      pool,
      b.productKey as string,
      b.key as string,
      b.name as string,
      b.interval as string,
      b.currency as string,
      b.amountMinor as number | null,
      b.creditsPerPeriod as bigint | null,
      b.active as boolean,
      b.paystackPlanCode as string | null,
    );
  });
  app.post('/api/admin/billing/entitlements', async (r) => {
    await access(r);
    const b = body('UpsertEntitlementRequest', r);
    return billing.upsertPlanEntitlement(
      pool,
      b.planKey as string,
      b.key as string,
      b.value,
    );
  });
}
