import { createId } from '@paralleldrive/cuid2';
import { createECDH } from 'node:crypto';
import webpush from 'web-push';
import type { Pool } from 'pg';
import type { CoreContext } from '../context.js';
import { ApiError } from '../error.js';
export interface NotificationItem {
    id: string;
    eventId: string;
    createdAt: Date;
    eventType: string;
    title: string;
    message: string;
    severity: string;
    entityType: string | null;
    entityId: string | null;
    payload: unknown;
    status: string;
    isUnread: boolean;
    emailDeliveryStatus: string | null;
    emailDeliveryError: string | null;
}
interface InboxRow extends Omit<NotificationItem, 'id' | 'isUnread'> {
    notificationId: string;
    readAt: Date | null;
    cursorCreatedAt: string;
}
export function encodeNotificationCursor(timestamp: Date | string, eventId: string): string { return Buffer.from(`${timestamp instanceof Date ? timestamp.toISOString() : timestamp}|${eventId}`).toString('base64'); }
export function decodeNotificationCursor(cursor: string | undefined): {
    timestamp: string;
    eventId: string;
} | null {
    if (!cursor || cursor.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(cursor))
        return null;
    const bytes = Buffer.from(cursor, 'base64');
    if (bytes.toString('base64') !== cursor)
        return null;
    let raw: string;
    try {
        raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    catch {
        return null;
    }
    const separator = raw.lastIndexOf('|');
    if (separator < 0)
        return null;
    const timestamp = raw.slice(0, separator);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp) || !Number.isFinite(Date.parse(timestamp)))
        return null;
    const parts = timestamp.slice(0, 19).split(/[-T:]/).map(Number);
    const [year, month, day, hour, minute, second] = parts as [
        number,
        number,
        number,
        number,
        number,
        number
    ];
    const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
    if (month < 1 || month > 12 || day < 1 || day > days || hour > 23 || minute > 59 || second > 60)
        return null;
    return { timestamp, eventId: raw.slice(separator + 1) };
}
export async function getUnreadNotificationCount(pool: Pool, userId: string): Promise<number> {
    const result = await pool.query<{
        count: string;
    }>(`SELECT COUNT(*) FROM "Notification" n JOIN "NotificationEvent" e ON e.id=n."eventId" WHERE n."recipientType"='USER'::"NotificationRecipientType" AND n."recipientId"=$1 AND n.channel='IN_APP'::"NotificationChannel" AND n."readAt" IS NULL AND n.status NOT IN ('DISMISSED'::"NotificationStatus",'FAILED'::"NotificationStatus") AND e."eventType"<>'message.received'`, [userId]);
    return Number(result.rows[0]!.count);
}
export async function listNotificationInbox(pool: Pool, userId: string, requestedLimit = 20, cursor?: string): Promise<{
    items: NotificationItem[];
    nextCursor: string | null;
    unreadCount: number;
}> {
    const limit = Math.max(1, Math.min(100, requestedLimit));
    const after = decodeNotificationCursor(cursor);
    const result = await pool.query<InboxRow>(`SELECT n.id AS "notificationId",e.id AS "eventId",e."createdAt" AS "createdAt",to_char(e."createdAt" AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"+00:00"') AS "cursorCreatedAt",e."eventType" AS "eventType",e.title,e.message,e.severity::text AS severity,e."entityType" AS "entityType",e."entityId" AS "entityId",e.payload,n.status::text AS status,n."readAt" AS "readAt",email_status.email_delivery_status AS "emailDeliveryStatus",email_status.email_delivery_error AS "emailDeliveryError"
    FROM "NotificationEvent" e JOIN "Notification" n ON n."eventId"=e.id AND n."recipientType"='USER'::"NotificationRecipientType" AND n."recipientId"=$1 AND n.channel='IN_APP'::"NotificationChannel"
    LEFT JOIN LATERAL (SELECT email_n.status::text AS email_delivery_status,COALESCE(log."errorMessage",email_n."errorMessage") AS email_delivery_error FROM "Notification" email_n LEFT JOIN LATERAL (SELECT "errorMessage" FROM "NotificationDeliveryLog" WHERE "notificationId"=email_n.id ORDER BY "createdAt" DESC LIMIT 1) log ON TRUE WHERE email_n."eventId"=e.id AND email_n."recipientType"='USER'::"NotificationRecipientType" AND email_n."recipientId"=$1 AND email_n.channel='EMAIL'::"NotificationChannel" LIMIT 1) email_status ON TRUE
    WHERE e."eventType"<>'message.received' AND ($2::timestamptz IS NULL OR e."createdAt"<$2 OR (e."createdAt"=$2 AND e.id<COALESCE($3,''))) ORDER BY e."createdAt" DESC,e.id DESC LIMIT $4`, [userId, after?.timestamp ?? null, after?.eventId ?? null, limit + 1]);
    const hasMore = result.rows.length > limit;
    const visible = result.rows.slice(0, limit);
    const last = visible.at(-1);
    return { items: visible.map(row => { const { notificationId, readAt, cursorCreatedAt, ...item } = row; return { ...item, id: notificationId, isUnread: readAt === null && row.status !== 'DISMISSED' && row.status !== 'FAILED' }; }), nextCursor: hasMore && last ? encodeNotificationCursor(last.cursorCreatedAt, last.eventId) : null, unreadCount: await getUnreadNotificationCount(pool, userId) };
}
export async function markNotificationRead(pool: Pool, userId: string, id: string): Promise<number> { return (await pool.query(`UPDATE "Notification" SET "readAt"=NOW(),status='READ'::"NotificationStatus","updatedAt"=NOW() WHERE id=$1 AND "recipientType"='USER'::"NotificationRecipientType" AND "recipientId"=$2 AND channel='IN_APP'::"NotificationChannel" AND "readAt" IS NULL`, [id, userId])).rowCount ?? 0; }
export async function markAllNotificationsRead(pool: Pool, userId: string): Promise<number> { return (await pool.query(`UPDATE "Notification" SET "readAt"=NOW(),status='READ'::"NotificationStatus","updatedAt"=NOW() WHERE "recipientType"='USER'::"NotificationRecipientType" AND "recipientId"=$1 AND channel='IN_APP'::"NotificationChannel" AND "readAt" IS NULL AND status NOT IN ('DISMISSED'::"NotificationStatus",'FAILED'::"NotificationStatus")`, [userId])).rowCount ?? 0; }
export interface PushSubscriptionInput {
    endpoint?: string | null;
    expirationTime?: number | null;
    keys?: {
        p256dh?: string | null;
        auth?: string | null;
    } | null;
}
export interface PushNotificationPayload {
    title: string;
    body: string;
    url: string;
    tag: string | null;
}
export interface StoredPushSubscription {
    endpoint: string;
    p256dh: string;
    auth: string;
}
export type NotificationLogger = Pick<import('fastify').FastifyBaseLogger, 'warn' | 'info' | 'error'>;
const normalize = (value: string | null | undefined, field: string): string => { const result = value?.trim(); if (!result)
    throw new ApiError(400, 'bad_request', `Missing ${field}`); return result; };
