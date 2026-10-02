import { createHmac, timingSafeEqual } from 'node:crypto';
import type { CoreConfig } from '../../config.js';
import { ApiError } from '../../error.js';
import { decryptSocialSecret } from '../../integrations/crypto.js';
import { obj, str, type MetaScope, type InboxOptions } from './types.js';
import { parseMetaConversationIdentifier } from './read.js';
export const META_GRAPH_BASE = 'https://graph.facebook.com/v23.0';
export const INSTAGRAM_GRAPH_BASE = 'https://graph.instagram.com/v23.0';
export function verifyMetaWebhookRequest(
  config: CoreConfig,
  query: Record<string, string>,
) {
  const mode = query['hub.mode'] ?? '',
    challenge = query['hub.challenge'] ?? '',
    token = query['hub.verify_token'] ?? '',
    expected =
      config.rawEnv.META_WEBHOOK_VERIFY_TOKEN ??
      config.rawEnv.AUTH_META_WEBHOOK_VERIFY_TOKEN ??
      '';
  if (mode !== 'subscribe' || !challenge)
    throw new ApiError(400, 'bad_request', 'Invalid verification request');
  if (!expected || token !== expected)
    throw new ApiError(403, 'forbidden', 'Invalid verify token');
  return challenge;
}
export function verifyMetaWebhookSignature(
  config: CoreConfig,
  signature: string | undefined,
  body: Uint8Array,
) {
  const secrets = [
    ...new Set(
      [
        config.rawEnv.AUTH_META_APP_SECRET,
        config.rawEnv.AUTH_INSTAGRAM_APP_SECRET,
      ].filter((v): v is string => v !== undefined && !!v.trim()),
    ),
  ];
  if (!secrets.length)
    throw new ApiError(
      403,
      'forbidden',
      'Meta webhook secret is not configured',
    );
  if (signature?.startsWith('sha256=')) {
    const hex = signature.slice(7);
    if (/^(?:[a-fA-F0-9]{2})+$/.test(hex)) {
      const bytes = Buffer.from(hex, 'hex');
      if (
        secrets.some((secret) => {
          const expected = createHmac('sha256', secret).update(body).digest();
          return (
            expected.length === bytes.length && timingSafeEqual(expected, bytes)
          );
        })
      )
        return;
    }
  }
  throw new ApiError(403, 'forbidden', 'Invalid Meta webhook signature');
}
export function metaMessageSenderAssetId(
  channel: string,
  direct: boolean,
  externalId: string | null,
  metadata: unknown,
) {
  const value =
    channel === 'instagram' && !direct ? str(obj(metadata).pageId) : externalId;
  return value?.trim() || null;
}
export async function fetchMetaJson(
  url: string,
  init: RequestInit,
  failure: string,
  options: InboxOptions,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await (options.fetch ?? fetch)(url, init);
  } catch {
    throw new ApiError(500, 'internal_error', 'HTTP request failed');
  }
  const body = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    if (response.ok)
      throw new ApiError(
        500,
        'internal_error',
        'Failed to decode Meta response',
      );
  }
  if (!response.ok)
    throw new ApiError(
      400,
      'bad_request',
      str(obj(obj(payload).error).message) ??
        `${failure} (${response.status} ${response.statusText})`,
    );
  return obj(payload);
}
export function metaTransport(scope: MetaScope, options: InboxOptions) {
  const parsed = parseMetaConversationIdentifier(scope.customer_identifier);
  if (!parsed)
    throw new ApiError(400, 'bad_request', 'Invalid Meta conversation');
  if (scope.access_token === null)
    throw new ApiError(
      400,
      'bad_request',
      'Connected channel is missing an access token',
    );
  const direct = scope.metadata?.authMethod === 'instagram_login',
    asset = metaMessageSenderAssetId(
      scope.channel,
      direct,
      scope.external_account_id,
      scope.metadata,
    );
  if (asset === null)
    throw new ApiError(
      400,
      'bad_request',
      scope.channel === 'instagram' && !direct
        ? 'Connected Instagram channel is missing its linked Facebook Page ID. Reconnect it through Meta.'
        : 'Connected Meta channel is missing a target asset',
    );
  return {
    customer: parsed[1],
    direct,
    url: `${direct ? INSTAGRAM_GRAPH_BASE : META_GRAPH_BASE}/${asset}/messages`,
    token: decryptSocialSecret(options.config, scope.access_token),
  };
}
export async function sendMetaTextMessage(
  scope: MetaScope,
  text: string,
  replyTo: string | null,
  options: InboxOptions,
) {
  const transport = metaTransport(scope, options),
    message = {
      text,
      ...(replyTo !== null ? { reply_to: { mid: replyTo } } : {}),
    };
  const payload = await fetchMetaJson(
    transport.url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${transport.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        recipient: { id: transport.customer },
        ...(!transport.direct ? { messaging_type: 'RESPONSE' } : {}),
        message,
      }),
    },
    'Failed to send Meta message',
    options,
  );
  if (
    payload.message_id !== undefined &&
    payload.message_id !== null &&
    typeof payload.message_id !== 'string'
  )
    throw new ApiError(500, 'internal_error', 'Failed to decode Meta response');
  return str(payload.message_id);
}
export async function sendMetaMarkSeen(
  scope: MetaScope,
  options: InboxOptions,
) {
  const transport = metaTransport(scope, options);
  await fetchMetaJson(
    transport.url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${transport.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        recipient: { id: transport.customer },
        sender_action: 'mark_seen',
      }),
    },
    'Failed to send Meta read receipt',
    options,
  );
}
export function isMetaAuthenticationFailure(error: string) {
  const s = error.toLowerCase();
  return [
    '401 unauthorized',
    '403 forbidden',
    'invalid oauth access token',
    'authentication',
  ].some((v) => s.includes(v));
}

export function rustErrorDisplay(error: unknown): string {
  if (!(error instanceof ApiError))
    return error instanceof Error ? error.message : String(error);
  if (error.code === 'unauthorized') return 'unauthorized';
  const names: Record<string, string> = {
    bad_request: 'bad request',
    unsupported_principal: 'unsupported principal',
    forbidden: 'forbidden',
    not_found: 'not found',
    conflict: 'conflict',
    too_many_requests: 'too many requests',
    service_unavailable: 'service unavailable',
    bad_gateway: 'bad gateway',
    gateway_timeout: 'gateway timeout',
    internal_error: 'internal',
  };
  return `${names[error.code] ?? 'upstream'}: ${error.message}`;
}
