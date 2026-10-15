import type { Pool, PoolClient } from 'pg';
import { createId } from '@paralleldrive/cuid2';
import { decryptSocialSecret } from '../../integrations/crypto.js';
import { ensureMetaCustomer } from '../customers.js';
import {
  enqueueConversationLifecycle,
  enqueueMessageLifecycle,
} from './analytics.js';
import { transaction, enqueueMetaSourceManifest } from './send.js';
import { META_GRAPH_BASE, INSTAGRAM_GRAPH_BASE } from './meta-provider.js';
import {
  metaProfileDisplayName,
  metaMessageResponderType,
} from './meta-shapes.js';
import * as sql from './inbox-sql.js';
import { str, type InboxOptions, type MetaChannel } from './types.js';
export const channelName = (channel: MetaChannel) =>
  channel.platform === 'INSTAGRAM' ? 'instagram' : 'facebook';
export async function resolveMetaChannel(
  pool: Pool,
  object: string,
  id: string,
): Promise<MetaChannel | null> {
  const direct = (
    await pool.query<MetaChannel>(sql.RESOLVE_META_CHANNEL_0, [
      object === 'instagram' ? 'INSTAGRAM' : 'FACEBOOK',
      id,
    ])
  ).rows;
  if (direct.length === 1) return direct[0]!;
  if (direct.length > 1) return null;
  const fallback = (
    await pool.query<MetaChannel>(sql.RESOLVE_META_CHANNEL_1, [id])
  ).rows;
  return fallback.length === 1 ? fallback[0]! : null;
}
export async function findOrCreateMetaConversation(
  pool: Pool,
  channel: MetaChannel,
  customerId: string,
  name: string | null,
) {
  const type = channelName(channel),
    customer =
      channel.org_id === null
        ? null
        : await ensureMetaCustomer(
            pool,
            channel.org_id,
            type,
            channel.id,
            customerId,
            name,
          );
  return transaction(pool, async (tx) => {
    const row = (
      await tx.query<{ id: string; unreadCount: number; created: boolean }>(
        sql.FIND_OR_CREATE_META_CONVERSATION_0,
        [
          createId(),
          type,
          `meta:${channel.id}:${customerId}`,
          name,
          'active',
          channel.org_id,
          channel.external_connection_id,
          customer,
        ],
      )
    ).rows[0]!;
    if (row.created)
      await enqueueConversationLifecycle(
        tx,
        channel.org_id ?? '',
        row.id,
        type,
        'opened',
        'active',
        'customer',
        new Date(),
      );
    return row;
  });
}
export async function resolveMetaCustomerName(
  pool: Pool,
  channel: MetaChannel,
  id: string,
  options: InboxOptions,
): Promise<string | null> {
  const row = (
      await pool.query(sql.RESOLVE_META_CUSTOMER_NAME_0, [
        channelName(channel),
        `meta:${channel.id}:${id}`,
        channel.org_id,
      ])
    ).rows[0],
    existing = str(row?.customerName)?.trim();
  if (existing) return existing;
  if (!channel.access_token) return null;
  try {
    const token = decryptSocialSecret(options.config, channel.access_token),
      direct = channel.metadata?.authMethod === 'instagram_login',
      base = direct ? INSTAGRAM_GRAPH_BASE : META_GRAPH_BASE,
      fields = direct
        ? 'name,username'
        : channel.platform === 'INSTAGRAM'
          ? 'name,username,profile_pic'
          : 'first_name,last_name,profile_pic',
      response = await (options.fetch ?? fetch)(
        `${base}/${id}?fields=${encodeURIComponent(fields)}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(4000),
        },
      );
    return response.ok ? metaProfileDisplayName(await response.json()) : null;
  } catch {
    return null;
  }
}
export async function enqueueMetaMessageLifecycle(
  tx: PoolClient,
  ids: Set<string>,
  action: string,
  status: string | null,
  time: Date,
) {
  if (!ids.size) return;
  const rows = (
    await tx.query(sql.LOAD_META_MESSAGE_ANALYTICS_ROWS_0, [[...ids]])
  ).rows;
  let org: string | null = null;
  for (const row of rows) {
    if (!row.org_id) continue;
    org = row.org_id;
    await enqueueMessageLifecycle(
      tx,
      row.org_id,
      row.id,
      row.conversation_id,
      row.channel,
      action,
      row.sender === 'customer' ? 'inbound' : 'outbound',
      metaMessageResponderType({
        sender: row.sender,
        provider_metadata: row.provider_metadata,
      }),
      str(row.message_type)?.toLowerCase() ?? 'text',
      status,
      null,
      time,
    );
  }
  if (org !== null) await enqueueMetaSourceManifest(tx, org, time);
}
