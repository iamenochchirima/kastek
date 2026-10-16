import { apiJson } from '../json.js';
import { PassThrough } from 'node:stream';
import { createClient } from 'redis';
import type { CoreContext } from '../context.js';
import { ApiError } from '../error.js';
import type { NotificationLogger } from './notifications.js';
export type RealtimeRedisClient = ReturnType<typeof createClient>;
export const buildInboxOrgChannel = (orgId: string): string => `whatsapp:org:${orgId}`;
export const buildWhatsappOrgChannel = buildInboxOrgChannel;
export const WHATSAPP_INBOX_QUEUE_KEY = 'whatsapp:inbox:outbound';
function redisClient(context: CoreContext): RealtimeRedisClient | null {
    const url = context.config.env.REDIS_URL;
    if (!url)
        return null;
    try {
        return createClient({ url, socket: { reconnectStrategy: false } });
    }
    catch {
        return null;
    }
}
async function connected(context: CoreContext): Promise<RealtimeRedisClient | null> {
    const client = redisClient(context);
    if (!client)
        return null;
    client.on('error', () => { });
    try {
        await client.connect();
        return client;
    }
    catch {
        if (client.isOpen)
            client.destroy();
        throw new ApiError(500, 'internal_error', 'Failed to connect to realtime Redis');
    }
}
export async function createPubsub(context: CoreContext): Promise<RealtimeRedisClient | null> { return connected(context); }
export async function publishInboxEvent(context: CoreContext, orgId: string, event: unknown, logger?: NotificationLogger): Promise<void> {
    const client = await connected(context);
    if (!client) {
        logger?.warn({ event: 'dependency.unavailable', dependency: 'redis', operation: 'realtime.publish', organization_id: orgId, reason: 'missing_configuration' }, 'realtime publish skipped');
        return;
    }
    try {
        let payload: string;
        try {
            payload = apiJson(event);
            if (payload === undefined)
                throw Error();
        }
        catch {
            throw new ApiError(500, 'internal_error', 'Failed to encode realtime event');
        }
        let subscribers: number;
        try {
            subscribers = await client.publish(buildInboxOrgChannel(orgId), payload);
        }
        catch {
            throw new ApiError(500, 'internal_error', 'Failed to publish realtime event');
        }
        logger?.info({ event: 'provider.call.completed', provider: 'redis', operation: 'realtime.publish', organization_id: orgId, subscribers }, 'realtime event published');
    }
    finally {
        if (client.isOpen)
            client.destroy();
    }
}
export const publishWhatsappEvent = publishInboxEvent;
export async function enqueueWhatsappInboxMessage(context: CoreContext, messageId: string): Promise<void> {
    const client = await connected(context);
    if (!client)
        return;
    try {
        await client.lPush(WHATSAPP_INBOX_QUEUE_KEY, messageId);
    }
    catch {
        throw new ApiError(500, 'internal_error', 'Failed to enqueue inbox job');
    }
    finally {
        if (client.isOpen)
            client.destroy();
    }
}
export async function drainWhatsappInboxQueue(context: CoreContext, limit: number): Promise<string[]> {
    if (limit === 0)
        return [];
    const client = await connected(context);
    if (!client)
        return [];
    try {
        const ids: string[] = [];
        for (let i = 0; i < limit; i++) {
            const id = await client.rPop(WHATSAPP_INBOX_QUEUE_KEY);
            if (id === null)
                break;
            ids.push(id);
        }
        return ids;
    }
    catch {
        throw new ApiError(500, 'internal_error', 'Failed to drain inbox queue');
    }
    finally {
        if (client.isOpen)
            client.destroy();
    }
}
/** Each SSE connection owns its subscriber and timer; disconnect destroys both. */
export function createRealtimeStream(client: RealtimeRedisClient | null, channel: string, logger?: NotificationLogger): PassThrough {
    const stream = new PassThrough();
    let timer: NodeJS.Timeout | undefined;
    let closed = false;
    const schedule = () => { if (timer)
        clearTimeout(timer); if (closed)
        return; timer = setTimeout(() => { stream.write(': keepalive\n\n'); schedule(); }, 15000); timer.unref(); };
    const close = () => { if (closed)
        return; closed = true; if (timer)
        clearTimeout(timer); if (client?.isOpen)
        client.destroy(); };
    stream.once('close', close);
    stream.once('error', close);
    stream.once('finish', close);
    stream.write('event: ready\ndata: {}\n\n');
    schedule();
    if (!client) {
        logger?.warn({ event: 'dependency.unavailable', dependency: 'redis', operation: 'realtime.subscribe', reason: 'missing_configuration' }, 'realtime stream using keepalive-only mode');
        return stream;
    }
    client.on('error', error => { if (!closed)
        stream.destroy(error); });
    // subscription begins after ready, matching Rust's lazy response stream.
    void (async () => {
        try {
            logger?.info({ event: 'provider.call.completed', provider: 'redis', operation: 'realtime.subscribe', channel, phase: 'starting' }, 'realtime subscription starting');
            await client.subscribe(channel, payload => { if (!closed) {
                stream.write(`data: ${payload}\n\n`);
                schedule();
            } });
            if (!closed)
                logger?.info({ event: 'provider.call.completed', provider: 'redis', operation: 'realtime.subscribe', channel, phase: 'completed' }, 'realtime subscription established');
        }
        catch (error) {
            logger?.error({ event: 'dependency.unavailable', dependency: 'redis', operation: 'realtime.subscribe', channel, error_type: error instanceof Error ? error.name : 'Error' }, 'realtime subscription failed');
            if (!closed)
                stream.destroy(error instanceof Error ? error : new Error('realtime subscription failed'));
        }
    })();
    return stream;
}
