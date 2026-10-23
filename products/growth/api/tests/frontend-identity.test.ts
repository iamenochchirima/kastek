import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as tcpServer } from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { parse } from 'dotenv';
import pg from 'pg';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { isolatedDatabase } from './helpers/database-fixture.js';
const url = process.env.CORE_FRONTEND_IDENTITY_TEST_DATABASE_URL;
const port = async () => {
  const s = tcpServer();
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  const p = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
};
test(
  'actual Next/Core consumers preserve identity, chat and workspace product persistence',
  { skip: !url, timeout: 120000 },
  async () => {
    const admin = new pg.Pool({ connectionString: url });
    const names = (
      await admin.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename~'^[A-Za-z_]+$' AND tablename<>'_prisma_migrations'`,
      )
    ).rows.map((r) => r.tablename);
    await admin.end();
    const fixture = await isolatedDatabase(url!, 'frontend_identity', names),
      db = new URL(url!);
    // LIKE retains enum-array types in public; bind this draft column to the
    // already cloned local enum without adding public to the search path.
    await fixture.pool
      .query(`ALTER TABLE "SocialPost" ALTER COLUMN channels DROP DEFAULT;
      ALTER TABLE "SocialPost" ALTER COLUMN channels TYPE "SocialPlatform"[] USING channels::text[]::"SocialPlatform"[]`);
    db.searchParams.set('options', String(fixture.pool.options.options));
    const mediaPath = await mkdtemp(
      resolve(tmpdir(), 'growth-consumer-media-'),
    );
    const corePort = await port(),
      frontPort = await port(),
      providerPort = await port(),
      front = `http://127.0.0.1:${frontPort}`,
      issuer = `http://127.0.0.1:${providerPort}`;
    const keys = await generateKeyPair('RS256'),
      jwk = {
        ...(await exportJWK(keys.publicKey)),
        kid: 'fixture',
        use: 'sig',
        alg: 'RS256',
      };
    let authorization: URL | undefined,
      exchanges = 0;
    let expectedOrg = '',
      expectedActor = '',
      disconnected = false;
    const agentRequests: string[] = [];
    const streamText = 'event: message\ndata: {"text":"Fixture reply"}\n\n';
    const binary = Buffer.from('524946460400000057415645000102ff', 'hex');
    const provider = createServer(async (request, response) => {
      try {
        const path = new URL(request.url!, issuer);
        response.setHeader('content-type', 'application/json');
        if (path.pathname.startsWith('/v1/')) {
          const token = request.headers.authorization!.slice(7),
            [encoded, signature] = token.split('.');
          assert.equal(
            signature,
            createHmac('sha256', 'fixture-agents-secret')
              .update(encoded!)
              .digest('base64url'),
          );
          const claims = JSON.parse(
            Buffer.from(encoded!, 'base64url').toString(),
          );
          assert.equal(claims.organizationId, expectedOrg);
          assert.equal(claims.actorId, expectedActor);
          assert.equal(claims.audience, 'fixture-agents');
          assert.ok(claims.expiresAt > Math.floor(Date.now() / 1000));
          agentRequests.push(path.pathname);
          if (path.pathname.endsWith('/platform/messages')) {
            assert.deepEqual(claims.scopes, ['chat:write']);
            let body = '';
            for await (const chunk of request) body += chunk;
            assert.equal(JSON.parse(body).message, 'Fixture chat');
            response.writeHead(202);
            return response.end(
              '{"runId":"fixture-run","conversationId":"fixture-conversation"}',
            );
          }
          if (path.pathname.endsWith('/events/stream')) {
            assert.deepEqual(claims.scopes, ['agents:read']);
            response.setHeader('content-type', 'text/event-stream');
            response.write(streamText);
            if (path.searchParams.get('after') === '1') {
              const timer = setInterval(
                () => response.write(': fixture heartbeat\n\n'),
                25,
              );
              response.on('close', () => {
                clearInterval(timer);
                disconnected = true;
              });
              return;
            }
            return response.end();
          }
          if (path.pathname.endsWith('/platform/audio')) {
            assert.deepEqual(claims.scopes, ['chat:write']);
            assert.match(
              request.headers['content-type']!,
              /^multipart\/form-data; boundary=/,
            );
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const body = Buffer.concat(chunks);
            assert.ok(body.includes(binary));
            assert.ok(body.includes(Buffer.from('fixture.wav')));
            assert.equal(
              request.headers['x-audio-conversation-id'],
              'fixture-conversation',
            );
            response.writeHead(202);
            return response.end('{"jobId":"fixture-audio","status":"queued"}');
          }
          response.writeHead(404);
          return response.end('{}');
        }
        if (path.pathname === '/.well-known/openid-configuration')
          return response.end(
            JSON.stringify({
              issuer,
              authorization_endpoint: issuer + '/auth',
              token_endpoint: issuer + '/token',
              jwks_uri: issuer + '/jwks',
              response_types_supported: ['code'],
              subject_types_supported: ['public'],
              id_token_signing_alg_values_supported: ['RS256'],
              token_endpoint_auth_methods_supported: [
                'client_secret_post',
                'client_secret_basic',
              ],
            }),
          );
        if (path.pathname === '/jwks')
          return response.end(JSON.stringify({ keys: [jwk] }));
        if (path.pathname === '/auth') {
          authorization = path;
          const destination = new URL(path.searchParams.get('redirect_uri')!);
          destination.searchParams.set(
            'state',
            path.searchParams.get('state')!,
          );
          destination.searchParams.set('code', 'fixture-code');
          response.writeHead(302, { location: destination.href });
          return response.end();
        }
        if (path.pathname === '/token') {
          let body = '';
          for await (const chunk of request) body += chunk;
          const fields = new URLSearchParams(body);
          assert.equal(fields.get('code'), 'fixture-code');
          assert.equal(
            createHash('sha256')
              .update(fields.get('code_verifier')!)
              .digest('base64url'),
            authorization!.searchParams.get('code_challenge'),
          );
          exchanges++;
          const token = await new SignJWT({
            nonce: authorization!.searchParams.get('nonce'),
            email: 'fixture@example.test',
            email_verified: true,
            name: 'Fixture',
            auth_time: Math.floor(Date.now() / 1000),
            sid: 'fixture-session',
          })
            .setProtectedHeader({ alg: 'RS256', kid: 'fixture' })
            .setIssuer(issuer)
            .setAudience('fixture')
            .setSubject('fixture-subject')
            .setIssuedAt()
            .setExpirationTime('5m')
            .sign(keys.privateKey);
          return response.end(
            JSON.stringify({
              access_token: 'fixture-access',
              token_type: 'Bearer',
              id_token: token,
              refresh_token: 'fixture-refresh',
              expires_in: 300,
            }),
          );
        }
        if (path.pathname.endsWith('/token/introspect'))
          return response.end('{"active":true}');
        response.writeHead(404);
        response.end('{}');
      } catch {
        response.writeHead(500);
        response.end('{}');
      }
    });
    provider.listen(providerPort, '127.0.0.1');
    await once(provider, 'listening');
    const clientDir = resolve('../web'),
      env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
      };
    for (const name of Object.keys(parse(readFileSync('.env')))) env[name] = '';
    Object.assign(env, {
      DATABASE_URL: db.toString(),
      ENVIRONMENT: 'test',
      LOG_LEVEL: 'silent',
      OTEL_SDK_DISABLED: 'true',
      KASITEK_DISABLE_BACKGROUND_WORKERS: '1',
      PORT: String(corePort),
      FRONTEND_URL: front,
      OIDC_ISSUER_URL: issuer,
      OIDC_CLIENT_ID: 'fixture',
      OIDC_CLIENT_SECRET: 'fixture',
      OIDC_REDIRECT_URI: front + '/api/auth/callback',
      AGENTS_API_URL: issuer,
      CORE_API_BASE_URL: `http://127.0.0.1:${corePort}`,
      KASITEK_CORE_PUBLIC_URL: `http://127.0.0.1:${corePort}`,
      KASITEK_MEDIA_STORAGE_PATH: mediaPath,
      NEXT_TELEMETRY_DISABLED: '1',
    });
    const children: Array<ReturnType<typeof spawn>> = [];
    let logs = '';
    const launch = (args: string[], cwd?: string) => {
      const child = spawn(process.execPath, args, {
        env,
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout?.on('data', (b) => (logs += b));
      child.stderr?.on('data', (b) => (logs += b));
      children.push(child);
      return child;
    };
    const cookies = new Map<string, string>();
    const request = async (path: string, init: RequestInit = {}) => {
      const response = await fetch(
        path.startsWith('http') ? path : front + path,
        {
          ...init,
          redirect: 'manual',
          headers: {
            ...init.headers,
            ...(cookies.size
              ? { cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') }
              : {}),
          },
        },
      );
      for (const cookie of response.headers.getSetCookie()) {
        const [pair] = cookie.split(';'),
          index = pair!.indexOf('=');
        cookies.set(pair!.slice(0, index), pair!.slice(index + 1));
      }
      return response;
    };
    try {
      launch([resolve('dist/bootstrap.js')]);
      const nextModule = pathToFileURL(
        resolve(clientDir, 'node_modules/next/dist/server/next.js'),
      ).href;
      launch(
        [
          '--input-type=module',
          '-e',
          `import http from 'node:http';const next=(await import(${JSON.stringify(nextModule)})).default;const app=next({dev:false,dir:${JSON.stringify(clientDir)}});await app.prepare();const server=http.createServer(app.getRequestHandler());server.listen(${frontPort},'127.0.0.1');process.on('SIGTERM',async()=>{server.close();await app.close();process.exit(0);});`,
        ],
        clientDir,
      );
      const deadline = Date.now() + 60000;
      let ready = false;
      while (
        Date.now() < deadline &&
        children.every((child) => child.exitCode === null)
      ) {
        try {
          if ((await fetch(front + '/api/auth/me')).status === 401) {
            ready = true;
            break;
          }
        } catch {}
        await delay(200);
      }
      assert.ok(ready, logs);
      const login = await request('/api/auth/login?returnTo=/workspace');
      assert.equal(login.status, 302);
      assert.equal(login.headers.get('cache-control'), 'no-store');
      assert.ok(cookies.get('kasitek_login'));
      const authorized = await request(login.headers.get('location')!);
      assert.equal(authorized.status, 302);
      const callback = await request(authorized.headers.get('location')!);
      assert.equal(callback.status, 302);
      assert.equal(
        callback.headers.get('location'),
        front + '/workspace',
        logs,
      );
      assert.ok(cookies.get('kasitek_session'));
      assert.equal(cookies.get('kasitek_login'), '');
      assert.equal(exchanges, 1);
      const me = await request('/api/auth/me');
      assert.equal(me.status, 200);
      const meBody = await me.json();
      assert.equal(meBody.user.email, 'fixture@example.test');
      expectedActor = meBody.user.id;
      const orgs = await request('/api/orgs');
      assert.equal(orgs.status, 200);
      assert.equal((await orgs.json()).orgs.length, 0);
      const created = await request('/api/orgs', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: front },
        body: JSON.stringify({ name: 'Fixture workspace' }),
      });
      assert.equal(created.status, 201, await created.clone().text());
      const id = (await created.json()).org.id;
      expectedOrg = id;
      const read = await request(`/api/orgs/${id}`);
      assert.equal(read.status, 200);
      assert.equal((await read.json()).org.name, 'Fixture workspace');
      const rejected = await request('/api/profile', {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          origin: 'https://untrusted.example.test',
        },
        body: '{"name":"Rejected"}',
      });
      assert.equal(rejected.status, 403);
      const profile = await request('/api/profile', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', origin: front },
        body: '{"name":"Fixture Updated"}',
      });
      assert.equal(profile.status, 200, await profile.clone().text());
      assert.equal(
        (await fixture.pool.query(`SELECT COUNT(*) FROM "ExternalIdentity"`))
          .rows[0].count,
        '1',
      );
      assert.equal(
        (await fixture.pool.query(`SELECT "sessionToken" FROM "Session"`))
          .rows[0].sessionToken,
        createHash('sha256')
          .update(cookies.get('kasitek_session')!)
          .digest('hex'),
      );
      const chat = await request(
        '/api/agents/installations/fixture-installation/platform/messages',
        {
          method: 'POST',
          headers: { origin: front, 'content-type': 'application/json' },
          body: '{"message":"Fixture chat","conversationId":"fixture-conversation","idempotencyKey":"fixture-chat-key"}',
        },
      );
      assert.equal(chat.status, 202, await chat.clone().text());
      assert.equal((await chat.json()).runId, 'fixture-run');
      const stream = await request(
        '/api/agents/conversations/fixture-conversation/events/stream',
      );
      assert.equal(stream.status, 200);
      assert.match(stream.headers.get('content-type')!, /text\/event-stream/);
      assert.equal(await stream.text(), streamText);
      const controller = new AbortController();
      const live = await request(
        '/api/agents/conversations/fixture-conversation/events/stream?after=1',
        { signal: controller.signal },
      );
      const reader = live.body!.getReader();
      assert.ok((await reader.read()).value!.length);
      controller.abort();
      await reader.cancel().catch(() => {});
      const disconnectDeadline = Date.now() + 3000;
      while (!disconnected && Date.now() < disconnectDeadline) await delay(25);
      assert.ok(disconnected, 'Next/native SSE did not disconnect upstream');
      const upload = await request(
        '/api/agents/installations/fixture-installation/platform/audio',
        {
          method: 'POST',
          headers: {
            origin: front,
            'content-type': 'audio/wav',
            'x-audio-idempotency-key': 'fixture-audio-idempotency',
            'x-audio-conversation-id': 'fixture-conversation',
            'x-audio-file-name': 'fixture.wav',
          },
          body: binary,
        },
      );
      assert.equal(upload.status, 202, await upload.clone().text());
      assert.equal((await upload.json()).jobId, 'fixture-audio');
      assert.equal(agentRequests.length, 4);
      // Actual product DTOs pass through the production Next proxy. Every row,
      // uploaded asset and credential below belongs to this isolated fixture.
      const json = async (
        path: string,
        method: string,
        body: unknown,
        status = 200,
      ) => {
        const response = await request(path, {
          method,
          headers: { origin: front, 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });
        assert.equal(
          response.status,
          status,
          `${method} ${path}: ${await response.clone().text()}`,
        );
        return response.json();
      };
      // Mirrors lib/onboarding.ts and the organization logo multipart consumer.
      const onboarding = await json('/api/onboarding', 'PATCH', {
        companyName: 'Fixture Onboarded',
        primaryGoal: 'Grow sales',
        primaryGoals: ['Grow sales'],
        complete: true,
      });
      assert.equal(onboarding.needsOnboarding, false);
      assert.equal(
        (
          await fixture.pool.query(
            'SELECT name FROM "Organization" WHERE id=$1',
            [id],
          )
        ).rows[0].name,
        'Fixture Onboarded',
      );
      const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZQAAAABJRU5ErkJggg==',
        'base64',
      );
      const logoForm = new FormData();
      logoForm.set(
        'file',
        new Blob([png], { type: 'image/png' }),
        'fixture.png',
      );
      const logo = await request(`/api/orgs/${id}/logo`, {
        method: 'POST',
        headers: { origin: front },
        body: logoForm,
      });
      assert.equal(logo.status, 200, await logo.clone().text());
      assert.match((await logo.json()).org.logo, /\/logo\?v=/);
      const logoRead = await request(`/api/orgs/${id}/logo`);
      assert.equal(logoRead.status, 200);
      assert.deepEqual(Buffer.from(await logoRead.arrayBuffer()), png);

      await fixture.pool.query(
        `INSERT INTO "SocialChannelConnection" (id,"userId","orgId",platform,status,"displayName","updatedAt") VALUES ('fixture-social',$1,$2,'FACEBOOK','CONNECTED','Fixture Facebook',now())`,
        [expectedActor, id],
      );
      const draft = await json(
        '/api/social/posts',
        'POST',
        {
          content: 'Fixture draft',
          channels: ['FACEBOOK'],
          channelSelections: { FACEBOOK: 'fixture-social' },
          status: 'DRAFT',
        },
        201,
      );
      await json(`/api/social/posts/${draft.post.id}`, 'PATCH', {
        content: 'Fixture revised draft',
        channelSelections: { FACEBOOK: 'fixture-social' },
      });
      assert.equal(
        (
          await fixture.pool.query(
            'SELECT content FROM "SocialPost" WHERE id=$1',
            [draft.post.id],
          )
        ).rows[0].content,
        'Fixture revised draft',
      );

      await fixture.pool.query(
        `INSERT INTO "ExternalConnection" (id,"orgId",provider,"sourceType","sourceId","displayName",status,"updatedAt") VALUES ('fixture-email',$1,'GOOGLE','EMAIL','fixture-mailbox','Fixture mailbox','CONNECTED',now())`,
        [id],
      );
      await fixture.pool.query(
        `INSERT INTO "Conversation" (id,channel,"customerIdentifier","customerName","orgId","externalConnectionId","unreadCount","updatedAt") VALUES ('fixture-inbox','email','email:fixture-mailbox:customer@example.test','Fixture Customer',$1,'fixture-email',1,now()),('foreign-inbox','email','email:foreign:customer@example.test','Foreign Customer','foreign-org',NULL,1,now())`,
        [id],
      );
      await fixture.pool.query(
        `INSERT INTO "Message" (id,"conversationId",sender,content) VALUES ('fixture-message','fixture-inbox','customer','Fixture inbox message')`,
      );
      const inbox = await request('/api/inbox/conversations');
      assert.equal(inbox.status, 200, await inbox.clone().text());
      const inboxBody = await inbox.json();
      assert.ok(
        inboxBody.conversations.some(
          (row: { id: string }) => row.id === 'fixture-inbox',
        ),
      );
      assert.ok(
        !inboxBody.conversations.some(
          (row: { id: string }) => row.id === 'foreign-inbox',
        ),
      );
      const messages = await request('/api/inbox/fixture-inbox/messages');
      assert.equal(messages.status, 200, await messages.clone().text());
      assert.match(await messages.text(), /Fixture inbox message/);
      await json('/api/inbox/fixture-inbox/read', 'POST', {});
      assert.equal(
        (
          await fixture.pool.query(
            'SELECT "unreadCount" FROM "Conversation" WHERE id=$1',
            ['fixture-inbox'],
          )
        ).rows[0].unreadCount,
        0,
      );
      assert.equal(
        (await request('/api/inbox/foreign-inbox/messages')).status,
        404,
      );
      assert.equal(
        (
          await request('/api/inbox/foreign-inbox/read', {
            method: 'POST',
            headers: { origin: front },
          })
        ).status,
        404,
      );

      await fixture.pool.query(
        `INSERT INTO "OrganizationEntitlementGrant" (id,"orgId",key,value,source,"updatedAt") VALUES ('fixture-campaign-grant',$1,'feature.campaigns.manage','true','MANUAL',now())`,
        [id],
      );
      // Mirrors contacts-manager.tsx CSV import/export without opting contacts in.
      const contactForm = new FormData();
      contactForm.set(
        'file',
        new Blob([
          'phone,fullName\n+27820000123,Fixture Contact\n',
          '\n'.repeat(5 * 1024 * 1024 + 1),
        ], {
          type: 'text/csv',
        }),
        'fixture.csv',
      );
      contactForm.set('defaultOptIn', 'false');
      contactForm.set('consentConfirmed', 'false');
      contactForm.set('listLabel', 'Fixture List');
      const imported = await request('/api/whatsapp/contacts/import', {
        method: 'POST',
        headers: { origin: front },
        body: contactForm,
      });
      assert.equal(imported.status, 200, await imported.clone().text());
      assert.equal((await imported.json()).summary.created, 1);
      const exported = await request(
        '/api/whatsapp/contacts/lists/Fixture%20List/export',
      );
      assert.equal(exported.status, 200, await exported.clone().text());
      assert.match(exported.headers.get('content-type')!, /text\/csv/);
      const csv = await exported.text();
      assert.match(csv, /27820000123/);
      assert.match(csv, /Fixture Contact/);

      const service = await json(
        '/api/bookings/services',
        'POST',
        { name: 'Fixture consultation', durationMinutes: 30 },
        201,
      );
      const booking = await json(
        '/api/bookings',
        'POST',
        {
          serviceId: service.service.id,
          contactName: 'Fixture Customer',
          scheduledStart: new Date(Date.now() + 86400000).toISOString(),
        },
        201,
      );
      await json(`/api/bookings/${booking.booking.id}`, 'PATCH', {
        status: 'CONFIRMED',
        notes: 'Fixture booking updated',
      });
      assert.equal(
        (
          await fixture.pool.query('SELECT notes FROM "Booking" WHERE id=$1', [
            booking.booking.id,
          ])
        ).rows[0].notes,
        'Fixture booking updated',
      );

      await fixture.pool.query(
        `INSERT INTO "NotificationEvent" (id,"scopeType","scopeId","eventType",title,message,severity) VALUES ('fixture-notification-event','USER',$1,'fixture.notification','Fixture notice','Fixture notice body','INFO')`,
        [expectedActor],
      );
      await fixture.pool.query(
        `INSERT INTO "Notification" (id,"eventId","recipientType","recipientId",channel,status,"updatedAt") VALUES ('fixture-notification','fixture-notification-event','USER',$1,'IN_APP','PENDING',now()),('foreign-notification','fixture-notification-event','USER','foreign-user','IN_APP','PENDING',now())`,
        [expectedActor],
      );
      const notificationRead = await request('/api/notifications');
      assert.equal(notificationRead.status, 200);
      assert.match(await notificationRead.text(), /Fixture notice/);
      await json('/api/notifications/fixture-notification', 'PATCH', {});
      assert.ok(
        (
          await fixture.pool.query(
            'SELECT "readAt" FROM "Notification" WHERE id=$1',
            ['fixture-notification'],
          )
        ).rows[0].readAt,
      );
      assert.equal(
        (
          await request('/api/notifications/foreign-notification', {
            method: 'PATCH',
            headers: { origin: front, 'content-type': 'application/json' },
            body: '{}',
          })
        ).status,
        404,
      );

      // Mirrors lib/developers.ts creation/rotation; secret appears only on creation.
      const key = await json(
        '/api/developers/api-keys',
        'POST',
        { name: 'Fixture consumer' },
        201,
      );
      const rotated = await json(
        `/api/developers/api-keys/${key.key.id}/rotate`,
        'POST',
        {},
        201,
      );
      assert.notEqual(rotated.secret, key.secret);
      const developer = await request('/api/developers');
      assert.equal(developer.status, 200);
      const restBase = (await developer.json()).config.restBaseUrl;
      assert.equal(restBase, `http://127.0.0.1:${corePort}/v1`);
      // The public REST consumer uses its advertised Core URL, not /api proxy cookies.
      assert.equal(
        (
          await fetch(restBase + '/contacts', {
            headers: { authorization: `Bearer ${key.secret}` },
          })
        ).status,
        401,
      );
      const publicContacts = await fetch(restBase + '/contacts', {
        headers: { authorization: `Bearer ${rotated.secret}` },
      });
      assert.equal(
        publicContacts.status,
        200,
        await publicContacts.clone().text(),
      );
      assert.match(await publicContacts.text(), /Fixture Contact/);
      const logout = await request('/api/auth/logout', {
        method: 'POST',
        headers: { origin: front },
      });
      assert.equal(logout.status, 200);
      assert.equal(cookies.get('kasitek_session'), '');
      assert.equal((await request('/api/auth/me')).status, 401);
    } finally {
      for (const child of children) {
        if (child.exitCode === null) {
          const exited = once(child, 'exit');
          child.kill('SIGTERM');
          await Promise.race([
            exited,
            delay(5000, undefined, { ref: false }).then(() => {
              child.kill('SIGKILL');
              return exited;
            }),
          ]);
        }
      }
      await new Promise<void>((r) => provider.close(() => r()));
      await fixture.close();
      await rm(mediaPath, { recursive: true, force: true });
    }
  },
);
