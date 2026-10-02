import type { Pool } from 'pg';
import type { CoreConfig } from '../config.js';
import { ApiError } from '../error.js';
import { createId } from '@paralleldrive/cuid2';
import {
  createECDH,
  createPrivateKey,
  sign,
  createHash,
  type KeyObject,
} from 'node:crypto';
import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';
import { generateToken, sha256Base64Url } from '@kasitek/server-support/crypto';
import { encryptSocialSecret, decryptSocialSecret } from './crypto.js';
import { requiredScopes } from './provider-permissions.js';
import type { HttpFetch } from './email.js';
export interface BlueskyTransport {
  fetch: HttpFetch;
  lookup: (host: string) => Promise<{ address: string; family: number }[]>;
}
const native: BlueskyTransport = {
  fetch,
  lookup: (host) => lookup(host, { all: true }),
};
export interface CompletedAuthorization {
  userId: string;
  orgId: string;
  did: string;
  handle: string;
  accessToken: string;
  refreshToken: string;
  pdsUrl: string;
  authorizationUrl: string;
  dpopPrivateKey: string;
  authorizationNonce: string | null;
  expiresIn: number | null;
  scope: string | null;
}
export interface RefreshedSession {
  accessToken: string;
  refreshToken: string;
  authorizationNonce: string | null;
  expiresIn: number | null;
}
export interface BlueskyPostImage {
  bytes: Uint8Array;
  mimeType: string;
  altText: string;
}
interface SigningKey {
  key: KeyObject;
  privateBytes: Buffer;
  jwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
}
interface AuthorizationMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  pushed_authorization_request_endpoint: string;
}
interface AuthorizationRow {
  state: string;
  userId: string;
  orgId: string;
  handle: string | null;
  expectedDid: string;
  pdsUrl: string;
  authorizationUrl: string;
  codeVerifier: string;
  dpopPrivateKey: string;
  dpopNonce: string | null;
}
const bad = (message: string): never => {
  throw new ApiError(400, 'bad_request', message);
};
const appUrl = (config: CoreConfig) => config.publicApiUrl.replace(/\/+$/, '');
export const clientId = (config: CoreConfig) =>
  `${appUrl(config)}/api/social/oauth/bluesky/client-metadata`;
export const callbackUrl = (config: CoreConfig) =>
  `${appUrl(config)}/api/social/oauth/bluesky/callback`;
