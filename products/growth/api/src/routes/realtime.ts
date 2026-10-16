import type { FastifyInstance } from 'fastify';
import type { CoreContext } from '../context.js';
import { extractUser, resolveActiveOrgId } from '../identity/session.js';
import { buildWhatsappOrgChannel, createPubsub, createRealtimeStream } from '../services/realtime.js';
export function registerRealtimeRoutes(app: FastifyInstance, context: CoreContext): void {
    const active = new Set<ReturnType<typeof createRealtimeStream>>();
    app.addHook('preClose', async () => { for (const stream of active)
        stream.destroy(); active.clear(); });
    app.get('/api/realtime/whatsapp', async (request, reply) => {
        const user = await extractUser(request, context);
        const orgId = await resolveActiveOrgId(request, context, user.id);
        const client = await createPubsub(context);
        const stream = createRealtimeStream(client, buildWhatsappOrgChannel(orgId), request.log);
        active.add(stream);
        stream.once('close', () => active.delete(stream));
        reply.raw.once('close', () => stream.destroy());
        return reply.type('text/event-stream').header('cache-control', 'no-cache, no-transform').header('connection', 'keep-alive').send(stream);
    });
}
