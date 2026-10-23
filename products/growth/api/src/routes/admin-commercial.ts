import type { FastifyInstance } from 'fastify';
import type { CoreContext } from '../context.js';
import { extractAdmin } from '../identity/admin-session.js';
import { claimSend, completeSend, listSendAttempts, ensureTestRecipient } from '../services/admin/outreach-send.js';
export function registerAdminCommercialRoutes(app: FastifyInstance, context: CoreContext) {
  app.post('/api/admin/outreach/test-recipient',async r=>{await extractAdmin(r,context);return ensureTestRecipient(context.pool,r.body);});
  app.post<{Params:{id:string;lead_id:string}}>('/api/admin/outreach/:id/leads/:lead_id/send-attempts', async r => {
    const admin=await extractAdmin(r,context);
    return claimSend(context.pool,admin.id,r.params.id,r.params.lead_id,r.body);
  });
  app.get<{Params:{id:string;lead_id:string}}>('/api/admin/outreach/:id/leads/:lead_id/send-attempts', async r => {
    await extractAdmin(r,context); return listSendAttempts(context.pool,r.params.id,r.params.lead_id);
  });
  for (const suffix of ['complete','reconcile']) app.post<{Params:{attemptId:string}}>(`/api/admin/outreach/send-attempts/:attemptId/${suffix}`,async r => {
    const admin=await extractAdmin(r,context); return completeSend(context.pool,admin.id,r.params.attemptId,r.body,suffix==='reconcile');
  });
}