export function webPushConfigured(context: CoreContext): boolean { return !!context.config.env.WEB_PUSH_VAPID_PUBLIC_KEY && !!context.config.env.WEB_PUSH_VAPID_PRIVATE_KEY; }
export async function getPushSubscriptionStatus(context: CoreContext, userId: string): Promise<{
    configured: boolean;
    publicKey: string | null;
    subscribed: boolean;
    subscriptionCount: number;
}> { const result = await context.pool.query<{
    count: string;
}>('SELECT COUNT(*) FROM "PushSubscription" WHERE "userId"=$1', [userId]); const subscriptionCount = Number(result.rows[0]!.count); return { configured: webPushConfigured(context), publicKey: context.config.env.WEB_PUSH_VAPID_PUBLIC_KEY ?? null, subscribed: subscriptionCount > 0, subscriptionCount }; }
export async function savePushSubscription(pool: Pool, userId: string, input: PushSubscriptionInput, userAgent?: string): Promise<void> {
    const endpoint = normalize(input.endpoint, 'subscription endpoint');
    if (!input.keys)
        throw new ApiError(400, 'bad_request', 'Missing subscription keys');
    const p256dh = normalize(input.keys.p256dh, 'subscription p256dh key'), auth = normalize(input.keys.auth, 'subscription auth key');
    await pool.query('INSERT INTO "PushSubscription" (id,"userId",endpoint,p256dh,auth,"expirationTime","userAgent","lastUsedAt","createdAt","updatedAt") VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW(),NOW()) ON CONFLICT(endpoint) DO UPDATE SET "userId"=EXCLUDED."userId",p256dh=EXCLUDED.p256dh,auth=EXCLUDED.auth,"expirationTime"=EXCLUDED."expirationTime","userAgent"=EXCLUDED."userAgent","lastUsedAt"=NOW(),"updatedAt"=NOW()', [createId(), userId, endpoint, p256dh, auth, input.expirationTime ?? null, userAgent ?? null]);
}
export async function deletePushSubscription(pool: Pool, userId: string, endpoint: string): Promise<number> { return (await pool.query('DELETE FROM "PushSubscription" WHERE "userId"=$1 AND endpoint=$2', [userId, endpoint])).rowCount ?? 0; }
export function webPushOptions(context: CoreContext): webpush.RequestOptions {
    const privateKey = context.config.env.WEB_PUSH_VAPID_PRIVATE_KEY;
    if (!privateKey)
        throw new ApiError(500, 'internal_error', 'WEB_PUSH_VAPID_PRIVATE_KEY is not configured');
    const key = createECDH('prime256v1');
    key.setPrivateKey(Buffer.from(privateKey, 'base64url'));
    return { contentEncoding: 'aes128gcm', TTL: 2419200, vapidDetails: { subject: context.config.env.WEB_PUSH_SUBJECT ?? 'mailto:hello@kasitek.co.za', publicKey: key.getPublicKey().toString('base64url'), privateKey } };
}
export type PushSender = (subscription: StoredPushSubscription, payload: PushNotificationPayload) => Promise<void>;
export async function sendPushNotificationToUser(context: CoreContext, userId: string, payload: PushNotificationPayload, logger?: NotificationLogger, sender: PushSender = async (subscription, message) => { await webpush.sendNotification({ endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } }, JSON.stringify(message), webPushOptions(context)); }): Promise<number> {
    if (!webPushConfigured(context))
        return 0;
    const subscriptions = (await context.pool.query<StoredPushSubscription>('SELECT endpoint,p256dh,auth FROM "PushSubscription" WHERE "userId"=$1 ORDER BY "updatedAt" DESC', [userId])).rows;
    let delivered = 0;
    for (const subscription of subscriptions) {
        try {
            await sender(subscription, payload);
            delivered++;
            try {
                await context.pool.query('UPDATE "PushSubscription" SET "lastUsedAt"=NOW(),"updatedAt"=NOW() WHERE endpoint=$1', [subscription.endpoint]);
            }
            catch {
                logger?.warn({ event: 'operation.failed', operation: 'push_subscription.touch' }, 'push subscription timestamp update failed');
            }
        }
        catch (error) {
            const failure = error as Error & {
                statusCode?: number;
            };
            const message = failure instanceof Error ? failure.message : String(error);
            const stale = failure.statusCode === 404 || failure.statusCode === 410 || message.includes('410') || message.includes('404') || message.includes('unsubscribed') || message.includes('invalid subscription');
            if (stale)
                try {
                    await context.pool.query('DELETE FROM "PushSubscription" WHERE endpoint=$1', [subscription.endpoint]);
                }
                catch {
                    logger?.warn({ event: 'operation.failed', operation: 'push_subscription.delete_stale' }, 'stale push subscription deletion failed');
                }
            logger?.warn({ event: 'provider.call.failed', provider: 'web_push', operation: 'notification.send', user_id: userId, stale_subscription: stale, error_type: 'delivery_failed' }, 'web push delivery failed');
        }
    }
    return delivered;
}
