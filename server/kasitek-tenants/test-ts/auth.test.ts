import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import pg from 'pg';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { readConfig } from '../src-ts/config.js';
import { installErrorHandler } from '../src-ts/error.js';
import { runMigrations } from '../src-ts/migrate.js';
import { installPgTimestampParsers } from '../src-ts/db.js';
import {
  registerAuthRoutes,
  hashPassword,
  newToken,
} from '../src-ts/controllers/auth.js';
import { registerSessionRoutes } from '../src-ts/controllers/session.js';
import {
  registerClientAuthRoutes,
  issueClientInvite,
} from '../src-ts/controllers/client-auth.js';
import {
  registerAdminInvitesRoutes,
  issueAdminInvite,
} from '../src-ts/controllers/admin-invites.js';
import {
  extractAccessContext,
  tokenHash,
  requireActiveTenantClient,
  requireClientScopedConversation,
} from '../src-ts/middleware.js';
import {
  createResendDomain,
  sendEmail,
  sendTenantAdminInviteEmail,
  resolveWorkspaceEmailSender,
  workspacePortalUrl,
} from '../src-ts/mail.js';
const url = process.env.TENANT_TEST_DATABASE_URL;
test(
  'Agency staff/client sessions preserve host binding, distinct audience, invitations and invalidation',
  { skip: !url },
  async () => {
    installPgTimestampParsers();
    const admin = new pg.Pool({ connectionString: url }),
      schema = `tenant_auth_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({
      connectionString: url,
      options: `-c search_path=${schema} -c timezone=UTC`,
    });
    const app = Fastify({
      ajv: {
        customOptions: {
          coerceTypes: false,
          removeAdditional: false,
          useDefaults: false,
        },
      },
    });
    const config = readConfig({
        TENANT_DATABASE_URL: url,
        TENANT_PLATFORM_BASE_DOMAIN: 'agency.example',
        TENANT_APP_BASE_URL: 'http://localhost:3001',
      }),
      context = { pool, config };
    try {
      await runMigrations(pool);
      await app.register(cookie);
      installErrorHandler(app);
      registerAuthRoutes(app, context);
      registerSessionRoutes(app, context);
      registerClientAuthRoutes(app, context);
      registerAdminInvitesRoutes(app, context);
      app.get('/fixture/access', (request) =>
        extractAccessContext(request, context),
      );
      const hash = await hashPassword('fixture password');
      await pool.query(
        "INSERT INTO workspaces(id,slug,display_name) VALUES ('a','alpha','Agency A'),('b','beta','Agency B')",
      );
      await pool.query(
        "INSERT INTO workspace_domains(id,workspace_id,domain) VALUES ('custom','a','custom.example')",
      );
      await pool.query(
        "INSERT INTO tenant_users(id,workspace_id,email,password_hash,status) VALUES ('staff-a','a','staff@example.test',$1,'active'),('staff-b','b','staff@example.test',$1,'active'),('setup-a','a','setup@example.test','','invited')",
        [hash],
      );
      await pool.query(
        "INSERT INTO tenant_user_roles(tenant_user_id,role) VALUES ('staff-a','admin'),('staff-a','staff'),('setup-a','admin')",
      );
      await pool.query(
        "INSERT INTO tenant_clients(id,workspace_id,name,slug) VALUES ('client-a','a','Client A','a'),('client-b','b','Client B','b'),('sibling-client','a','Sibling Client','sibling')",
      );
      await pool.query(
        "INSERT INTO tenant_client_users(id,workspace_id,tenant_client_id,email,password_hash,status) VALUES ('customer-a','a','client-a','customer@example.test',$1,'active'),('invite-customer','a','client-a','invite@example.test',NULL,'invited')",
        [hash],
      );
      await pool.query(
        "INSERT INTO tenant_client_user_roles(tenant_client_user_id,role) VALUES ('customer-a','client'),('invite-customer','client')",
      );
      const call = (
        method: 'GET' | 'POST',
        path: string,
        payload?: unknown,
        cookies = '',
        host = 'alpha.agency.example',
      ) =>
        app.inject({
          method,
          url: path,
          headers: { host, ...(cookies ? { cookie: cookies } : {}) },
          ...(payload === undefined ? {} : { payload }),
        });
      const malformed = await call('POST', '/api/auth/login', {
        email: 42,
        password: 'fixture password',
      });
      assert.equal(malformed.statusCode, 400);
      assert.match(malformed.headers['content-type']!, /text\/plain/);
      assert.equal(
        (
          await call('POST', '/api/auth/accept-admin-invite', {
            token: 'fixture',
            password: 'fixture',
            name: 42,
          })
        ).statusCode,
        400,
      );
      const login = await call('POST', '/api/auth/session/login', {
        email: ' STAFF@EXAMPLE.TEST ',
        password: ' fixture password ',
      });
      assert.equal(login.statusCode, 200, login.body);
      assert.equal(login.json().audience, 'tenant');
      assert.deepEqual(login.json().user.roles, ['admin', 'staff']);
      const staffCookie = login.cookies.find(
        (c) => c.name === config.session_cookie_name,
      )!;
      assert.ok(staffCookie.httpOnly);
      assert.equal(staffCookie.sameSite, 'Lax');
      const staffHeader = `${staffCookie.name}=${staffCookie.value}`;
      assert.equal(
        (await call('GET', '/api/auth/me', undefined, staffHeader)).json().user
          .id,
        'staff-a',
      );
      assert.equal(
        (
          await call(
            'GET',
            '/api/auth/me',
            undefined,
            staffHeader,
            'beta.agency.example',
          )
        ).statusCode,
        401,
      );
      assert.equal(
        (
          await call(
            'GET',
            '/api/auth/me',
            undefined,
            staffHeader,
            'custom.example',
          )
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await call(
            'GET',
            '/api/auth/me',
            undefined,
            staffHeader,
            'unknown.example',
          )
        ).statusCode,
        404,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT token_hash FROM tenant_sessions WHERE tenant_user_id=$1',
            ['staff-a'],
          )
        ).rows[0].token_hash,
        tokenHash(staffCookie.value),
      );
      const token = newToken();
      await pool.query(
        "INSERT INTO workspace_api_keys(id,workspace_id,label,key_prefix,key_hash,scopes) VALUES ('key','b','fixture','fixture',$1,'[\"tenant:read\",4]')",
        [tokenHash(token)],
      );
      const keyed = await app.inject({
        method: 'GET',
        url: '/fixture/access',
        headers: {
          host: 'alpha.agency.example',
          authorization: `Bearer ${token}`,
        },
      });
      assert.equal(keyed.json().workspace_id, 'b');
      assert.deepEqual(keyed.json().scopes, ['tenant:read']);
      assert.equal(
        (
          await app.inject({
            method: 'GET',
            url: '/fixture/access',
            headers: {
              host: 'alpha.agency.example',
              authorization: `Bearer ${token}`,
              cookie: `${config.session_cookie_name}=`,
            },
          })
        ).statusCode,
        401,
      );
      const client = await call(
        'POST',
        '/api/auth/session/login',
        { email: 'customer@example.test', password: 'fixture password' },
        staffHeader,
      );
      assert.equal(client.statusCode, 200, client.body);
      assert.equal(client.json().audience, 'client');
      assert.equal(
        client.cookies.find((c) => c.name === config.session_cookie_name)!
          .value,
        '',
      );
      const cCookie = client.cookies.find(
          (c) => c.name === config.client_session_cookie_name,
        )!,
        clientHeader = `${cCookie.name}=${cCookie.value}`;
      assert.equal(
        (await call('GET', '/api/auth/me', undefined, clientHeader)).statusCode,
        401,
      );
      assert.equal(
        (
          await call('GET', '/api/client-auth/me', undefined, clientHeader)
        ).json().clientUser.tenantClientId,
        'client-a',
      );
      assert.equal(
        (
          await call(
            'GET',
            '/api/client-auth/me',
            undefined,
            clientHeader,
            'beta.agency.example',
          )
        ).statusCode,
        401,
      );
      await assert.rejects(
        () => requireActiveTenantClient(pool, 'a', 'client-b'),
        /not found/,
      );
      await assert.rejects(
        () => requireClientScopedConversation(pool, 'a', 'client-b', 'absent'),
        /conversation not found/,
      );
      await pool.query(
        "INSERT INTO conversations(id,workspace_id,tenant_client_id,channel,customer_identifier) VALUES ('own-conversation','a','client-a','website','own'),('sibling-conversation','a','sibling-client','website','sibling')",
      );
      await requireClientScopedConversation(
        pool,
        'a',
        'client-a',
        'own-conversation',
      );
      await assert.rejects(
        () =>
          requireClientScopedConversation(
            pool,
            'a',
            'client-a',
            'sibling-conversation',
          ),
        /conversation not found/,
      );
      const invitation = await issueClientInvite(
        context,
        'a',
        'alpha',
        'client-a',
        'invite-customer',
        'invite@example.test',
        null,
      );
      assert.equal(invitation.email_sent, false);
      const inviteToken = new URL(invitation.activation_url!).searchParams.get(
        'token',
      )!;
      assert.equal(
        (
          await call(
            'GET',
            `/api/client-auth/invite?token=${inviteToken}`,
            undefined,
            '',
            'beta.agency.example',
          )
        ).statusCode,
        401,
      );
      assert.equal(
        (
          await call('GET', `/api/client-auth/invite?token=${inviteToken}`)
        ).json().invite.isValid,
        true,
      );
      const accepted = await call('POST', '/api/client-auth/accept-invite', {
        token: inviteToken,
        password: 'x',
        name: ' Fixture Client ',
      });
      assert.equal(accepted.statusCode, 200, accepted.body);
      assert.equal(accepted.json().clientUser.name, 'Fixture Client');
      assert.equal(
        (
          await call('POST', '/api/client-auth/accept-invite', {
            token: inviteToken,
            password: 'x',
          })
        ).statusCode,
        401,
      );
      const setup = await call('POST', '/api/auth/session/continue', {
        email: 'setup@example.test',
      });
      assert.equal(setup.json().nextStep, 'setup_link_sent');
      const adminToken = new URL(setup.json().activationUrl).searchParams.get(
        'token',
      )!;
      assert.equal(
        (
          await call('POST', '/api/auth/accept-admin-invite', {
            token: adminToken,
            password: 'short',
          })
        ).statusCode,
        400,
      );
      const adminAccepted = await call(
        'POST',
        '/api/auth/accept-admin-invite',
        { token: adminToken, password: 'long enough', name: 'Fixture Admin' },
      );
      assert.equal(adminAccepted.statusCode, 200, adminAccepted.body);
      assert.equal(adminAccepted.json().user.name, 'Fixture Admin');
      assert.equal(
        (
          await call('POST', '/api/auth/accept-admin-invite', {
            token: adminToken,
            password: 'long enough',
          })
        ).statusCode,
        400,
      );
      const rollbackInvite = await issueAdminInvite(
        context,
        'a',
        'alpha',
        'Agency A',
        'setup-a',
        'setup@example.test',
      );
      const rollbackToken = new URL(
        rollbackInvite.activation_url!,
      ).searchParams.get('token')!;
      await pool.query(`CREATE FUNCTION fixture_fail_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture failure'; END $$;
       CREATE TRIGGER fixture_fail BEFORE INSERT ON tenant_sessions FOR EACH ROW EXECUTE FUNCTION fixture_fail_session()`);
      const failedActivation = await call(
        'POST',
        '/api/auth/accept-admin-invite',
        {
          token: rollbackToken,
          password: 'rollback password',
          name: 'Rollback name',
        },
      );
      assert.equal(failedActivation.statusCode, 500);
      assert.equal(failedActivation.json().error, 'database error');
      assert.equal(
        (
          await pool.query(
            'SELECT accepted_at FROM tenant_user_invites WHERE token_hash=$1',
            [tokenHash(rollbackToken)],
          )
        ).rows[0].accepted_at,
        null,
      );
      assert.equal(
        (await pool.query("SELECT name FROM tenant_users WHERE id='setup-a'"))
          .rows[0].name,
        'Fixture Admin',
      );
      await pool.query(
        'DROP TRIGGER fixture_fail ON tenant_sessions;DROP FUNCTION fixture_fail_session()',
      );
      const expired = await issueAdminInvite(
        context,
        'a',
        'alpha',
        'Agency A',
        'setup-a',
        'setup@example.test',
      );
      const expiredToken = new URL(expired.activation_url!).searchParams.get(
        'token',
      )!;
      await pool.query(
        "UPDATE tenant_user_invites SET expires_at=NOW()-interval '1 second' WHERE token_hash=$1",
        [tokenHash(expiredToken)],
      );
      assert.equal(
        (
          await call('GET', `/api/auth/admin-invite?token=${expiredToken}`)
        ).json().invite.isValid,
        false,
      );
      await pool.query(
        "UPDATE tenant_users SET status='disabled' WHERE id='staff-a'",
      );
      assert.equal(
        (await call('GET', '/api/auth/me', undefined, staffHeader)).statusCode,
        401,
      );
      await pool.query(
        "UPDATE tenant_client_sessions SET expires_at=NOW()-interval '1 second' WHERE token_hash=$1",
        [tokenHash(cCookie.value)],
      );
      assert.equal(
        (await call('GET', '/api/client-auth/me', undefined, clientHeader))
          .statusCode,
        401,
      );
      assert.equal(
        (
          await call(
            'POST',
            '/api/auth/session/logout',
            {},
            `${staffHeader}; ${clientHeader}`,
          )
        ).statusCode,
        200,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*) FROM tenant_sessions WHERE token_hash=$1',
            [tokenHash(staffCookie.value)],
          )
        ).rows[0].count,
        '0',
      );
      assert.equal(
        (
          await pool.query(
            'SELECT count(*) FROM tenant_client_sessions WHERE token_hash=$1',
            [tokenHash(cCookie.value)],
          )
        ).rows[0].count,
        '0',
      );
    } finally {
      await app.close();
      await pool.end();
      try {
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await admin.end();
      }
    }
  },
);
test('Agency Resend domain/mail adapters retain provider status, sender and invitation content without real delivery', async () => {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const part of req) text += part;
    if (text) bodies.push(JSON.parse(text));
    res.setHeader('content-type', 'application/json');
    if (req.url === '/domains')
      return res.end(
        JSON.stringify({
          data: {
            id: 'fixture-domain',
            name: 'mail.example.test',
            status: 'verified',
            verified_at: '2026-10-02T18:20:30.123456Z',
            records: [
              {
                record: 'SPF',
                type: 'TXT',
                name: 'send',
                value: 'fixture',
                status: 'verified',
              },
            ],
          },
        }),
      );
    res.writeHead(req.headers['x-unused'] ? 500 : 201);
    res.end('{}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const config = readConfig({
    TENANT_DATABASE_URL: 'postgres://fixture',
    TENANT_RESEND_API_KEY: 'synthetic',
    TENANT_RESEND_FROM_EMAIL: 'Fixture <fixture@example.test>',
    TENANT_APP_BASE_URL: 'http://localhost:3001',
  });
  const context = { pool: {} as pg.Pool, config },
    options = {
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    };
  try {
    assert.equal(workspacePortalUrl(context, 'a'), 'http://localhost:3001');
    const domain = await createResendDomain(
      context,
      'mail.example.test',
      options,
    );
    assert.equal(domain.provider_domain_id, 'fixture-domain');
    assert.ok(domain.verified_at);
    assert.equal(
      domain.verified_at!.toISOString(),
      '2026-10-02T18:20:30.123456Z',
    );
    assert.equal(domain.records[0]!.record_type, 'TXT');
    assert.deepEqual(bodies[0], {
      name: 'mail.example.test',
      region: 'eu-west-1',
    });
    await sendTenantAdminInviteEmail(
      context,
      'target@example.test',
      'Fixture Agency',
      'https://fixture/setup?token=synthetic',
      null,
      new Date('2026-10-03T10:00:00Z'),
      options,
    );
    assert.match(String(bodies[1]!.text), /2026-10-03 10:00 UTC/);
    assert.match(String(bodies[1]!.html), /complete portal setup/);
    await sendEmail(
      context,
      {
        sending_mode: 'shared',
        sender_name: 'Fixture',
        from_email: 'from@example.test',
        reply_to_email: null,
        domain_status: 'shared',
        active_domain_id: null,
        active_domain: null,
      },
      ['target@example.test'],
      'Fixture',
      'text',
      'html',
      options,
    );
    assert.equal(bodies[2]!.reply_to, null);
    await assert.rejects(
      () =>
        createResendDomain(context, 'fixture', {
          fetch: async () =>
            new Response('{"message":"provider denied"}', { status: 422 }),
        }),
      /bad request: provider denied/,
    );
    await assert.rejects(
      () =>
        sendEmail(
          context,
          {
            sending_mode: 'shared',
            sender_name: 'Fixture',
            from_email: 'from@example.test',
            reply_to_email: null,
            domain_status: 'shared',
            active_domain_id: null,
            active_domain: null,
          },
          [],
          '',
          '',
          '',
          { fetch: async () => new Response('{}', { status: 202 }) },
        ),
      /Failed to send email/,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
