import type { Pool } from 'pg';
import { createId } from '@paralleldrive/cuid2';
import type { CoreConfig } from '../config.js';
import { ApiError } from '../error.js';
import { encryptSocialSecret } from './crypto.js';
import { mergeChannelMetadataWithCapabilities } from '../services/social/channels.js';
import * as sql from './social-provider-sql.js';
export type { SocialChannel } from '../services/social/types.js';
import type { SocialChannel } from '../services/social/types.js';
export interface Tokens {
  access_token?: string | null;
  refresh_token?: string | null;
  expires_in?: number | null;
  scope?: string | null;
  token_type?: string | null;
  permissions?: string[] | null;
  open_id?: string | null;
  refresh_expires_in?: number | null;
}
export interface Profile {
  id?: string | null;
  user_id?: unknown;
  username?: string | null;
  name?: string | null;
  profile_picture_url?: string | null;
  account_type?: string | null;
  followers_count?: number | null;
  follows_count?: number | null;
  media_count?: number | null;
  threads_profile_picture_url?: string | null;
  profile_image_url?: string | null;
  sub?: string | null;
  picture?: string | null;
  email?: string | null;
  open_id?: string | null;
  display_name?: string | null;
  avatar_url?: string | null;
}
export interface LinkedInPage {
  id: string;
  name: string;
  urn: string;
  role: string | null;
  vanity_name?: string | null;
}
export interface MetaPageAccount {
  id: string;
  name?: string | null;
  username?: string | null;
  access_token?: string | null;
  tasks?: string[] | null;
  picture?: {
    data?: {
      url?: string | null;
    } | null;
  } | null;
  connected_instagram_account?: Profile | null;
  instagram_business_account?: Profile | null;
}
export interface CompletedBlueskyAuthorization {
  userId: string;
  orgId: string;
  handle: string;
  did: string;
  accessToken: string;
  refreshToken: string;
  pdsUrl: string;
  authorizationUrl: string;
  dpopPrivateKey: string;
  authorizationNonce: string | null;
  scope: string | null;
  expiresIn: number | null;
}
const platforms = new Set([
  'FACEBOOK',
  'INSTAGRAM',
  'THREADS',
  'TIKTOK',
  'BLUESKY',
  'LINKEDIN',
  'X',
]);
function platformQuery(query: string, platform: string): string {
  if (!platforms.has(platform))
    throw new ApiError(400, 'bad_request', 'Invalid platform');
  return query.replaceAll('{platform}', platform);
}

const missing = (message: string): never => {
  throw new ApiError(400, 'bad_request', message);
};
const expiry = (seconds: number | null | undefined) =>
  seconds == null ? null : new Date(Date.now() + seconds * 1000).toISOString();
const handle = (name: string | null | undefined) =>
  name == null ? null : `@${name}`;
