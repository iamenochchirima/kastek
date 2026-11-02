import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createECDH,
  createHmac,
  createPublicKey,
  verify,
  randomUUID,
} from 'node:crypto';
import pg from 'pg';
import { readConfig } from '../src/config.js';
import { installPgTimestampParsers } from '../src/db.js';
import { ApiError } from '../src/error.js';
import * as provider from '../src/integrations/provider-auth.js';
import * as bluesky from '../src/integrations/bluesky-oauth.js';
import {
  encryptSocialSecret,
  decryptSocialSecret,
} from '../src/integrations/crypto.js';
import type { HttpFetch } from '../src/integrations/email.js';
function key() {
  const dh = createECDH('prime256v1');
  dh.generateKeys();
  return dh.getPrivateKey().toString('base64url');
}
function checkProof(proof: string) {
  const [encodedHeader, encodedClaims, signature] = proof.split('.');
  const header = JSON.parse(
      Buffer.from(encodedHeader!, 'base64url').toString(),
    ),
    claims = JSON.parse(Buffer.from(encodedClaims!, 'base64url').toString());
  assert.equal(
    verify(
      'sha256',
      Buffer.from(`${encodedHeader}.${encodedClaims}`),
      {
        key: createPublicKey({ key: header.jwk, format: 'jwk' }),
        dsaEncoding: 'ieee-p1363',
      },
      Buffer.from(signature!, 'base64url'),
    ),
    true,
  );
  return { header, claims };
}
test('social exchanges, scope introspection and rotation preserve existing provider request contracts', async () => {
  const config = readConfig({
    DATABASE_URL: 'postgres://unused',
    SOCIAL_TOKEN_ENCRYPTION_KEY: 'fixture',
    AUTH_X_CLIENT_ID: ' raw-client ',
    AUTH_X_CLIENT_SECRET: ' raw-secret ',
    AUTH_THREADS_APP_ID: 'threads',
    AUTH_THREADS_APP_SECRET: 'secret',
    AUTH_TIKTOK_CLIENT_KEY: 'tik',
    AUTH_TIKTOK_CLIENT_SECRET: 'secret',
    AUTH_META_APP_ID: 'meta',
    AUTH_META_APP_SECRET: 'secret',
  });
  const calls: { url: string; init: RequestInit }[] = [];
  const http: HttpFetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return new Response(
      JSON.stringify({ access_token: 'access', expires_in: 3600 }),
    );
  };
  await provider.exchangeXCodeForTokens(config, 'code', 'verifier', http);
  assert.equal(
    (calls[0]!.init.body as URLSearchParams).get('code_verifier'),
    'verifier',
  );
  assert.equal(
    new Headers(calls[0]!.init.headers).get('authorization'),
    `Basic ${Buffer.from(' raw-client : raw-secret ').toString('base64')}`,
  );
  await provider.exchangeThreadsCodeForToken(config, 'code', http);
  assert.equal(calls.length, 3);
  assert.equal(
    new URL(calls[2]!.url).searchParams.get('grant_type'),
    'th_exchange_token',
  );
  await provider.refreshTiktokToken(
    config,
    encryptSocialSecret(config, 'refresh'),
    http,
  );
  assert.equal(
    (calls[3]!.init.body as URLSearchParams).get('refresh_token'),
    'refresh',
  );
  const scopes: HttpFetch = async (url) => {
    assert.match(String(url), /debug_token/);
    return new Response(
      JSON.stringify({
        data: {
          is_valid: true,
          scopes: ['base'],
          granular_scopes: [{ scope: 'base' }, { scope: 'extra' }],
        },
      }),
    );
  };
  assert.deepEqual(
    await provider.fetchMetaPermissions(config, 'token', scopes),
    ['base', 'extra'],
  );
  const failed: HttpFetch = async () =>
    new Response(JSON.stringify({ message: 'discard raw body' }), {
      status: 429,
    });
  await assert.rejects(
    provider.fetchXMe('token', failed),
    (e: any) => e instanceof ApiError && e.code === 'rate_limited',
  );
  const payload = Buffer.from(
      JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: 'threads-user' }),
    ).toString('base64url'),
    signature = createHmac('sha256', 'secret')
      .update(payload)
      .digest('base64url');
  assert.equal(
    provider.verifyThreadsSignedRequest(config, `${signature}.${payload}`),
    'threads-user',
  );
  const numericPayload = Buffer.from(
    '{"algorithm":"HMAC-SHA256","user_id":9223372036854775807}',
  ).toString('base64url');
  const numericSignature = createHmac('sha256', 'secret')
    .update(numericPayload)
    .digest('base64url');
  assert.equal(
    provider.verifyThreadsSignedRequest(
      config,
      `${numericSignature}.${numericPayload}`,
    ),
    '9223372036854775807',
  );
  assert.throws(
    () =>
      provider.verifyThreadsSignedRequest(
        config,
        `${signature.slice(1)}.${payload}`,
      ),
    (e: any) => e instanceof ApiError && [400, 401].includes(e.status),
  );
});
test('Bluesky DPoP signatures, private endpoint rejection and bounded nonce retries are preserved', async () => {
  const privateKey = key(),
    proof = checkProof(
      bluesky.dpopProof(
        privateKey,
        'POST',
        'https://pds.example.test/xrpc/create',
        'nonce',
        'access',
      ),
    );
  assert.equal(proof.claims.htm, 'POST');
  assert.equal(proof.claims.nonce, 'nonce');
  assert.equal(proof.header.typ, 'dpop+jwt');
  assert.equal(proof.claims.ath.length, 43);
  for (const url of [
    'http://public.example.test',
    'https://localhost',
    'https://127.0.0.1',
    'https://[::1]',
    'https://10.1.2.3',
  ])
    assert.throws(() => bluesky.validatePublicHttps(url, 'PDS'));
  await assert.rejects(
    bluesky.validatePublicNetworkUrl('https://dns.example.test', 'PDS', {
      fetch,
      lookup: async () => [{ address: '192.168.1.1', family: 4 }],
    }),
    /non-public/,
  );
  let calls = 0;
  const transport: bluesky.BlueskyTransport = {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    fetch: async (url, init = {}) => {
      calls++;
      assert.equal(init.redirect, 'manual');
      const checked = checkProof(new Headers(init.headers).get('dpop')!);
      assert.equal(checked.claims.htu, String(url));
      assert.equal(
        new Headers(init.headers).get('authorization'),
        'DPoP access',
      );
      if (calls === 1) {
        assert.equal(checked.claims.nonce, undefined);
        return new Response('{}', {
          status: 401,
          headers: { 'DPoP-Nonce': 'next' },
        });
      }
      assert.equal(checked.claims.nonce, 'next');
      return new Response(
        JSON.stringify({ uri: 'at://did:plc:fixture/app.bsky.feed.post/p1' }),
        { headers: { 'DPoP-Nonce': 'latest' } },
      );
    },
  };
  assert.deepEqual(
    await bluesky.createPost(
      'https://pds.example.test',
      'did:plc:fixture',
      'Synthetic',
      [],
      'access',
      privateKey,
      null,
      transport,
    ),
    ['at://did:plc:fixture/app.bsky.feed.post/p1', 'latest'],
  );
  assert.equal(calls, 2);
  await assert.rejects(
    bluesky.deletePost(
      'https://pds.example.test',
      'did:plc:fixture',
      'at://did:plc:other/app.bsky.feed.post/p1',
      'access',
      privateKey,
      null,
      transport,
    ),
    /URI is invalid/,
  );
  assert.equal(calls, 2);
  const missing: bluesky.BlueskyTransport = {
    lookup: transport.lookup,
    fetch: async () =>
      new Response('', { status: 404, headers: { 'DPoP-Nonce': 'same' } }),
  };
  assert.equal(
    await bluesky.deletePost(
      'https://pds.example.test',
      'did:plc:fixture',
      'at://did:plc:fixture/app.bsky.feed.post/p1',
      'access',
      privateKey,
      'same',
      missing,
    ),
    'same',
  );
});
test(
  'isolated Bluesky PAR state encryption, issuer/account checks, completion and token refresh',
  { skip: !process.env.CORE_CONNECTIONS_TEST_DATABASE_URL },
  async () => {
    installPgTimestampParsers();
    const url = process.env.CORE_CONNECTIONS_TEST_DATABASE_URL!,
      schema = `provider_auth_test_${randomUUID().replaceAll('-', '')}`,
      admin = new pg.Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({
      connectionString: url,
      options: `-c search_path=${schema} -c timezone=UTC`,
    });
    try {
      await pool.query(
        `CREATE TABLE "SocialOAuthAuthorization"(id text,provider text,state text UNIQUE,"userId" text,"orgId" text,handle text,"expectedDid" text,"pdsUrl" text,"authorizationUrl" text,"codeVerifier" text,"dpopPrivateKey" text,"dpopNonce" text,"createdAt" timestamp,"expiresAt" timestamp);`,
      );
      const config = readConfig({
          DATABASE_URL: url,
          KASITEK_CORE_PUBLIC_URL: 'https://core.example.test',
          SOCIAL_TOKEN_ENCRYPTION_KEY: 'fixture-secret',
          AUTH_BLUESKY_OAUTH_CLIENT_PRIVATE_KEY: key(),
        }),
        issuer = 'https://auth.example.test';
      let tokenRequests = 0;
      let actualDid = 'did:plc:fixture';
      const transport: bluesky.BlueskyTransport = {
        lookup: async () => [{ address: '8.8.8.8', family: 4 }],
        fetch: async (url, init = {}) => {
          const target = String(url);
          if (target === bluesky.clientId(config))
            return new Response(JSON.stringify(bluesky.clientMetadata(config)));
          if (target.includes('resolveHandle'))
            return new Response(JSON.stringify({ did: actualDid }));
          if (target.startsWith('https://plc.directory/'))
            return new Response(
              JSON.stringify({
                alsoKnownAs: ['at://fixture.bsky.social'],
                service: [
                  {
                    id: '#atproto_pds',
                    serviceEndpoint: 'https://pds.example.test',
                  },
                ],
              }),
            );
          if (target.endsWith('oauth-protected-resource'))
            return new Response(
              JSON.stringify({ authorization_servers: [issuer] }),
            );
          if (target.endsWith('oauth-authorization-server'))
            return new Response(
              JSON.stringify({
                issuer,
                authorization_endpoint: issuer + '/authorize',
                token_endpoint: issuer + '/token',
                pushed_authorization_request_endpoint: issuer + '/par',
              }),
            );
          if (target.endsWith('/par')) {
            const body = init.body as URLSearchParams;
            assert.equal(
              body.get('scope'),
              'atproto repo:app.bsky.feed.post blob:*/*',
            );
            const assertion = body.get('client_assertion')!;
            const claims = JSON.parse(
              Buffer.from(assertion.split('.')[1]!, 'base64url').toString(),
            );
            assert.equal(claims.aud, issuer);
            checkProof(new Headers(init.headers).get('dpop')!);
            return new Response(
              JSON.stringify({ request_uri: 'urn:fixture:par' }),
              { headers: { 'DPoP-Nonce': 'par-nonce' } },
            );
          }
          if (target.endsWith('/token')) {
            tokenRequests++;
            const proof = checkProof(new Headers(init.headers).get('dpop')!);
            if (proof.claims.nonce === 'par-nonce') {
              return new Response('{}', {
                status: 400,
                headers: { 'DPoP-Nonce': 'token-nonce' },
              });
            }
            assert.equal(proof.claims.nonce, 'token-nonce');
            return new Response(
              JSON.stringify({
                access_token: 'access',
                refresh_token: 'refresh',
                sub: actualDid,
                expires_in: 3600,
                scope: 'atproto repo:app.bsky.feed.post blob:*/*',
              }),
              { headers: { 'DPoP-Nonce': 'token-nonce' } },
            );
          }
          throw Error('Unexpected fixture URL');
        },
      };
      const location = await bluesky.startWithState(
        pool,
        config,
        'user',
        'org',
        '@fixture',
        'state',
        ['SOCIAL_PUBLISH', 'MEDIA_PUBLISH'],
        transport,
      );
      assert.equal(
        new URL(location).searchParams.get('request_uri'),
        'urn:fixture:par',
      );
      const stored = (
        await pool.query('SELECT * FROM "SocialOAuthAuthorization"')
      ).rows[0];
      assert.notEqual(
        stored.codeVerifier,
        decryptSocialSecret(config, stored.codeVerifier),
      );
      assert.notEqual(
        stored.dpopPrivateKey,
        decryptSocialSecret(config, stored.dpopPrivateKey),
      );
      await assert.rejects(
        bluesky.complete(
          pool,
          config,
          'state',
          'code',
          'https://different.example.test',
          transport,
        ),
        /issuer mismatch/,
      );
      assert.equal(tokenRequests, 0);
      actualDid = 'did:plc:other';
      await assert.rejects(
        bluesky.complete(pool, config, 'state', 'code', issuer, transport),
        /different account/,
      );
      assert.equal(
        (await pool.query('SELECT count(*) FROM "SocialOAuthAuthorization"'))
          .rows[0].count,
        '1',
      );
      actualDid = 'did:plc:fixture';
      const completed = await bluesky.complete(
        pool,
        config,
        'state',
        'code',
        issuer,
        transport,
      );
      assert.equal(completed.did, 'did:plc:fixture');
      assert.equal(completed.orgId, 'org');
      assert.equal(
        (await pool.query('SELECT count(*) FROM "SocialOAuthAuthorization"'))
          .rows[0].count,
        '0',
      );
      await assert.rejects(
        bluesky.complete(pool, config, 'state', 'code', issuer, transport),
        /expired/,
      );
      const refreshed = await bluesky.refresh(
        config,
        completed.refreshToken,
        completed.authorizationUrl,
        completed.dpopPrivateKey,
        completed.authorizationNonce,
        transport,
      );
      assert.equal(refreshed.accessToken, 'access');
    } finally {
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  },
);


test('Meta Page discovery follows cursors on the trusted endpoint and deduplicates Pages', async () => {
  const calls: URL[] = [];
  const http: HttpFetch = async (input, init = {}) => {
    const url = new URL(String(input));
    calls.push(url);
    assert.equal(url.origin + url.pathname, provider.META_GRAPH_BASE + '/me/accounts');
    assert.equal(url.searchParams.has('access_token'), false);
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer private-user-token');
    if (!url.searchParams.has('after')) return new Response(JSON.stringify({
      data: [{ id: 'one', access_token: 'page-one' }],
      paging: { cursors: { after: 'cursor +/&' }, next: 'https://untrusted.example/?access_token=do-not-follow' },
    }));
    assert.equal(url.searchParams.get('after'), 'cursor +/&');
    return new Response(JSON.stringify({
      data: [{ id: 'one', access_token: 'page-one' }, { id: 'two', access_token: 'page-two' }],
      paging: { cursors: { after: 'terminal' } },
    }));
  };
  assert.deepEqual((await provider.fetchMetaPages('private-user-token', http)).map(page => page.id), ['one', 'two']);
  assert.equal(calls.length, 2);
});

test('Meta Page discovery rejects incomplete pagination instead of returning partial connections', async () => {
  for (const mode of ['missing-cursor', 'repeated-cursor', 'provider-error']) {
    let calls = 0;
    const http: HttpFetch = async () => {
      calls++;
      if (mode === 'provider-error' && calls === 2) return new Response('{}', { status: 503 });
      return new Response(JSON.stringify({
        data: [{ id: 'one' }],
        paging: { next: 'https://graph.facebook.com/next', cursors: mode === 'missing-cursor' ? {} : { after: 'same' } },
      }));
    };
    await assert.rejects(provider.fetchMetaPages('token', http), ApiError);
    assert.equal(calls, mode === 'missing-cursor' ? 1 : 2);
  }
});

test('Meta Page discovery preserves empty and single-batch results', async () => {
  for (const data of [[], [{ id: 'one' }, { id: 'two' }]]) {
    const http: HttpFetch = async () => new Response(JSON.stringify({ data }));
    assert.deepEqual((await provider.fetchMetaPages('token', http)).map(page => page.id), data.map(page => page.id));
  }
});

test('Meta Page discovery bounds pagination and rejects malformed later batches', async () => {
  let calls = 0;
  const endless: HttpFetch = async () => {
    calls++;
    return new Response(JSON.stringify({
      data: [],
      paging: { next: 'next', cursors: { after: String(calls) } },
    }));
  };
  await assert.rejects(provider.fetchMetaPages('token', endless), /pagination limit exceeded/);
  assert.equal(calls, 100);
  calls = 0;
  const malformed: HttpFetch = async () => new Response(JSON.stringify(++calls === 1 ? {
    data: [{ id: 'one' }],
    paging: { next: 'next', cursors: { after: 'cursor' } },
  } : { data: {} }));
  await assert.rejects(provider.fetchMetaPages('token', malformed), /decode provider response/);
  assert.equal(calls, 2);
});
