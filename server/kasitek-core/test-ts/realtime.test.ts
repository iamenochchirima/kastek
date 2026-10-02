import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { randomUUID, createECDH, randomBytes } from 'node:crypto';
import { get } from 'node:http';
import pg from 'pg';
import webpush from 'web-push';
import { readConfig } from '../src-ts/config.js';
import { buildApp } from '../src-ts/app.js';
import { installPgTimestampParsers } from '../src-ts/db.js';
import { registerRealtimeRoutes } from '../src-ts/routes/realtime.js';
import { buildInboxOrgChannel, createRealtimeStream, type RealtimeRedisClient, publishInboxEvent, enqueueWhatsappInboxMessage, drainWhatsappInboxQueue } from '../src-ts/services/realtime.js';
import { decodeNotificationCursor, encodeNotificationCursor, listNotificationInbox, getUnreadNotificationCount, markNotificationRead, markAllNotificationsRead, savePushSubscription, deletePushSubscription, getPushSubscriptionStatus, sendPushNotificationToUser, webPushOptions } from '../src-ts/services/notifications.js';
import type { CoreContext } from '../src-ts/context.js';
test('cursor parsing, AES128GCM encrypted push generation and stream ownership preserve the protocol', async () => {
    const timestamp = '2026-10-02T10:20:30.123456+00:00';
    assert.deepEqual(decodeNotificationCursor(encodeNotificationCursor(timestamp, 'event-id')), { timestamp, eventId: 'event-id' });
    for (const cursor of ['notbase64', Buffer.from('2026-02-30T10:20:30Z|id').toString('base64'), Buffer.from([0xff]).toString('base64')])
        assert.equal(decodeNotificationCursor(cursor), null);
    const vapid = webpush.generateVAPIDKeys();
    const dh = createECDH('prime256v1');
    dh.generateKeys();
    const context = { config: readConfig({ DATABASE_URL: 'postgres://unused', WEB_PUSH_VAPID_PUBLIC_KEY: vapid.publicKey, WEB_PUSH_VAPID_PRIVATE_KEY: vapid.privateKey }) } as CoreContext;
    const details = webpush.generateRequestDetails({ endpoint: 'https://push.example.test/subscription', keys: { p256dh: dh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } }, JSON.stringify({ title: 'Synthetic', body: 'Body', url: '/workspace', tag: null }), webPushOptions(context));
    assert.equal(details.headers['Content-Encoding'], 'aes128gcm');
    assert.equal(String(details.headers.TTL), '2419200');
    assert.ok(details.body && details.body.length > 0);
    assert.match(String(details.headers.Authorization), /^vapid /);
    let destroyed = false;
    let subscribed = '';
    let message: ((value: string) => void) | undefined;
    const client = Object.assign(new EventEmitter(), { isOpen: true, subscribe: async (channel: string, listener: (value: string) => void) => { subscribed = channel; message = listener; }, destroy() { destroyed = true; this.isOpen = false; } }) as unknown as RealtimeRedisClient;
    const stream = createRealtimeStream(client, buildInboxOrgChannel('org-a'));
    const chunks: string[] = [];
    stream.on('data', chunk => chunks.push(chunk.toString()));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(subscribed, 'whatsapp:org:org-a');
    message!('{"event":"message"}');
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(chunks.join('').includes('event: ready\ndata: {}\n\n'));
    assert.ok(chunks.join('').includes('data: {"event":"message"}\n\n'));
    stream.destroy();
    await once(stream, 'close');
    assert.equal(destroyed, true);
    const missing = { config: readConfig({ DATABASE_URL: 'postgres://unused' }) } as CoreContext;
    await publishInboxEvent(missing, 'org', {});
    await enqueueWhatsappInboxMessage(missing, 'id');
    assert.deepEqual(await drainWhatsappInboxQueue(missing, 10), []);
});
test('SSE HTTP stream rechecks membership, owns the active organization and shuts down without hanging', async () => {
    const user = { id: 'u', name: 'Synthetic', email: 'u@example.test', phone: null, image: null, emailVerified: new Date(), createdAt: new Date(), updatedAt: new Date() };
    let member = false;
    const connection = { query: async (text: string) => ({ rows: text.includes('FROM "Session"') ? [{ userId: 'u', refreshToken: 'unused', check: false, refresh: false }] : [] }), release: () => { } };
    const pool = { connect: async () => connection, query: async (text: string) => ({ rows: text.includes('FROM "User"') ? [user] : text.includes('FROM "OrganizationMember"') ? (member ? [{ orgId: 'allowed' }] : []) : [] }) } as unknown as pg.Pool;
    const app = await buildApp({ pool, config: readConfig({ DATABASE_URL: 'postgres://unused', LOG_LEVEL: 'silent' }) }, [registerRealtimeRoutes]);
    await app.listen({ host: '127.0.0.1', port: 0 });
    const address = app.server.address();
    assert.ok(address && typeof address === 'object');
    const denied = await app.inject({ url: '/api/realtime/whatsapp', headers: { cookie: 'kasitek_session=opaque; kasitek_active_org=other' } });
    assert.equal(denied.statusCode, 403);
    member = true;
    const incoming = get(`http://127.0.0.1:${address.port}/api/realtime/whatsapp`, { headers: { cookie: 'kasitek_session=opaque; kasitek_active_org=allowed' } });
    const [response] = await once(incoming, 'response');
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['content-type'], 'text/event-stream');
    assert.equal(response.headers['cache-control'], 'no-cache, no-transform');
    const [first] = await once(response, 'data');
    assert.equal(first.toString(), 'event: ready\ndata: {}\n\n');
    const timeout = setTimeout(() => { incoming.destroy(); response.destroy(); }, 2000);
    try {
        await Promise.race([app.close(), new Promise<never>((_, reject) => setTimeout(() => reject(Error('SSE shutdown hung')), 1500))]);
    }
    finally {
        clearTimeout(timeout);
        incoming.destroy();
        response.destroy();
    }
});
test('isolated notification inbox keyset/email status/unread and push persistence/delivery lifecycle', { skip: !process.env.CORE_REALTIME_TEST_DATABASE_URL }, async () => {
    installPgTimestampParsers();
    const url = process.env.CORE_REALTIME_TEST_DATABASE_URL!;
    const schema = `notifications_test_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema} -c timezone=UTC` });
    try {
        await pool.query(`CREATE TYPE "NotificationRecipientType" AS ENUM('USER','ADMIN');CREATE TYPE "NotificationChannel" AS ENUM('IN_APP','EMAIL');CREATE TYPE "NotificationStatus" AS ENUM('PENDING','READ','DISMISSED','FAILED','SENT');
      CREATE TABLE "NotificationEvent"(id text PRIMARY KEY,"createdAt" timestamptz,"eventType" text,title text,message text,severity text,"entityType" text,"entityId" text,payload jsonb);
      CREATE TABLE "Notification"(id text PRIMARY KEY,"eventId" text,"recipientType" "NotificationRecipientType","recipientId" text,channel "NotificationChannel",status "NotificationStatus","readAt" timestamp,"updatedAt" timestamp,"errorMessage" text);
      CREATE TABLE "NotificationDeliveryLog"("notificationId" text,"createdAt" timestamp,"errorMessage" text);
      CREATE TABLE "PushSubscription"(id text PRIMARY KEY,"userId" text,endpoint text UNIQUE,p256dh text,auth text,"expirationTime" bigint,"userAgent" text,"lastUsedAt" timestamp,"createdAt" timestamp,"updatedAt" timestamp);`);
        await pool.query(`INSERT INTO "NotificationEvent" VALUES('event-a','2026-10-02T10:20:30.123456Z','billing.updated','A','Body','INFO',NULL,NULL,NULL),('event-b','2026-10-02T10:20:30.123457Z','billing.updated','B','Body','INFO',NULL,NULL,'{}'),('hidden','2026-10-02T11:20:30Z','message.received','Hidden','Body','INFO',NULL,NULL,NULL),('failed','2026-10-01T10:20:30Z','billing.updated','Failed','Body','INFO',NULL,NULL,NULL);
      INSERT INTO "Notification"(id,"eventId","recipientType","recipientId",channel,status) VALUES('a','event-a','USER','u','IN_APP','PENDING'),('b','event-b','USER','u','IN_APP','PENDING'),('h','hidden','USER','u','IN_APP','PENDING'),('f','failed','USER','u','IN_APP','FAILED'),('other','event-a','USER','other','IN_APP','PENDING'),('email','event-b','USER','u','EMAIL','FAILED');
      INSERT INTO "NotificationDeliveryLog" VALUES('email',NOW(),'Synthetic email failure');`);
        const first = await listNotificationInbox(pool, 'u', 1);
        assert.equal(first.items[0]!.id, 'b');
        assert.equal(first.unreadCount, 2);
        assert.equal(first.items[0]!.emailDeliveryError, 'Synthetic email failure');
        assert.ok(first.nextCursor);
        const second = await listNotificationInbox(pool, 'u', 1, first.nextCursor!);
        assert.equal(second.items[0]!.id, 'a');
        assert.ok(second.nextCursor);
        const last = await listNotificationInbox(pool, 'u', 1, second.nextCursor!);
        assert.equal(last.items[0]!.id, 'f');
        assert.equal(last.items[0]!.isUnread, false);
        assert.equal(last.nextCursor, null);
        assert.equal((await listNotificationInbox(pool, 'u', 1, 'bad cursor')).items[0]!.id, 'b');
        assert.equal(await markNotificationRead(pool, 'other', 'b'), 0);
        assert.equal(await markNotificationRead(pool, 'u', 'b'), 1);
        assert.equal(await markNotificationRead(pool, 'u', 'b'), 0);
        assert.equal(await getUnreadNotificationCount(pool, 'u'), 1);
        assert.equal(await markAllNotificationsRead(pool, 'u'), 2);
        assert.equal(await getUnreadNotificationCount(pool, 'u'), 0);
        await savePushSubscription(pool, 'u', { endpoint: ' https://push.example.test/a ', keys: { p256dh: ' p ', auth: ' a ' }, expirationTime: 123 }, 'synthetic');
        await savePushSubscription(pool, 'other', { endpoint: 'https://push.example.test/a', keys: { p256dh: 'updated', auth: 'updated' } }, 'other');
        assert.equal(await deletePushSubscription(pool, 'u', 'https://push.example.test/a'), 0);
        const context = { pool, config: readConfig({ DATABASE_URL: url, WEB_PUSH_VAPID_PUBLIC_KEY: 'configured', WEB_PUSH_VAPID_PRIVATE_KEY: 'configured' }) };
        assert.equal((await getPushSubscriptionStatus(context, 'other')).subscriptionCount, 1);
        await savePushSubscription(pool, 'other', { endpoint: 'https://push.example.test/b', keys: { p256dh: 'p', auth: 'a' } });
        const delivered = await sendPushNotificationToUser(context, 'other', { title: 'Synthetic', body: 'Body', url: '/', tag: null }, undefined, async (subscription) => { if (subscription.endpoint.endsWith('/a'))
            throw Object.assign(new Error('gone'), { statusCode: 410 }); });
        assert.equal(delivered, 1);
        assert.equal((await getPushSubscriptionStatus(context, 'other')).subscriptionCount, 1);
        assert.equal(await sendPushNotificationToUser({ pool, config: readConfig({ DATABASE_URL: url }) }, 'other', { title: 'Synthetic', body: 'Body', url: '/', tag: null }), 0);
        await assert.rejects(savePushSubscription(pool, 'u', { endpoint: 'x' }), /Missing subscription keys/);
    }
    finally {
        await pool.end();
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
    }
});