export function valueAsIdentifier(value: unknown): string | null {
  return typeof value === 'string' && value.trim()
    ? value
    : typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : null;
}
export async function getSocialChannelByExternalAccount(
  pool: Pool,
  orgId: string,
  platform: string,
  externalId: string,
): Promise<SocialChannel | null> {
  const row = (
    await pool.query(
      platformQuery(sql.GET_SOCIAL_CHANNEL_BY_EXTERNAL_ACCOUNT_0, platform),
      [orgId, externalId],
    )
  ).rows[0];
  return row ? (row as SocialChannel) : null;
}
async function saved(
  pool: Pool,
  orgId: string,
  platform: string,
  id: string,
  message = `Failed to load saved ${platform} connection`,
): Promise<SocialChannel> {
  const row = await getSocialChannelByExternalAccount(
    pool,
    orgId,
    platform,
    id,
  );
  if (!row) throw new ApiError(500, 'internal_error', message);
  return row;
}
export async function upsertProviderConnection(
  pool: Pool,
  config: CoreConfig,
  userId: string,
  orgId: string,
  platform: string,
  displayName: string,
  accountHandle: string | null,
  externalId: string,
  access: string,
  refresh: string | null,
  metadata: Record<string, unknown>,
): Promise<SocialChannel> {
  await pool.query(platformQuery(sql.UPSERT_PROVIDER_CONNECTION_0, platform), [
    createId(),
    userId,
    orgId,
    displayName,
    accountHandle,
    externalId,
    encryptSocialSecret(config, access),
    refresh === null ? null : encryptSocialSecret(config, refresh),
    JSON.stringify(mergeChannelMetadataWithCapabilities(platform, metadata)),
  ]);
  return saved(pool, orgId, platform, externalId);
}
export function threadsScopeValue(
  returned?: string | null,
  requested?: string | null,
): string | null {
  const normalize = (v?: string | null) =>
    v
      ?.split(/[, ]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .join(' ') || null;
  return normalize(returned) ?? normalize(requested);
}
export function xScopeWouldDowngrade(
  metadata: Record<string, unknown> | null,
  returned: string | null | undefined,
): boolean {
  const value = metadata?.scope,
    existing = Array.isArray(value)
      ? value.filter((v): v is string => typeof v === 'string')
      : typeof value === 'string'
        ? value
            .split(/[, ]/)
            .map((v) => v.trim())
            .filter(Boolean)
        : [];
  if (!existing.length) return false;
  if (returned == null) return true;
  const next = returned
    .split(/[, ]/)
    .map((v) => v.trim())
    .filter(Boolean);
  return existing.some((v) => !next.includes(v));
}
export async function upsertThreadsConnectionForOrg(
  pool: Pool,
  config: CoreConfig,
  userId: string,
  orgId: string,
  tokens: Tokens,
  profile: Profile & {
    id: string;
  },
  requestedScope?: string | null,
): Promise<SocialChannel> {
  return upsertProviderConnection(
    pool,
    config,
    userId,
    orgId,
    'THREADS',
    profile.name ?? profile.username ?? 'Threads account',
    handle(profile.username),
    profile.id,
    tokens.access_token ?? missing('Missing Threads access token'),
    null,
    {
      provider: 'threads',
      scope: threadsScopeValue(tokens.scope, requestedScope),
      expiresAt: expiry(tokens.expires_in),
      avatarUrl: profile.threads_profile_picture_url ?? null,
    },
  );
}
export async function upsertXConnectionForOrg(
  pool: Pool,
  config: CoreConfig,
  userId: string,
  orgId: string,
  tokens: Tokens,
  profile: Profile & {
    id: string;
  },
): Promise<SocialChannel> {
  const access = encryptSocialSecret(
      config,
      tokens.access_token ?? missing('Missing X access token'),
    ),
    refresh =
      tokens.refresh_token == null
        ? null
        : encryptSocialSecret(config, tokens.refresh_token),
    expiresAt = expiry(tokens.expires_in),
    existing = await getSocialChannelByExternalAccount(
      pool,
      orgId,
      'X',
      profile.id,
    );
  if (
    existing &&
    xScopeWouldDowngrade(
      existing.metadata as Record<string, unknown> | null,
      tokens.scope,
    )
  )
    missing(
      'X authorization returned less access than the existing connection; no changes were applied',
    );
  await pool.query(sql.UPSERT_X_CONNECTION_FOR_ORG_0, [
    createId(),
    userId,
    orgId,
    profile.name ?? profile.username ?? 'X account',
    handle(profile.username),
    profile.id,
    access,
    refresh,
    JSON.stringify(
      mergeChannelMetadataWithCapabilities('X', {
        provider: 'x',
        tokenType: tokens.token_type ?? 'bearer',
        scope: tokens.scope ?? null,
        expiresAt,
        avatarUrl: profile.profile_image_url ?? null,
      }),
    ),
  ]);
  return saved(
    pool,
    orgId,
    'X',
    profile.id,
    'Failed to load saved X connection',
  );
}
export async function upsertLinkedinConnectionForOrg(
  pool: Pool,
  config: CoreConfig,
  userId: string,
  orgId: string,
  tokens: Tokens,
  profile: Profile,
): Promise<SocialChannel> {
  const id = profile.sub ?? missing('Missing LinkedIn member identifier');
  await pool.query(sql.UPSERT_LINKEDIN_CONNECTION_FOR_ORG_0, [
    createId(),
    userId,
    orgId,
    profile.name ?? 'LinkedIn profile',
    id,
    encryptSocialSecret(
      config,
      tokens.access_token ?? missing('Missing LinkedIn access token'),
    ),
    tokens.refresh_token == null
      ? null
      : encryptSocialSecret(config, tokens.refresh_token),
    JSON.stringify(
      mergeChannelMetadataWithCapabilities('LINKEDIN', {
        provider: 'linkedin',
        accountType: 'member',
        actorType: 'person',
        scope: tokens.scope ?? null,
        expiresAt: expiry(tokens.expires_in),
        picture: profile.picture ?? null,
        email: profile.email ?? null,
        actorUrn: `urn:li:person:${id}`,
      }),
    ),
  ]);
  return saved(
    pool,
    orgId,
    'LINKEDIN',
    id,
    'Failed to load saved LinkedIn connection',
  );
}
export async function upsertLinkedinPageConnectionsForOrg(
  pool: Pool,
  config: CoreConfig,
  userId: string,
  orgId: string,
  tokens: Tokens,
  pages: LinkedInPage[],
): Promise<SocialChannel[]> {
  const access =
      tokens.access_token ?? missing('Missing LinkedIn access token'),
    expiresAt = expiry(tokens.expires_in),
    saved: SocialChannel[] = [];
  for (const page of pages)
    saved.push(
      await upsertProviderConnection(
        pool,
        config,
        userId,
        orgId,
        'LINKEDIN',
        page.name,
        page.vanity_name == null
          ? null
          : `linkedin.com/company/${page.vanity_name}`,
        page.id,
        access,
        tokens.refresh_token ?? null,
        {
          provider: 'linkedin',
          accountType: 'organization',
          actorType: 'organization',
          organizationId: page.id,
          actorUrn: page.urn,
          role: page.role,
          vanityName: page.vanity_name ?? null,
          scope: tokens.scope ?? null,
          expiresAt,
        },
      ),
    );
  return saved;
}
export async function upsertTiktokConnectionForOrg(
  pool: Pool,
  config: CoreConfig,
  userId: string,
  orgId: string,
  tokens: Tokens,
  profile: Profile,
): Promise<SocialChannel> {
  const access = tokens.access_token ?? missing('Missing TikTok access token'),
    id =
      profile.open_id ??
      tokens.open_id ??
      missing('TikTok did not return an account identifier');
  return upsertProviderConnection(
    pool,
    config,
    userId,
    orgId,
    'TIKTOK',
    profile.display_name ?? profile.username ?? 'TikTok account',
    handle(profile.username),
    id,
    access,
    tokens.refresh_token ?? null,
    {
      provider: 'tiktok',
      scope: tokens.scope ?? null,
      expiresAt: expiry(tokens.expires_in),
      refreshExpiresAt: expiry(tokens.refresh_expires_in),
      avatarUrl: profile.avatar_url ?? null,
    },
  );
}
export async function upsertBlueskyOAuthConnectionForOrg(
  pool: Pool,
  config: CoreConfig,
  value: CompletedBlueskyAuthorization,
): Promise<SocialChannel> {
  return upsertProviderConnection(
    pool,
    config,
    value.userId,
    value.orgId,
    'BLUESKY',
    value.handle,
    handle(value.handle),
    value.did,
    value.accessToken,
    value.refreshToken,
    {
      provider: 'bluesky',
      authMethod: 'bluesky_oauth',
      pds: value.pdsUrl,
      authorizationServer: value.authorizationUrl,
      dpopPrivateKey: encryptSocialSecret(config, value.dpopPrivateKey),
      dpopAuthorizationNonce: value.authorizationNonce,
      scope: value.scope,
      expiresAt: expiry(value.expiresIn),
    },
  );
}
export async function upsertInstagramConnectionForOrg(
  pool: Pool,
  config: CoreConfig,
  userId: string,
  orgId: string,
  tokens: Tokens,
  grantedPermissions: string[] | null,
  profile: Profile,
): Promise<SocialChannel> {
  const id =
      valueAsIdentifier(profile.user_id) ??
      profile.id ??
      missing('Instagram account lookup did not return an account identifier'),
    access = encryptSocialSecret(
      config,
      tokens.access_token ?? missing('Missing Instagram access token'),
    ),
    metadata = mergeChannelMetadataWithCapabilities('INSTAGRAM', {
      provider: 'instagram',
      authMethod: 'instagram_login',
      assetType: 'instagram_professional_account',
      apiHost: 'graph.instagram.com',
      instagramAccountId: id,
      instagramUserId: valueAsIdentifier(profile.user_id),
      instagramAppScopedId: profile.id ?? null,
      username: profile.username ?? null,
      profilePictureUrl: profile.profile_picture_url ?? null,
      accountType: profile.account_type ?? null,
      followersCount: profile.followers_count ?? null,
      followsCount: profile.follows_count ?? null,
      mediaCount: profile.media_count ?? null,
      permissions: grantedPermissions ?? tokens.permissions ?? [],
      permissionsInspected: true,
      tokenType: tokens.token_type ?? 'bearer',
      tokenExpiresAt: expiry(tokens.expires_in),
    });
  const tx = await pool.connect();
  try {
    await tx.query('BEGIN');
    if (profile.id != null && profile.id !== id) {
      const exists = (
        await tx.query<{
          exists: boolean;
        }>(sql.UPSERT_INSTAGRAM_CONNECTION_FOR_ORG_0, [orgId, id])
      ).rows[0]!.exists;
      if (!exists)
        await tx.query(sql.UPSERT_INSTAGRAM_CONNECTION_FOR_ORG_1, [
          id,
          orgId,
          profile.id,
        ]);
    }
    await tx.query(sql.UPSERT_INSTAGRAM_CONNECTION_FOR_ORG_2, [
      createId(),
      userId,
      orgId,
      profile.name ?? profile.username ?? 'Instagram account',
      handle(profile.username),
      id,
      access,
      JSON.stringify(metadata),
    ]);
    await tx.query('COMMIT');
  } catch (error) {
    await tx.query('ROLLBACK');
    throw error;
  } finally {
    tx.release();
  }
  return saved(
    pool,
    orgId,
    'INSTAGRAM',
    id,
    'Failed to save Instagram connection',
  );
}
export async function upsertMetaConnectionsForOrg(
  pool: Pool,
  config: CoreConfig,
  userId: string,
  orgId: string,
  tokens: Tokens,
  pages: MetaPageAccount[],
  permissions: string[] | null,
  includeFacebook: boolean,
  includeInstagram: boolean,
  fetchInstagram: (token: string, pageId: string) => Promise<Profile | null>,
): Promise<SocialChannel[]> {
  const userAccess = encryptSocialSecret(
      config,
      tokens.access_token ?? missing('Missing Meta access token'),
    ),
    userTokenExpiresAt = expiry(tokens.expires_in),
    result: SocialChannel[] = [];
  for (const page of pages) {
    if (!page.access_token?.trim()) continue;
    const pageAccess = encryptSocialSecret(config, page.access_token);
    if (includeFacebook) {
      await pool.query(sql.UPSERT_META_CONNECTIONS_FOR_ORG_0, [
        createId(),
        userId,
        orgId,
        page.name ?? 'Facebook Page',
        handle(page.username),
        page.id,
        pageAccess,
        userAccess,
        JSON.stringify(
          mergeChannelMetadataWithCapabilities('FACEBOOK', {
            provider: 'meta',
            authMethod: 'meta_login',
            assetType: 'facebook_page',
            pageId: page.id,
            username: page.username ?? null,
            pictureUrl: page.picture?.data?.url ?? null,
            tasks: page.tasks ?? [],
            userTokenExpiresAt,
            tokenType: tokens.token_type ?? 'bearer',
            permissions: permissions ?? [],
            permissionsInspected: permissions !== null,
          }),
        ),
      ]);
      const savedChannel = await getSocialChannelByExternalAccount(
        pool,
        orgId,
        'FACEBOOK',
        page.id,
      );
      if (savedChannel) result.push(savedChannel);
    }
    if (!includeInstagram) continue;
    const instagram =
      page.connected_instagram_account ??
      page.instagram_business_account ??
      (await fetchInstagram(page.access_token, page.id));
    if (instagram) {
      const id = instagram.id!;
      await pool.query(sql.UPSERT_META_CONNECTIONS_FOR_ORG_1, [
        createId(),
        userId,
        orgId,
        instagram.name ?? instagram.username ?? 'Instagram account',
        handle(instagram.username),
        id,
        pageAccess,
        userAccess,
        JSON.stringify(
          mergeChannelMetadataWithCapabilities('INSTAGRAM', {
            provider: 'meta',
            authMethod: 'meta_login',
            assetType: 'instagram_professional_account',
            instagramAccountId: id,
            pageId: page.id,
            pageName: page.name ?? null,
            profilePictureUrl: instagram.profile_picture_url ?? null,
            userTokenExpiresAt,
            tokenType: tokens.token_type ?? 'bearer',
            permissions: permissions ?? [],
            permissionsInspected: permissions !== null,
          }),
        ),
      ]);
      const savedChannel = await getSocialChannelByExternalAccount(
        pool,
        orgId,
        'INSTAGRAM',
        id,
      );
      if (savedChannel) result.push(savedChannel);
    }
  }
  return result;
}
