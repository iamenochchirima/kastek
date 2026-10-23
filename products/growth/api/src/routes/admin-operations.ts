import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { CoreContext } from '../context.js';
import {registerAdminAnalyticsRoutes} from './admin-analytics.js';
import {
  extractAdmin,
  resolveAdminContext,
} from '../identity/admin-session.js';
import { ApiError } from '../error.js';
import * as leads from '../services/admin/leads.js';
import * as quotations from '../services/admin/quotations.js';
import * as web from '../services/admin/web-services.js';
import * as invoices from '../services/admin/invoices.js';
import * as outreach from '../services/admin/outreach.js';
import * as conversations from '../services/admin/conversations.js';
import * as notifications from '../services/admin/notifications.js';
import { registerOperatorRoutes } from '../services/admin/operations.js';
import { registerAdminBillingRoutes } from '../services/admin/billing.js';
import { obj, type ObjectValue } from '../services/admin/common.js';
import { validateBody } from '../services/admin/validation.js';
import { queryBool, queryI64, typedQuery } from '../typed-query.js';
export function registerAdminOperationsRoutes(
  app: FastifyInstance,
  context: CoreContext,
) {
  const pool = context.pool;
  const param = (request: FastifyRequest, key = 'id') =>
    String(obj(request.params)[key]);
  const body = (name: string, r: FastifyRequest) => validateBody(name, r.body);
  const query = (name: string, value: unknown) => validateBody(name, value);
  app.get('/api/admin/stats', async (request) => {
    const principal = await resolveAdminContext(request, context);
    if (!principal.effectiveGrants.has('admin:read'))
      throw new ApiError(403, 'forbidden', 'Insufficient permissions');
    const count = async (table: string) =>
      BigInt(
        (await pool.query(`SELECT COUNT(*) FROM "${table}"`)).rows[0]!.count,
      );
    return {
      totalUsers: await count('User'),
      totalAdmins: await count('AdminUser'),
      totalSocialPosts: await count('SocialPost').catch(() => 0n),
      totalWhatsappCampaigns: await count('WhatsappCampaign').catch(() => 0n),
    };
  });
  app.get('/api/admin/leads', async (r) => {
    const q = typedQuery<{ status?: string; source?: string; search?: string }>(
      r.query,
      ['status', 'source', 'search'],
    );
    await extractAdmin(r, context);
    return leads.listLeads(pool, query('leads.ListLeadsQuery', q));
  });
  app.get('/api/admin/leads/:id', async (r) => {
    await extractAdmin(r, context);
    return leads.getLead(pool, param(r));
  });
  app.post('/api/admin/leads', async (r, reply) => {
    await extractAdmin(r, context);
    return reply
      .code(201)
      .send(await leads.createLead(pool, body('leads.CreateLeadBody', r)));
  });
  app.patch('/api/admin/leads/:id', async (r) => {
    await extractAdmin(r, context);
    return leads.updateLead(pool, param(r), body('leads.UpdateLeadBody', r));
  });
  app.delete('/api/admin/leads/:id', async (r) => {
    await extractAdmin(r, context);
    return leads.deleteLead(pool, param(r));
  });
  app.get('/api/admin/quotations', async (r) => {
    await extractAdmin(r, context);
    return quotations.listQuotations(pool);
  });
  app.get('/api/admin/quotations/:id', async (r) => {
    await extractAdmin(r, context);
    return quotations.getQuotation(pool, param(r));
  });
  app.post('/api/admin/quotations', async (r, reply) => {
    await extractAdmin(r, context);
    return reply
      .code(201)
      .send(
        await quotations.createQuotation(
          pool,
          body('quotations.CreateBody', r),
        ),
      );
  });
  app.patch('/api/admin/quotations/:id', async (r) => {
    await extractAdmin(r, context);
    return quotations.updateQuotation(
      pool,
      param(r),
      body('quotations.UpdateBody', r),
    );
  });
  app.delete('/api/admin/quotations/:id', async (r) => {
    await extractAdmin(r, context);
    return quotations.deleteQuotation(pool, param(r));
  });
  app.get('/api/admin/web-services', async (r) => {
    const q = typedQuery<{
      callStatus?: string;
      category?: string;
      search?: string;
    }>(r.query, ['callStatus', 'category', 'search']);
    await extractAdmin(r, context);
    return web.listWebServices(pool, { ...query('web_services.ListQuery', q), ...typedQuery(r.query, ['page', 'limit', 'paginate']) });
  });
  app.get('/api/admin/web-services/:id', async (r) => {
    await extractAdmin(r, context);
    return web.getWebService(pool, param(r));
  });
  app.post('/api/admin/web-services', async (r, reply) => {
    await extractAdmin(r, context);
    return reply
      .code(201)
      .send(
        await web.createWebService(pool, body('web_services.CreateBody', r)),
      );
  });
  app.patch('/api/admin/web-services/:id', async (r) => {
    await extractAdmin(r, context);
    return web.updateWebService(
      pool,
      param(r),
      body('web_services.UpdateBody', r),
    );
  });
  app.delete('/api/admin/web-services/:id', async (r) => {
    await extractAdmin(r, context);
    return web.deleteWebService(pool, param(r));
  });
  app.get('/api/admin/invoices', async (r) => {
    await extractAdmin(r, context);
    return invoices.listInvoices(pool);
  });
  app.get('/api/admin/invoices/:id', async (r) => {
    await extractAdmin(r, context);
    return invoices.getInvoice(pool, param(r));
  });
  app.post('/api/admin/invoices', async (r, reply) => {
    await extractAdmin(r, context);
    return reply
      .code(201)
      .send(await invoices.createInvoice(pool, body('invoices.CreateBody', r)));
  });
  app.patch('/api/admin/invoices/:id', async (r) => {
    await extractAdmin(r, context);
    return invoices.updateInvoice(
      pool,
      param(r),
      body('invoices.UpdateBody', r),
    );
  });
  app.delete('/api/admin/invoices/:id', async (r) => {
    await extractAdmin(r, context);
    return invoices.deleteInvoice(pool, param(r));
  });
  app.get('/api/admin/outreach', async (r) => {
    await extractAdmin(r, context);
    return outreach.listCampaigns(pool, obj(typedQuery<{ page?: string; limit?: string; paginate?: string }>(r.query, ['page', 'limit', 'paginate'])));
  });
  app.get('/api/admin/outreach/:id', async (r) => {
    await extractAdmin(r, context);
    return outreach.getCampaign(pool, param(r));
  });
  app.post('/api/admin/outreach', async (r, reply) => {
    await extractAdmin(r, context);
    return reply
      .code(201)
      .send(
        await outreach.createCampaign(
          pool,
          body('outreach.CreateCampaignBody', r),
        ),
      );
  });
  app.patch('/api/admin/outreach/:id', async (r) => {
    await extractAdmin(r, context);
    return outreach.updateCampaign(
      pool,
      param(r),
      body('outreach.UpdateCampaignBody', r),
    );
  });
  app.delete('/api/admin/outreach/:id', async (r) => {
    await extractAdmin(r, context);
    return outreach.deleteCampaign(pool, param(r));
  });
  app.post('/api/admin/leads/:id/notes', async (r) =>
    leads.addLeadNote(
      pool,
      await extractAdmin(r, context),
      param(r),
      body('leads.AddNoteBody', r),
    ),
  );
  app.post('/api/admin/web-services/import', async (r, reply) => {
    await extractAdmin(r, context);
    return reply
      .code(201)
      .send(
        await web.importWebServices(
          pool,
          body('web_services.ImportBody', r).leads as ObjectValue[],
        ),
      );
  });
  app.get('/api/admin/conversations', async (r) => {
    const q = typedQuery<{
      channel?: string;
      search?: string;
      organizationId?: string;
    }>(r.query, ['channel', 'search', 'organizationId']);
    return conversations.listConversations(
      pool,
      (await extractAdmin(r, context)).id,
      obj(q),
    );
  });
  app.get('/api/admin/conversations/:id', async (r) =>
    conversations.getConversation(
      pool,
      (await extractAdmin(r, context)).id,
      param(r),
    ),
  );
  app.post('/api/admin/invoices/:id/runs/:run_id/actions', async (r) => {
    await extractAdmin(r, context);
    return invoices.invoiceRunAction(
      pool,
      param(r),
      param(r, 'run_id'),
      body('invoices.RunActionBody', r).action as string,
    );
  });
  app.delete('/api/admin/outreach', async (r) => {
    await extractAdmin(r, context);
    return outreach.deleteAllCampaigns(pool);
  });
  app.post('/api/admin/outreach/import', async (r, reply) => {
    await extractAdmin(r, context);
    return reply
      .code(201)
      .send(
        await outreach.importCampaign(pool, body('outreach.ImportBody', r)),
      );
  });
  app.get('/api/admin/outreach/delivery', async (r, reply) => {
    const queryValues = typedQuery<{
      campaignId?: string;
      status?: string;
      mode?: string;
      recipient?: string;
      domain?: string;
      dateFrom?: string;
      dateTo?: string;
      format?: string;
      limit?: string;
    }>(r.query, [
        'campaignId',
        'status',
        'mode',
        'recipient',
        'domain',
        'dateFrom',
        'dateTo',
        'format',
        'limit',
      ]),
      parsedLimit = queryI64(queryValues.limit, 'limit');
    await extractAdmin(r, context);
    const q: ObjectValue = { ...queryValues, limit: parsedLimit ?? null, ...typedQuery(r.query, ['page', 'paginate']) };
    const result = await outreach.listDeliveryLogs(pool, q);
    return typeof result === 'string'
      ? reply
          .type('text/csv')
          .header(
            'Content-Disposition',
            'attachment; filename=delivery-log.csv',
          )
          .send(result)
      : result;
  });
  app.post('/api/admin/outreach/delivery-logs', async (r, reply) => {
    await extractAdmin(r, context);
    return reply
      .code(201)
      .send(
        await outreach.createDeliveryLogs(
          pool,
          body('outreach.CreateDeliveryLogsBody', r).logs as ObjectValue[],
        ),
      );
  });
  app.get('/api/admin/outreach/:id/leads', async (r) => {
    const q = typedQuery<{ emailStatus?: string; search?: string }>(r.query, [
      'emailStatus',
      'search',
    ]);
    await extractAdmin(r, context);
    return outreach.listOutreachLeads(
      pool,
      param(r),
      { ...query('outreach.LeadQuery', q), ...typedQuery(r.query, ['page', 'limit', 'paginate']) },
    );
  });
  app.post('/api/admin/outreach/:id/leads', async (r, reply) => {
    await extractAdmin(r, context);
    return reply
      .code(201)
      .send(
        await outreach.createOutreachLead(
          pool,
          param(r),
          body('outreach.CreateLeadBody', r),
        ),
      );
  });
  app.get('/api/admin/outreach/:id/leads/:lead_id', async (r) => {
    await extractAdmin(r, context);
    return outreach.getOutreachLead(pool, param(r), param(r, 'lead_id'));
  });
  app.patch('/api/admin/outreach/:id/leads/:lead_id', async (r) => {
    await extractAdmin(r, context);
    return outreach.updateOutreachLead(
      pool,
      param(r),
      param(r, 'lead_id'),
      body('outreach.UpdateLeadBody', r),
    );
  });
  app.delete('/api/admin/outreach/:id/leads/:lead_id', async (r) => {
    await extractAdmin(r, context);
    return outreach.deleteOutreachLead(pool, param(r), param(r, 'lead_id'));
  });
  app.get('/api/admin/notifications', async (r) => {
    const query = typedQuery<{
        unreadOnly?: string;
        limit?: string;
        channel?: string;
      }>(r.query, ['unreadOnly', 'limit', 'channel']),
      unreadOnly = queryBool(query.unreadOnly),
      limit = queryI64(query.limit, 'limit');
    const admin = await extractAdmin(r, context);
    return notifications.listNotifications(pool, admin.id, {
      unreadOnly,
      limit: limit ?? null,
      channel: query.channel ?? null,
    });
  });
  app.post('/api/admin/notifications', async (r) =>
    notifications.readAllNotifications(
      pool,
      (await extractAdmin(r, context)).id,
    ),
  );
  app.get('/api/admin/notifications/unread', async (r) =>
    notifications.unreadNotifications(
      pool,
      (await extractAdmin(r, context)).id,
    ),
  );
  app.patch('/api/admin/notifications/:id', async (r) =>
    notifications.readNotification(
      pool,
      (await extractAdmin(r, context)).id,
      param(r),
    ),
  );
  registerAdminAnalyticsRoutes(app, context);
  registerOperatorRoutes(app, context);
  registerAdminBillingRoutes(app, context);
}
