import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { readConfig } from '../src/config.js';
import { installPgTimestampParsers } from '../src/db.js';
import { ApiError } from '../src/error.js';
import * as connections from '../src/services/connections.js';
import * as permissions from '../src/integrations/connection-permissions.js';
import * as email from '../src/integrations/email.js';
import * as oauth from '../src/integrations/social-oauth.js';
import * as social from '../src/integrations/social-provider-connections.js';
import { encryptSocialSecret, decryptSocialSecret } from '../src/integrations/crypto.js';
function state(provider: string, metadata: Record<string, unknown>, key: string) { return permissions.permissionSnapshots(provider, metadata).find(v => v.definition.key === key)!.definition; }
test('provider permission evidence, replacement scopes and raw token encryption preserve boundaries', () => {
    assert.equal(state('WHATSAPP', { permissions: ['whatsapp_business_messaging'] }, 'MESSAGING_OUTBOUND').state, 'UNKNOWN');
    assert.equal(state('WHATSAPP', { permissions: ['whatsapp_business_messaging'], capabilityChecks: { MESSAGING_OUTBOUND: true } }, 'MESSAGING_OUTBOUND').state, 'GRANTED');
    assert.equal(state('INSTAGRAM', { authMethod: 'instagram_login', permissions: ['instagram_business_content_publish'] }, 'SOCIAL_POST_DELETE').state, 'UNSUPPORTED');
    assert.equal(state('LINKEDIN', { accountType: 'organization', scope: 'w_organization_social', role: 'CONTENT_ADMIN' }, 'SOCIAL_PUBLISH').state, 'GRANTED');
    assert.equal(state('GOOGLE', { scopes: ['https://www.googleapis.com/auth/gmail.readonly'] }, 'EMAIL_READ').state, 'UNKNOWN'); // Rust inventory deliberately reads scope, not scopes.
    assert.deepEqual(permissions.effectiveRequestedCapabilities(['MEDIA_PUBLISH'], permissions.permissionSnapshots('X', { scope: 'tweet.write' })), ['MEDIA_PUBLISH', 'SOCIAL_PUBLISH', 'COMMENTS_MANAGE', 'SOCIAL_POST_DELETE']);
    const config = readConfig({ DATABASE_URL: 'postgres://unused', SOCIAL_TOKEN_ENCRYPTION_KEY: ' raw key ', AUTH_X_CLIENT_ID: ' raw client ' });
    assert.equal(decryptSocialSecret(config, encryptSocialSecret(config, ' provider token ')), ' provider token ');
    const different = readConfig({ DATABASE_URL: 'postgres://unused', SOCIAL_TOKEN_ENCRYPTION_KEY: 'raw key' });
    assert.throws(() => decryptSocialSecret(different, encryptSocialSecret(config, 'token')));
    const x = oauth.createXOAuthState();
    assert.notEqual(x.state, x.verifier);
    const url = new URL(oauth.buildXAuthorizeUrl(config, x.state, x.challenge, ['MEDIA_PUBLISH']));
    assert.equal(url.searchParams.get('client_id'), ' raw client ');
    assert.equal(url.searchParams.get('scope'), 'media.write tweet.read users.read offline.access');
    assert.equal(social.xScopeWouldDowngrade({ scope: 'tweet.write media.write' }, 'tweet.write'), true);
    assert.equal(social.threadsScopeValue(null, 'threads_basic,threads_delete'), 'threads_basic threads_delete');
});
test('email provider fixtures retain token/profile errors and redirect/state conventions', async () => {
    const config = readConfig({ DATABASE_URL: 'postgres://unused', KASITEK_EMAIL_GOOGLE_CLIENT_ID: ' client ', KASITEK_EMAIL_GOOGLE_CLIENT_SECRET: ' secret ', KASITEK_EMAIL_GOOGLE_REDIRECT_URI: 'http://localhost/callback' }), provider = email.providerConfig(config, 'gmail');
    assert.equal(provider.clientId, 'client');
    assert.equal(new URL(email.authorizationUrl(provider, 'state')).searchParams.get('prompt'), 'consent');
    assert.equal(email.safeReturnPath('//evil.example'), '/inbox');
    const fetch: email.HttpFetch = async () => new Response(JSON.stringify({ sub: 'g', email: 'real@example.test', name: 'Name' }));
    assert.deepEqual(await email.loadProfile(provider, 'fake', fetch), { externalAccountId: 'g', emailAddress: 'real@example.test', displayName: 'Name' });
    const microsoft = { ...provider, provider: 'MICROSOFT' };
    const camelFields: email.HttpFetch = async () => new Response(JSON.stringify({ id: 'm', userPrincipalName: 'u@example.test', displayName: 'Graph Name' }));
    await assert.rejects(email.loadProfile(microsoft, 'fake', camelFields), /Microsoft did not return an email address/); // Source Graph serde struct is snake_case; no migration redesign.
});
test('isolated database connection projections, revocation/reconnect, one-time email states and credential refresh', { skip: !process.env.CORE_CONNECTIONS_TEST_DATABASE_URL }, async () => {
    installPgTimestampParsers();
    const url = process.env.CORE_CONNECTIONS_TEST_DATABASE_URL!, schema = `connections_test_${randomUUID().replaceAll('-', '')}`, admin = new pg.Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema} -c timezone=UTC` });
    try {
        const migrations = resolve(process.cwd(), '../../client/packages/database/prisma/migrations');
        for (const folder of ['20260717120000_add_shared_connections', '20260831150000_add_connection_permission_center', '20260910100000_add_workspace_email_connections', '20260910120000_add_email_inbox_bindings']) {
            const source = readFileSync(resolve(migrations, folder, 'migration.sql'), 'utf8');
            const definitions = source.match(/CREATE (?:TYPE|TABLE|UNIQUE INDEX|INDEX)[\s\S]*?;/g) ?? [];
            for (const query of definitions)
                await pool.query(query);
        }
        await pool.query(readFileSync(resolve(migrations, '20260829180000_add_core_analytics_outbox/migration.sql'), 'utf8'));
        await pool.query(`CREATE TYPE "SocialPlatform" AS ENUM('FACEBOOK','INSTAGRAM','THREADS','TIKTOK','BLUESKY','LINKEDIN','X');CREATE TYPE "SocialChannelStatus" AS ENUM('CONNECTED','DISCONNECTED','NEEDS_REAUTH');CREATE TABLE "SocialChannelConnection"(id text PRIMARY KEY,"userId" text,"orgId" text,platform "SocialPlatform",status "SocialChannelStatus","displayName" text,handle text,"externalAccountId" text,"accessToken" text,"refreshToken" text,metadata jsonb,"lastSyncedAt" timestamp,"createdAt" timestamp DEFAULT NOW(),"updatedAt" timestamp DEFAULT NOW(),UNIQUE("orgId",platform,"externalAccountId"));CREATE TABLE "WhatsappConnection"(id text,"orgId" text,"phoneNumberId" text,"phoneDisplayNumber" text,verified boolean,"updatedAt" timestamp,"createdAt" timestamp,"wabaId" text,"currentQualityRating" text,"dailyLimitEstimate" int,"authMethod" text,"providerPermissions" jsonb);`);
        const config = readConfig({ DATABASE_URL: url, SOCIAL_TOKEN_ENCRYPTION_KEY: 'fixture-secret', KASITEK_EMAIL_GOOGLE_CLIENT_ID: 'fixture-client', KASITEK_EMAIL_GOOGLE_CLIENT_SECRET: 'fixture-secret', KASITEK_EMAIL_GOOGLE_REDIRECT_URI: 'http://localhost/callback' });
        const first = await email.upsertConnectionFromTokens(pool, config, 'org-a', 'user-a', 'google', 'external', 'fixture@example.test', 'Fixture', 'original-access', 'original-refresh', new Date(0), ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'], 'fixture');
        assert.equal(first.inboundStatus, 'PENDING');
        assert.equal(first.outboundStatus, 'READY');
        assert.equal(JSON.stringify(email.publicEmailConnection(first)).includes('externalAccountId'), false);
        const list = await connections.listConnections(pool, 'org-a');
        assert.equal(list.length, 1);
        assert.equal(list[0]!.id, `ext_${first.id}`);
        assert.equal(list[0]!.metadata?.scopes, undefined);
        assert.ok(list[0]!.capabilities.some((v: any) => v.key === 'EMAIL_REPLY'));
        assert.deepEqual(await connections.listConnections(pool, 'org-other'), []);
        await assert.rejects(connections.updateStatus(pool, 'org-other', `ext_${first.id}`, 'REVOKED'), (e: any) => e instanceof ApiError && e.status === 404);
        await connections.updateStatus(pool, 'org-a', `ext_${first.id}`, 'REVOKED');
        await assert.rejects(email.resolveEmailCredentialById(pool, 'org-a', first.id), /Connected email account not found/);
        const paused = await email.getConnectionById(pool, 'org-a', first.id);
        assert.equal(paused!.inboxStatus, 'PAUSED');
        assert.equal(paused!.outboundStatus, 'BLOCKED');
        await connections.updateStatus(pool, 'org-a', `ext_${first.id}`, 'CONNECTED');
        assert.equal((await email.getConnectionById(pool, 'org-a', first.id))!.outboundStatus, 'READY');
        const credential = await email.resolveEmailCredentialById(pool, 'org-a', first.id);
        let requests = 0;
        const refresh: email.HttpFetch = async (_url, init) => { requests++; assert.equal((init!.body as URLSearchParams).get('refresh_token'), 'original-refresh'); return new Response(JSON.stringify({ access_token: 'fresh-access', expires_in: 3600 })); };
        assert.equal(await email.accessToken(pool, config, credential, refresh), 'fresh-access');
        assert.equal(requests, 1);
        const refreshed = await email.resolveEmailCredentialById(pool, 'org-a', first.id);
        assert.equal(decryptSocialSecret(config, refreshed.refresh_token!), 'original-refresh');
        assert.equal(await email.accessToken(pool, config, refreshed, refresh), 'fresh-access');
        assert.equal(requests, 1);
        const provider = email.providerConfig(config, 'google'), oauthState = await email.createOAuthState(pool, 'org-a', 'user-a', provider, '/inbox');
        const consumed = await Promise.all([email.consumeOAuthState(pool, oauthState), email.consumeOAuthState(pool, oauthState)]);
        assert.equal(consumed.filter(Boolean).length, 1);
        const channel = await social.upsertXConnectionForOrg(pool, config, 'user-a', 'org-a', { access_token: 'x-token', scope: 'tweet.write media.write' }, { id: 'x-user', name: 'X Fixture' });
        await assert.rejects(social.upsertXConnectionForOrg(pool, config, 'user-a', 'org-a', { access_token: 'replacement', scope: 'tweet.write' }, { id: 'x-user' }), /less access/);
        assert.equal(decryptSocialSecret(config, (await pool.query('SELECT "accessToken" FROM "SocialChannelConnection" WHERE id=$1', [channel.id])).rows[0].accessToken), 'x-token');
        await connections.syncOrgConnections(pool, 'org-a');
        await connections.recordSyncedSourceHealth(pool, 'org-a', 'SOCIAL', channel.id, false, null, 'safe fixture failure');
        const facts = await pool.query('SELECT contract_name,envelope FROM analytics_outbox WHERE source_domain=\'connections\'');
        assert.ok(facts.rows.some(v => v.contract_name === 'connection.incident.lifecycle@1'));
        assert.ok(facts.rows.some(v => v.contract_name === 'source.manifest@1'));
        assert.equal(JSON.stringify(facts.rows).includes('fixture@example.test'), false);
        assert.equal(JSON.stringify(facts.rows).includes('x-token'), false);
    }
    finally {
        await pool.end();
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
    }
});
