import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { isolatedDatabase } from './helpers/database-fixture.js';
import { buildApp } from '../src-ts/app.js';
import { readConfig } from '../src-ts/config.js';
import { registerAuthRoutes } from '../src-ts/routes/auth.js';
import { verifyLogoutToken } from '../src-ts/identity/logout.js';
import { sha256 } from '../src-ts/identity/session.js';
const url = process.env.CORE_IDENTITY_LIFECYCLE_TEST_DATABASE_URL;
test(
  'isolated identity lifecycle preserves simultaneous devices, all-device logout, signed replay and provider account disabling',
  { skip: !url },
  async () => {
    const fixture = await isolatedDatabase(url!, 'identity_lifecycle', [
      'User',
      'Session',
      'ExternalIdentity',
      'OidcLogoutReplay',
    ]);
    const keys = await generateKeyPair('RS256'),
      jwk = {
        ...(await exportJWK(keys.publicKey)),
        kid: 'fixture',
        alg: 'RS256',
        use: 'sig',
      };
    let enabled = true,
      outage = false,
      adminDenied = false,
      malformedRefresh = false,
      providerLogoutCalls = 0,
      introspections = 0;
    const server = createServer(async (request, response) => {
      response.setHeader('content-type', 'application/json');
      if (outage) {
        response.writeHead(503);
        return response.end('{}');
      }
      if (request.url!.endsWith('/certs'))
        return response.end(JSON.stringify({ keys: [jwk] }));
      if (request.url!.endsWith('/token/introspect')) {
        introspections++;
        return response.end(JSON.stringify({ active: enabled }));
      }
      if (request.url!.endsWith('/token')) {
        let body = '';
        for await (const chunk of request) body += chunk;
        const fields = new URLSearchParams(body);
        if (fields.get('grant_type') === 'client_credentials') {
          assert.equal(fields.get('client_id'), 'admin-fixture');
          if (adminDenied) {
            response.writeHead(400);
            return response.end('{"error":"invalid_client"}');
          }
          return response.end('{"access_token":"fixture-admin-access"}');
        }
        if (!enabled) {
          response.writeHead(400);
          return response.end('{"error":"invalid_grant"}');
        }
        return response.end(
          malformedRefresh ? '{}' : '{"refresh_token":"rotated-fixture"}',
        );
      }
      if (request.url === '/admin/realms/fixture/users/subject/logout') {
        assert.equal(
          request.headers.authorization,
          'Bearer fixture-admin-access',
        );
        providerLogoutCalls++;
        response.writeHead(204);
        return response.end();
      }
      response.writeHead(404);
      response.end('{}');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const issuer = `http://127.0.0.1:${(server.address() as { port: number }).port}/realms/fixture`;
    const core = {
        pool: fixture.pool,
        config: readConfig({
          DATABASE_URL: url!,
          LOG_LEVEL: 'silent',
          FRONTEND_URL: 'http://frontend.test',
          OIDC_ISSUER_URL: issuer,
          OIDC_CLIENT_ID: 'fixture',
          OIDC_CLIENT_SECRET: 'fixture-secret',
          OIDC_ADMIN_CLIENT_ID: 'admin-fixture',
          OIDC_ADMIN_CLIENT_SECRET: 'admin-fixture-secret',
        }),
      },
      app = await buildApp(core, [registerAuthRoutes]);
    const pool = fixture.pool;
    const seed = async (token: string, user = 'user', sid = token) =>
      pool.query(
        `INSERT INTO "Session"(id,"sessionToken","userId",expires,"refreshToken","idToken","providerSid") VALUES($1,$2,$3,NOW()+INTERVAL '1 day','fixture-refresh','fixture-id-token',$4)`,
        [token, sha256(token), user, sid],
      );
    const me = (token: string) =>
      app.inject({
        url: '/api/auth/me',
        headers: { cookie: `kasitek_session=${token}` },
      });
    const post = (path: string, token: string) =>
      app.inject({
        method: 'POST',
        url: path,
        headers: {
          cookie: `kasitek_session=${token}`,
          origin: core.config.frontendUrl,
        },
      });
    const size = async (user = 'user') =>
      Number(
        (
          await pool.query(`SELECT COUNT(*) FROM "Session" WHERE "userId"=$1`, [
            user,
          ])
        ).rows[0].count,
      );
    const logoutToken = async (
      jti: string,
      extra: Record<string, unknown> = {},
    ) =>
      new SignJWT({
        iat: Math.floor(Date.now() / 1000),
        jti,
        events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
        ...extra,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
        .setIssuer(issuer)
        .setAudience('fixture')
        .sign(keys.privateKey);
    const backchannel = async (token: string) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/backchannel-logout',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ logout_token: token }).toString(),
      });
    try {
      await pool.query(
        `INSERT INTO "User"(id,email,"emailVerified","updatedAt") VALUES('user','fixture@example.test',NOW(),NOW()),('other','other@example.test',NOW(),NOW())`,
      );
      await pool.query(
        `INSERT INTO "ExternalIdentity"(issuer,subject,"userId") VALUES($1,'subject','user')`,
        [issuer],
      );
      await seed('first');
      await seed('second');
      await seed('unrelated', 'other');
      assert.equal((await me('first')).statusCode, 200);
      assert.equal((await me('second')).statusCode, 200);
      assert.equal(await size(), 2);
      assert.equal((await post('/api/auth/logout', 'first')).statusCode, 200);
      assert.equal((await me('first')).statusCode, 401);
      assert.equal((await me('second')).statusCode, 200);
      assert.equal(await size(), 1);
      await seed('first');
      adminDenied = true;
      assert.equal(
        (await post('/api/auth/logout-all', 'first')).statusCode,
        503,
      );
      assert.equal(await size(), 2);
      adminDenied = false;
      assert.equal(
        (await post('/api/auth/logout-all', 'first')).statusCode,
        200,
      );
      assert.equal(providerLogoutCalls, 1);
      assert.equal(await size(), 0);
      assert.equal((await me('first')).statusCode, 401);
      assert.equal((await me('second')).statusCode, 401);
      assert.equal((await me('unrelated')).statusCode, 200);
      await seed('first');
      await seed('second');
      const signed = await logoutToken('sid-once', { sid: 'first' });
      assert.equal((await backchannel(signed)).statusCode, 200);
      assert.equal(await size(), 1);
      assert.equal((await me('second')).statusCode, 200);
      await seed('first');
      assert.equal((await backchannel(signed)).statusCode, 401);
      assert.equal(await size(), 2);
      assert.equal((await me('first')).statusCode, 200);
      const fractional = await logoutToken('fractional', {
        sid: 'first',
        iat: Math.floor(Date.now() / 1000) + 0.5,
      });
      assert.equal((await backchannel(fractional)).statusCode, 401);
      assert.equal(await size(), 2);
      const subject = await logoutToken('subject-once', {
        sub: 'subject',
        sid: null,
        nonce: null,
        nbf: Math.floor(Date.now() / 1000) + 86400,
        exp: Math.floor(Date.now() / 1000) - 45,
      });
      assert.equal((await backchannel(subject)).statusCode, 200);
      assert.equal(await size(), 0);
      assert.equal(await size('other'), 1);
      await seed('first');
      await seed('second');
      const outageLogout = await logoutToken('outage', { sid: 'first' });
      outage = true;
      assert.equal((await backchannel(outageLogout)).statusCode, 503);
      assert.equal(await size(), 2);
      outage = false;
      // Disabled Keycloak accounts become unusable when each browser reaches the source's bounded revocation check.
      enabled = false;
      assert.equal((await me('first')).statusCode, 200);
      await pool.query(
        `UPDATE "Session" SET "identityCheckedAt"=NOW()-INTERVAL '301 seconds' WHERE "userId"='user'`,
      );
      outage = true;
      assert.equal((await me('first')).statusCode, 503);
      assert.equal(await size(), 2);
      outage = false;
      assert.equal((await me('first')).statusCode, 401);
      assert.equal(await size(), 1);
      assert.equal((await me('second')).statusCode, 401);
      assert.equal(await size(), 0);
      assert.equal(introspections, 2);
      enabled = true;
      await seed('first');
      malformedRefresh = true;
      await pool.query(
        `UPDATE "Session" SET "providerRefreshedAt"=NOW()-INTERVAL '301 seconds' WHERE id='first'`,
      );
      assert.equal((await post('/api/auth/activity', 'first')).statusCode, 401);
      assert.equal(
        await size(),
        1,
        'source rolls back malformed successful refresh without deleting session',
      );
      malformedRefresh = false;
      enabled = false;
      assert.equal((await post('/api/auth/activity', 'first')).statusCode, 401);
      assert.equal(
        await size(),
        0,
        'provider invalid_grant commits session invalidation',
      );
    } finally {
      await app.close();
      await new Promise<void>((r) => server.close(() => r()));
      await fixture.close();
    }
  },
);

test('signed logout claims retain jsonwebtoken9 audience and numeric expiry parsing defaults', async () => {
  const keys = await generateKeyPair('RS256'),
    now = Math.floor(Date.now() / 1000),
    base = {
      iss: 'issuer',
      iat: now,
      jti: 'claims',
      sid: 'browser',
      events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
    };
  const token = async (extra: Record<string, unknown>) =>
    new SignJWT({ ...base, ...extra })
      .setProtectedHeader({ alg: 'RS256' })
      .sign(keys.privateKey);
  // Source _aud is Value, while failed audience decoding falls through jsonwebtoken validation.
  for (const aud of [null, {}, 1, ['fixture', 1], true])
    await verifyLogoutToken(
      await token({ aud }),
      keys.publicKey,
      'issuer',
      'fixture',
    );
  for (const aud of ['other', [], ['other']])
    await assert.rejects(
      verifyLogoutToken(
        await token({ aud }),
        keys.publicKey,
        'issuer',
        'fixture',
      ),
    );
  await assert.rejects(
    verifyLogoutToken(await token({}), keys.publicKey, 'issuer', 'fixture'),
  );
  for (const exp of [undefined, null, '0', -1, now - 45, now - 45.4]) {
    await verifyLogoutToken(
      await token({ aud: 'fixture', exp, nbf: now + 86400 }),
      keys.publicKey,
      'issuer',
      'fixture',
    );
  }
  for (const exp of [now - 65, now - 65.4])
    await assert.rejects(
      verifyLogoutToken(
        await token({ aud: 'fixture', exp }),
        keys.publicKey,
        'issuer',
        'fixture',
      ),
    );
  await assert.rejects(
    verifyLogoutToken(
      await token({ aud: 'fixture', iat: now + 0.5 }),
      keys.publicKey,
      'issuer',
      'fixture',
    ),
  );
});
