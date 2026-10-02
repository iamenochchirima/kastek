import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { CoreContext } from '../context.js';
import { ApiError } from '../error.js';
import { extractUser } from '../identity/session.js';
import * as notifications from '../services/notifications.js';
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ApiError(400, 'bad_request', 'Invalid request'); return value as Record<string, unknown>; }
function optionalString(value: unknown): string | undefined { if (value == null)
    return undefined; if (typeof value !== 'string')
    throw new ApiError(400, 'bad_request', 'Invalid request'); return value; }
function body(request: FastifyRequest): Record<string, unknown> { return object(request.body); }
export function registerNotificationRoutes(app: FastifyInstance, context: CoreContext): void {
    app.get<{
        Querystring: {
            limit?: string;
            cursor?: string;
        };
    }>('/api/notifications', async (request) => {
        const user = await extractUser(request, context);
        const { limit, cursor } = request.query;
        let value = 20;
        if (limit !== undefined) {
            if (typeof limit !== 'string' || !/^[-+]?\d+$/.test(limit))
                throw new ApiError(400, 'bad_request', 'Invalid request');
            const parsed = BigInt(limit);
            if (parsed < -9223372036854775808n || parsed > 9223372036854775807n)
                throw new ApiError(400, 'bad_request', 'Invalid request');
            value = Number(parsed);
        }
        return notifications.listNotificationInbox(context.pool, user.id, value, cursor);
    });
    app.get('/api/notifications/unread', async (request) => { const user = await extractUser(request, context); return { unreadCount: await notifications.getUnreadNotificationCount(context.pool, user.id) }; });
    app.post('/api/notifications', async (request) => { const user = await extractUser(request, context); if (optionalString(body(request).action) !== 'mark_all_read')
        throw new ApiError(400, 'bad_request', 'Unsupported action'); return { updated: await notifications.markAllNotificationsRead(context.pool, user.id) }; });
    app.patch<{
        Params: {
            id: string;
        };
    }>('/api/notifications/:id', async (request) => { const user = await extractUser(request, context); const updated = await notifications.markNotificationRead(context.pool, user.id, request.params.id); if (!updated)
        throw new ApiError(404, 'not_found', 'Notification not found'); return { updated }; });
    app.get('/api/notifications/push', async (request) => notifications.getPushSubscriptionStatus(context, (await extractUser(request, context)).id));
    app.post('/api/notifications/push/subscribe', async (request) => {
        const user = await extractUser(request, context);
        const values = body(request);
        if (values.subscription == null)
            throw new ApiError(400, 'bad_request', 'Missing subscription payload');
        const subscription = object(values.subscription);
        let keys: notifications.PushSubscriptionInput['keys'];
        if (subscription.keys != null) {
            const value = object(subscription.keys);
            keys = { p256dh: optionalString(value.p256dh), auth: optionalString(value.auth) };
        }
        const expirationTime = subscription.expirationTime;
        if (expirationTime != null && (typeof expirationTime !== 'number' || !Number.isSafeInteger(expirationTime)))
            throw new ApiError(400, 'bad_request', 'Invalid request');
        await notifications.savePushSubscription(context.pool, user.id, { endpoint: optionalString(subscription.endpoint), expirationTime: expirationTime as number | undefined, keys }, request.headers['user-agent']);
        return { success: true };
    });
    app.post('/api/notifications/push/unsubscribe', async (request) => { const user = await extractUser(request, context); const endpoint = optionalString(body(request).endpoint)?.trim(); if (!endpoint)
        throw new ApiError(400, 'bad_request', 'Missing subscription endpoint'); return { deleted: await notifications.deletePushSubscription(context.pool, user.id, endpoint) }; });
    app.post('/api/notifications/push/test', async (request) => { const user = await extractUser(request, context); const values = body(request); const title = optionalString(values.title)?.trim() || 'KasiTek notification test', pushBody = optionalString(values.body)?.trim() || 'Push notifications are now connected for this device.', url = optionalString(values.url)?.trim() || '/workspace/notifications'; return { delivered: await notifications.sendPushNotificationToUser(context, user.id, { title, body: pushBody, url, tag: 'push-test' }, request.log) }; });
}