export function normalizeHandle(value: string): string {
  const handle = value.trim().replace(/^@+/, '');
  return !handle || handle.includes('.') ? handle : `${handle}.bsky.social`;
}
function keyFromBytes(bytes: Buffer, label: string): SigningKey {
  try {
    if (bytes.length !== 32) throw Error();
    const dh = createECDH('prime256v1');
    dh.setPrivateKey(bytes);
    const point = dh.getPublicKey(undefined, 'uncompressed'),
      jwk = {
        kty: 'EC' as const,
        crv: 'P-256' as const,
        x: point.subarray(1, 33).toString('base64url'),
        y: point.subarray(33).toString('base64url'),
      };
    return {
      key: createPrivateKey({
        format: 'jwk',
        key: { ...jwk, d: bytes.toString('base64url') },
      }),
      privateBytes: bytes,
      jwk,
    };
  } catch {
    throw new ApiError(
      500,
      'internal_error',
      `${label} must be a 32-byte P-256 key`,
    );
  }
}
function signingKey(encoded: string, label: string): SigningKey {
  const value = encoded.trim();
  if (
    !/^[A-Za-z0-9_-]+$/.test(value) ||
    Buffer.from(value, 'base64url').toString('base64url') !== value
  )
    throw new ApiError(500, 'internal_error', `${label} must be base64url`);
  return keyFromBytes(Buffer.from(value, 'base64url'), label);
}
function clientKey(config: CoreConfig): SigningKey {
  const value = config.rawEnv.AUTH_BLUESKY_OAUTH_CLIENT_PRIVATE_KEY;
  if (value === undefined)
    throw new ApiError(
      500,
      'internal_error',
      'AUTH_BLUESKY_OAUTH_CLIENT_PRIVATE_KEY is required',
    );
  return signingKey(value, 'AUTH_BLUESKY_OAUTH_CLIENT_PRIVATE_KEY');
}
function newKey(): SigningKey {
  const dh = createECDH('prime256v1');
  dh.generateKeys();
  return keyFromBytes(dh.getPrivateKey(), 'Bluesky DPoP key');
}
function keyId(config: CoreConfig): string {
  return (
    config.rawEnv.AUTH_BLUESKY_OAUTH_CLIENT_KEY_ID ?? 'kasitek-bluesky-oauth-1'
  );
}
function jwt(
  key: SigningKey,
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
): string {
  const input =
    Buffer.from(JSON.stringify(header)).toString('base64url') +
    '.' +
    Buffer.from(JSON.stringify(claims)).toString('base64url');
  return (
    input +
    '.' +
    sign('sha256', Buffer.from(input), {
      key: key.key,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url')
  );
}
function clientAssertion(config: CoreConfig, audience: string): string {
  const id = clientId(config),
    now = Math.floor(Date.now() / 1000);
  return jwt(
    clientKey(config),
    { alg: 'ES256', typ: 'JWT', kid: keyId(config) },
    {
      iss: id,
      sub: id,
      aud: audience,
      jti: generateToken(18),
      iat: now,
      exp: now + 60,
    },
  );
}
export function dpopProof(
  encoded: string,
  method: string,
  url: string,
  nonce: string | null,
  accessToken: string | null,
): string {
  const key = signingKey(encoded, 'Bluesky DPoP key'),
    now = Math.floor(Date.now() / 1000);
  return jwt(
    key,
    { typ: 'dpop+jwt', alg: 'ES256', jwk: key.jwk },
    {
      jti: generateToken(18),
      htm: method,
      htu: url,
      iat: now,
      exp: now + 60,
      ...(nonce === null ? {} : { nonce }),
      ...(accessToken === null
        ? {}
        : {
            ath: createHash('sha256').update(accessToken).digest('base64url'),
          }),
    },
  );
}
export function isPublicIp(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 168) ||
      address === '0.0.0.0'
    );
  }
  if (family === 6) {
    const v = new URL(`https://[${address}]/`).hostname
      .slice(1, -1)
      .toLowerCase();
    if (v === '::' || v === '::1') return false;
    const first = parseInt(v.split(':')[0] || '0', 16);
    return !((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80);
  }
  return false;
}
export function validatePublicHttps(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    bad(`Invalid Bluesky ${label} URL`);
  }
  if (url!.protocol !== 'https:' || url!.username || url!.password)
    bad(`Bluesky ${label} must use public HTTPS`);
  const host = url!.hostname.replace(/^\[|\]$/g, '');
  if (!host) bad(`Invalid Bluesky ${label} host`);
  if (
    host.toLowerCase() === 'localhost' ||
    host.endsWith('.localhost') ||
    (isIP(host) && !isPublicIp(host))
  )
    bad(`Bluesky ${label} host is not public`);
  return url!;
}
export async function validatePublicNetworkUrl(
  value: string,
  label: string,
  transport: BlueskyTransport = native,
): Promise<URL> {
  const url = validatePublicHttps(value, label),
    host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses: { address: string; family: number }[];
  try {
    addresses = await transport.lookup(host);
  } catch {
    bad(`Could not resolve Bluesky ${label} host`);
  }
  if (!addresses!.length || addresses!.some((v) => !isPublicIp(v.address)))
    bad(`Bluesky ${label} resolved to a non-public address`);
  return url;
}
export function clientMetadata(config: CoreConfig): Record<string, unknown> {
  const id = clientId(config);
  validatePublicHttps(id, 'client metadata');
  return {
    client_id: id,
    client_name: 'KasiTek',
    client_uri: appUrl(config),
    application_type: 'web',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    redirect_uris: [callbackUrl(config)],
    scope: 'atproto repo:app.bsky.feed.post blob:*/*',
    dpop_bound_access_tokens: true,
    token_endpoint_auth_method: 'private_key_jwt',
    token_endpoint_auth_signing_alg: 'ES256',
    jwks: {
      keys: [
        {
          ...clientKey(config).jwk,
          kid: keyId(config),
          use: 'sig',
          alg: 'ES256',
        },
      ],
    },
  };
}
async function send(
  transport: BlueskyTransport,
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  try {
    return await transport.fetch(url, {
      ...options,
      redirect: 'manual',
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    return bad('Bluesky provider request failed');
  }
}
async function jsonResponse(
  response: Response,
  context: string,
): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new ApiError(500, 'internal_error', 'External request failed');
  }
  if (!response.ok)
    bad(`${context}: ${Array.from(text).slice(0, 300).join('')}`);
  try {
    return JSON.parse(text);
  } catch {
    bad(`${context}: invalid JSON response`);
  }
}
function object(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    bad(`${context}: invalid JSON response`);
  return value as Record<string, unknown>;
}
function requiredString(
  value: Record<string, unknown>,
  key: string,
  context: string,
): string {
  if (typeof value[key] !== 'string') bad(`${context}: invalid JSON response`);
  return value[key] as string;
}
export async function verifyPublicClientMetadata(
  config: CoreConfig,
  transport: BlueskyTransport = native,
): Promise<void> {
  const endpoint = clientId(config);
  await validatePublicNetworkUrl(endpoint, 'client metadata', transport);
  const value = object(
    await jsonResponse(
      await send(transport, endpoint),
      'Bluesky client metadata is not publicly available',
    ),
    'Bluesky client metadata is not publicly available',
  );
  if (value.client_id !== endpoint)
    bad('Bluesky client metadata does not match KASITEK_CORE_PUBLIC_URL');
}
export function didDocumentUrl(did: string): string {
  if (did.startsWith('did:plc:')) return `https://plc.directory/${did}`;
  if (!did.startsWith('did:web:')) bad('Unsupported Bluesky DID method');
  const parts = did.slice('did:web:'.length).split(':');
  let host: string;
  try {
    host = decodeURIComponent(parts[0]!);
  } catch {
    bad('Invalid did:web hostname');
  }
  if (parts.length === 1) return `https://${host!}/.well-known/did.json`;
  let path: string;
  try {
    path = parts
      .slice(1)
      .map((v) => decodeURIComponent(v))
      .join('/');
  } catch {
    bad('Invalid did:web path');
  }
  return `https://${host!}/${path!}/did.json`;
}
async function resolveIdentity(
  handle: string,
  transport: BlueskyTransport,
): Promise<[string, string]> {
  const url = new URL(
    'https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle',
  );
  url.searchParams.set('handle', handle);
  const resolved = object(
      await jsonResponse(
        await send(transport, url.toString()),
        'Failed to resolve Bluesky handle',
      ),
      'Failed to resolve Bluesky handle',
    ),
    did = requiredString(resolved, 'did', 'Failed to resolve Bluesky handle'),
    didUrl = didDocumentUrl(did);
  await validatePublicNetworkUrl(didUrl, 'DID document', transport);
  const document = object(
    await jsonResponse(
      await send(transport, didUrl),
      'Failed to resolve Bluesky DID',
    ),
    'Failed to resolve Bluesky DID',
  );
  if (
    !Array.isArray(document.alsoKnownAs) ||
    !document.alsoKnownAs.some(
      (v) =>
        typeof v === 'string' &&
        v.toLowerCase() === `at://${handle}`.toLowerCase(),
    )
  )
    bad('Bluesky handle and DID do not verify each other');
  if (!Array.isArray(document.service)) bad('Bluesky DID has no PDS service');
  const service = (document.service as unknown[]).find(
    (v) =>
      v &&
      typeof v === 'object' &&
      typeof (v as Record<string, unknown>).id === 'string' &&
      ((v as Record<string, unknown>).id as string).endsWith('#atproto_pds'),
  );
  const pds =
    service && typeof service === 'object'
      ? (service as Record<string, unknown>).serviceEndpoint
      : null;
  if (typeof pds !== 'string') bad('Bluesky DID has no PDS endpoint');
  return [
    did,
    (await validatePublicNetworkUrl(pds! as string, 'PDS', transport))
      .toString()
      .replace(/\/+$/, ''),
  ];
}
async function metadataFromIssuer(
  value: string,
  transport: BlueskyTransport,
): Promise<AuthorizationMetadata> {
  const issuer = (
      await validatePublicNetworkUrl(value, 'authorization server', transport)
    )
      .toString()
      .replace(/\/+$/, ''),
    context = 'Failed to load Bluesky authorization metadata',
    raw = object(
      await jsonResponse(
        await send(
          transport,
          `${issuer}/.well-known/oauth-authorization-server`,
        ),
        context,
      ),
      context,
    );
  const metadata = {
    issuer: requiredString(raw, 'issuer', context),
    authorization_endpoint: requiredString(
      raw,
      'authorization_endpoint',
      context,
    ),
    token_endpoint: requiredString(raw, 'token_endpoint', context),
    pushed_authorization_request_endpoint: requiredString(
      raw,
      'pushed_authorization_request_endpoint',
      context,
    ),
  };
  if (metadata.issuer.replace(/\/+$/, '') !== issuer)
    bad('Bluesky authorization issuer mismatch');
  for (const endpoint of [
    metadata.authorization_endpoint,
    metadata.token_endpoint,
    metadata.pushed_authorization_request_endpoint,
  ])
    await validatePublicNetworkUrl(endpoint, 'OAuth endpoint', transport);
  return metadata;
}
async function authorizationMetadata(
  pds: string,
  transport: BlueskyTransport,
): Promise<AuthorizationMetadata> {
  await validatePublicNetworkUrl(pds, 'PDS', transport);
  const context = 'Failed to discover Bluesky authorization server',
    value = object(
      await jsonResponse(
        await send(transport, `${pds}/.well-known/oauth-protected-resource`),
        context,
      ),
      context,
    );
  if (
    !Array.isArray(value.authorization_servers) ||
    value.authorization_servers.some((v) => typeof v !== 'string')
  )
    bad(`${context}: invalid JSON response`);
  if (!(value.authorization_servers as string[])[0])
    bad('Bluesky PDS has no authorization server');
  return metadataFromIssuer(
    (value.authorization_servers as string[])[0]!,
    transport,
  );
}
async function postOAuthForm(
  config: CoreConfig,
  endpoint: string,
  issuer: string,
  key: string,
  nonce: string | null,
  form: Record<string, string>,
  transport: BlueskyTransport,
): Promise<[Response, string | null]> {
  const body = new URLSearchParams({
    ...form,
    client_assertion_type:
      'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
    client_assertion: clientAssertion(config, issuer),
  });
  const request = (value: string | null) =>
    send(transport, endpoint, {
      method: 'POST',
      headers: { DPoP: dpopProof(key, 'POST', endpoint, value, null) },
      body,
    });
  let response = await request(nonce),
    discovered = response.headers.get('DPoP-Nonce');
  if (!response.ok && discovered !== null && discovered !== nonce) {
    await response.body?.cancel();
    body.set('client_assertion', clientAssertion(config, issuer));
    response = await request(discovered);
    return [response, response.headers.get('DPoP-Nonce') ?? discovered];
  }
  return [response, discovered ?? nonce];
}
export function blueskyScopeForRequest(requested: string[]): string {
  if (!requested.length) return 'atproto repo:app.bsky.feed.post';
  const scopes = requiredScopes('Bluesky', requested);
  if (!scopes.includes('atproto')) scopes.unshift('atproto');
  return scopes.join(' ');
}
export const createAuthorizationState = () => generateToken(24);
export async function start(
  pool: Pool,
  config: CoreConfig,
  userId: string,
  orgId: string,
  handle: string,
  transport: BlueskyTransport = native,
): Promise<string> {
  return startWithState(
    pool,
    config,
    userId,
    orgId,
    handle,
    null,
    [],
    transport,
  );
}
export async function startWithState(
  pool: Pool,
  config: CoreConfig,
  userId: string,
  orgId: string,
  input: string,
  stateOverride: string | null,
  requested: string[],
  transport: BlueskyTransport = native,
): Promise<string> {
  await verifyPublicClientMetadata(config, transport);
  const handle = normalizeHandle(input);
  if (!handle) bad('Bluesky handle is required');
  const [did, pds] = await resolveIdentity(handle, transport),
    metadata = await authorizationMetadata(pds, transport),
    state = stateOverride ?? createAuthorizationState(),
    verifier = generateToken(48),
    key = newKey().privateBytes.toString('base64url');
  const [response, nonce] = await postOAuthForm(
      config,
      metadata.pushed_authorization_request_endpoint,
      metadata.issuer,
      key,
      null,
      {
        client_id: clientId(config),
        response_type: 'code',
        redirect_uri: callbackUrl(config),
        scope: blueskyScopeForRequest(requested),
        state,
        code_challenge: sha256Base64Url(verifier),
        code_challenge_method: 'S256',
        login_hint: handle,
      },
      transport,
    ),
    par = object(
      await jsonResponse(response, 'Bluesky authorization request failed'),
      'Bluesky authorization request failed',
    ),
    requestUri = requiredString(
      par,
      'request_uri',
      'Bluesky authorization request failed',
    );
  await pool.query(
    `DELETE FROM "SocialOAuthAuthorization" WHERE provider='BLUESKY' AND "expiresAt"<NOW()`,
  );
  await pool.query(
    `INSERT INTO "SocialOAuthAuthorization" (id,provider,state,"userId","orgId",handle,"expectedDid","pdsUrl","authorizationUrl","codeVerifier","dpopPrivateKey","dpopNonce","createdAt","expiresAt") VALUES ($1,'BLUESKY',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),$12)`,
    [
      createId(),
      state,
      userId,
      orgId,
      handle,
      did,
      pds,
      metadata.issuer,
      encryptSocialSecret(config, verifier),
      encryptSocialSecret(config, key),
      nonce,
      new Date(Date.now() + 600000),
    ],
  );
  const url = new URL(metadata.authorization_endpoint);
  url.searchParams.append('client_id', clientId(config));
  url.searchParams.append('request_uri', requestUri);
  return url.toString();
}
function tokenResponse(value: unknown, context: string) {
  const raw = object(value, context),
    accessToken = requiredString(raw, 'access_token', context),
    refreshToken = requiredString(raw, 'refresh_token', context),
    sub = requiredString(raw, 'sub', context);
  if (
    raw.expires_in != null &&
    (typeof raw.expires_in !== 'number' ||
      !Number.isSafeInteger(raw.expires_in))
  )
    bad(`${context}: invalid JSON response`);
  if (raw.scope != null && typeof raw.scope !== 'string')
    bad(`${context}: invalid JSON response`);
  return {
    accessToken,
    refreshToken,
    sub,
    expiresIn: raw.expires_in == null ? null : (raw.expires_in as number),
    scope: raw.scope == null ? null : (raw.scope as string),
  };
}
export async function complete(
  pool: Pool,
  config: CoreConfig,
  state: string,
  code: string,
  issuer: string,
  transport: BlueskyTransport = native,
): Promise<CompletedAuthorization> {
  const row = (
    await pool.query<AuthorizationRow>(
      `SELECT state,"userId","orgId",handle,"expectedDid","pdsUrl","authorizationUrl","codeVerifier","dpopPrivateKey","dpopNonce" FROM "SocialOAuthAuthorization" WHERE provider='BLUESKY' AND state=$1 AND "expiresAt">NOW() LIMIT 1`,
      [state],
    )
  ).rows[0];
  if (!row) bad('Invalid or expired Bluesky OAuth state');
  if (issuer.replace(/\/+$/, '') !== row!.authorizationUrl.replace(/\/+$/, ''))
    bad('Bluesky OAuth issuer mismatch');
  const metadata = await authorizationMetadata(row!.pdsUrl, transport);
  if (
    metadata.issuer.replace(/\/+$/, '') !==
    row!.authorizationUrl.replace(/\/+$/, '')
  )
    bad('Bluesky authorization server changed during OAuth');
  const key = decryptSocialSecret(config, row!.dpopPrivateKey),
    [response, nonce] = await postOAuthForm(
      config,
      metadata.token_endpoint,
      metadata.issuer,
      key,
      row!.dpopNonce,
      {
        grant_type: 'authorization_code',
        code,
        redirect_uri: callbackUrl(config),
        client_id: clientId(config),
        code_verifier: decryptSocialSecret(config, row!.codeVerifier),
      },
      transport,
    ),
    tokens = tokenResponse(
      await jsonResponse(response, 'Bluesky token exchange failed'),
      'Bluesky token exchange failed',
    );
  if (tokens.sub !== row!.expectedDid)
    bad('Bluesky authorized a different account than requested');
  await pool.query('DELETE FROM "SocialOAuthAuthorization" WHERE state=$1', [
    row!.state,
  ]);
  return {
    userId: row!.userId,
    orgId: row!.orgId,
    did: tokens.sub,
    handle: row!.handle ?? 'Bluesky account',
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    pdsUrl: row!.pdsUrl,
    authorizationUrl: row!.authorizationUrl,
    dpopPrivateKey: key,
    authorizationNonce: nonce,
    expiresIn: tokens.expiresIn,
    scope: tokens.scope,
  };
}
export async function refresh(
  config: CoreConfig,
  refreshToken: string,
  authorizationUrl: string,
  key: string,
  nonce: string | null,
  transport: BlueskyTransport = native,
): Promise<RefreshedSession> {
  const metadata = await metadataFromIssuer(authorizationUrl, transport),
    [response, nextNonce] = await postOAuthForm(
      config,
      metadata.token_endpoint,
      metadata.issuer,
      key,
      nonce,
      {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId(config),
      },
      transport,
    ),
    token = tokenResponse(
      await jsonResponse(response, 'Bluesky token refresh failed'),
      'Bluesky token refresh failed',
    );
  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    authorizationNonce: nextNonce,
    expiresIn: token.expiresIn,
  };
}
async function resourceRequest(
  endpoint: string,
  key: string,
  token: string,
  nonce: string | null,
  body: string | Buffer,
  contentType: string,
  transport: BlueskyTransport,
): Promise<[Response, string | null]> {
  const request = (value: string | null) =>
    send(transport, endpoint, {
      method: 'POST',
      headers: {
        Authorization: `DPoP ${token}`,
        DPoP: dpopProof(key, 'POST', endpoint, value, token),
        'content-type': contentType,
      },
      body,
    });
  let response = await request(nonce),
    next = response.headers.get('DPoP-Nonce') ?? nonce;
  const discovered = response.headers.get('DPoP-Nonce');
  if (!response.ok && discovered !== null && discovered !== nonce) {
    await response.body?.cancel();
    response = await request(discovered);
    next = response.headers.get('DPoP-Nonce') ?? next;
  }
  return [response, next];
}
export async function createPost(
  pdsUrl: string,
  did: string,
  text: string,
  images: BlueskyPostImage[],
  token: string,
  key: string,
  nonce: string | null,
  transport: BlueskyTransport = native,
): Promise<[string, string | null]> {
  const pds = (await validatePublicNetworkUrl(pdsUrl, 'PDS', transport))
    .toString()
    .replace(/\/+$/, '');
  signingKey(key, 'Bluesky DPoP key');
  if (images.length > 4) bad('Bluesky posts can include at most 4 images');
  let latest = nonce;
  const embeds: unknown[] = [];
  for (const image of images) {
    if (image.bytes.length > 1000000)
      bad('Bluesky images must be 1 MB or smaller');
    if (!image.mimeType.startsWith('image/'))
      bad('Bluesky attachments must be images');
    const [response, next] = await resourceRequest(
      `${pds}/xrpc/com.atproto.repo.uploadBlob`,
      key,
      token,
      latest,
      Buffer.from(image.bytes),
      image.mimeType,
      transport,
    );
    latest = next;
    const upload = object(
      await jsonResponse(response, 'Failed to upload image to Bluesky'),
      'Failed to upload image to Bluesky',
    );
    if (!Object.hasOwn(upload, 'blob'))
      bad('Bluesky did not return an image blob');
    embeds.push({ alt: image.altText, image: upload.blob });
  }
  const record = {
    $type: 'app.bsky.feed.post',
    text,
    createdAt: new Date().toISOString(),
    ...(embeds.length
      ? { embed: { $type: 'app.bsky.embed.images', images: embeds } }
      : {}),
  };
  const [response, next] = await resourceRequest(
      `${pds}/xrpc/com.atproto.repo.createRecord`,
      key,
      token,
      latest,
      JSON.stringify({ repo: did, collection: 'app.bsky.feed.post', record }),
      'application/json',
      transport,
    ),
    value = object(
      await jsonResponse(response, 'Failed to publish to Bluesky'),
      'Failed to publish to Bluesky',
    );
  if (typeof value.uri !== 'string') bad('Bluesky did not return a post URI');
  return [value.uri as string, next];
}
export async function deletePost(
  pdsUrl: string,
  did: string,
  uri: string,
  token: string,
  key: string,
  nonce: string | null,
  transport: BlueskyTransport = native,
): Promise<string | null> {
  const prefix = `at://${did}/app.bsky.feed.post/`,
    rkey = uri.startsWith(prefix) ? uri.slice(prefix.length) : '';
  if (!rkey || rkey.includes('/')) bad('Bluesky post URI is invalid');
  const pds = (await validatePublicNetworkUrl(pdsUrl, 'PDS', transport))
    .toString()
    .replace(/\/+$/, '');
  signingKey(key, 'Bluesky DPoP key');
  const [response, next] = await resourceRequest(
    `${pds}/xrpc/com.atproto.repo.deleteRecord`,
    key,
    token,
    nonce,
    JSON.stringify({ repo: did, collection: 'app.bsky.feed.post', rkey }),
    'application/json',
    transport,
  );
  if (!response.ok && response.status !== 404) {
    let text = '';
    try {
      text = await response.text();
    } catch {}
    const detail =
      Array.from(text).slice(0, 300).join('').trim() ||
      `${response.status} ${response.statusText}`;
    bad(`Failed to delete Bluesky post: ${detail}`);
  } else await response.body?.cancel();
  return next;
}
