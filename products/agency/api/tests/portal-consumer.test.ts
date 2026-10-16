import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { parse } from 'dotenv';
import pg from 'pg';
import { createPool } from '../src/db.js';
import { readConfig } from '../src/config.js';
import { runMigrations } from '../src/migrate.js';
import { hashPassword } from '../src/controllers/auth.js';
import { issueClientInvite } from '../src/controllers/client-auth.js';
const url = process.env.TENANT_TEST_DATABASE_URL;
async function unusedPort() {
  const s = createServer();
  s.listen(0, '127.0.0.1');
  await once(s, 'listening');
  const p = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}
test(
  'compiled Agency portal proxy preserves staff/client journeys, host branding and conversation isolation',
  { skip: !url, timeout: 120000 },
  async () => {
    const admin = new pg.Pool({ connectionString: url }),
      schema = `tenant_portal_${randomUUID().replaceAll('-', '')}`;
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const db = new URL(url!);
    db.searchParams.set('options', `-c search_path=${schema} -c timezone=UTC`);
    const context = {
      pool: createPool(readConfig({ TENANT_DATABASE_URL: db.toString() })),
      config: readConfig({
        TENANT_DATABASE_URL: db.toString(),
        TENANT_PLATFORM_BASE_DOMAIN: 'agency.example',
        TENANT_APP_BASE_URL: 'http://localhost:3010',
      }),
    };
    const { pool } = context;
    const children: ReturnType<typeof spawn>[] = [];
    let output = '';
    try {
      assert.equal(
        (await pool.query('SELECT current_schema() AS name')).rows[0].name,
        schema,
      );
      await runMigrations(pool);
      const password = 'fixture password',
        hash = await hashPassword(password);
      await pool.query(
        "INSERT INTO workspaces(id,slug,display_name) VALUES ('a','alpha','Fixture Agency Alpha'),('b','beta','Fixture Agency Beta')",
      );
      await pool.query(
        "INSERT INTO workspace_branding(workspace_id,display_name,primary_color) VALUES ('a','Fixture Branded Alpha','#123456'),('b','Fixture Branded Beta','#654321')",
      );
      await pool.query(
        "INSERT INTO tenant_users(id,workspace_id,email,password_hash) VALUES ('staff-a','a','staff@example.test',$1),('staff-b','b','staff@example.test',$1)",
        [hash],
      );
      await pool.query(
        "INSERT INTO tenant_user_roles(tenant_user_id,role) VALUES ('staff-a','admin'),('staff-b','admin')",
      );
      await pool.query(
        "INSERT INTO tenant_clients(id,workspace_id,name,slug) VALUES ('client-a','a','Fixture Client A','a'),('client-sibling','a','Fixture Client Sibling','sibling'),('client-b','b','Fixture Client B','b')",
      );
      await pool.query(
        "INSERT INTO tenant_client_users(id,workspace_id,tenant_client_id,email,status) VALUES ('client-user-a','a','client-a','client@example.test','invited')",
      );
      await pool.query(
        "INSERT INTO tenant_client_user_roles(tenant_client_user_id,role) VALUES ('client-user-a','client')",
      );
      await pool.query(
        "INSERT INTO conversations(id,workspace_id,tenant_client_id,channel,customer_identifier) VALUES ('own','a','client-a','website','own'),('sibling','a','client-sibling','website','sibling'),('foreign','b','client-b','website','foreign')",
      );
      await pool.query(
        "INSERT INTO messages(id,workspace_id,conversation_id,sender_role,content) VALUES ('own-message','a','own','customer','Fixture own message'),('sibling-message','a','sibling','customer','Fixture sibling private message'),('foreign-message','b','foreign','customer','Fixture foreign private message')",
      );
      const invitation = await issueClientInvite(
          context,
          'a',
          'alpha',
          'client-a',
          'client-user-a',
          'client@example.test',
          null,
        ),
        token = new URL(invitation.activation_url!).searchParams.get('token')!;
      const corePort = await unusedPort(),
        frontPort = await unusedPort(),
        front = `http://127.0.0.1:${frontPort}`,
        clientDir = resolve('../web');
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
      };
      for (const p of [
        '.env',
        resolve(clientDir, '.env'),
        resolve(clientDir, '.env.local'),
      ])
        if (existsSync(p))
          for (const name of Object.keys(parse(readFileSync(p))))
            env[name] = '';
      Object.assign(env, {
        NODE_ENV: 'production',
        KASITEK_TENANTS_DATABASE_URL: db.toString(),
        TENANT_SERVER_PORT: String(corePort),
        TENANT_PLATFORM_BASE_DOMAIN: 'agency.example',
        TENANT_APP_BASE_URL: front,
        TENANT_BACKEND_URL: `http://127.0.0.1:${corePort}`,
        KASITEK_PROCESS: 'api',
        OTEL_SDK_DISABLED: 'true',
        LOG_LEVEL: 'silent',
        NEXT_TELEMETRY_DISABLED: '1',
        TENANT_RESEND_API_KEY: '',
        AUTH_RESEND_KEY: '',
        ANALYTICS_TENANT_INGESTION_TOKEN: '',
        ANALYTICS_INGESTION_TOKEN: '',
      });
      const launch = (args: string[], cwd?: string) => {
        const child = spawn(process.execPath, args, {
          env,
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout?.on('data', (b) => (output += b));
        child.stderr?.on('data', (b) => (output += b));
        children.push(child);
      };
      launch([resolve('dist/bootstrap.js')]);
      const module = pathToFileURL(
        resolve(clientDir, 'node_modules/next/dist/server/next.js'),
      ).href;
      launch(
        [
          '--input-type=module',
          '-e',
          `import http from 'node:http';const next=(await import(${JSON.stringify(module)})).default;const app=next({dev:false,dir:${JSON.stringify(clientDir)}});await app.prepare();const server=http.createServer(app.getRequestHandler());server.listen(${frontPort},'127.0.0.1');process.on('SIGTERM',async()=>{server.close();await app.close();process.exit(0)});`,
        ],
        clientDir,
      );
      const cookies = new Map<string, string>();
      const request = async (
        path: string,
        method = 'GET',
        body?: unknown,
        host = 'alpha.agency.example',
        withCookies = true,
      ) => {
        // Native HTTP preserves the real virtual Host header; Node fetch may
        // replace Host with the URL's loopback host.
        const response = await new Promise<Response>(
          (resolveResponse, reject) => {
            const outgoing = httpRequest(
              front + '/api/tenant' + path,
              {
                method,
                headers: {
                  host,
                  'content-type': 'application/json',
                  ...(withCookies && cookies.size
                    ? {
                        cookie: [...cookies]
                          .map(([k, v]) => `${k}=${v}`)
                          .join('; '),
                      }
                    : {}),
                },
              },
              (incoming) => {
                const chunks: Buffer[] = [];
                incoming.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
                incoming.on('error', reject);
                incoming.on('end', () => {
                  const headers = new Headers();
                  for (let i = 0; i < incoming.rawHeaders.length; i += 2)
                    headers.append(
                      incoming.rawHeaders[i]!,
                      incoming.rawHeaders[i + 1]!,
                    );
                  resolveResponse(
                    new Response(
                      [204, 304].includes(incoming.statusCode!)
                        ? null
                        : Buffer.concat(chunks),
                      { status: incoming.statusCode!, headers },
                    ),
                  );
                });
              },
            );
            outgoing.on('error', reject);
            outgoing.end(body === undefined ? undefined : JSON.stringify(body));
          },
        );
        for (const value of response.headers.getSetCookie()) {
          const first = value.split(';')[0]!,
            index = first.indexOf('=');
          cookies.set(first.slice(0, index), first.slice(index + 1));
        }
        return response;
      };
      let ready = false;
      for (let i = 0; i < 150; i++) {
        if (children.some((c) => c.exitCode !== null)) throw Error(output);
        try {
          if ((await request('/api/auth/me')).status === 401) {
            ready = true;
            break;
          }
        } catch {}
        await delay(100);
      }
      assert.ok(ready, output);
      const publicContext = await request('/api/public/tenant-context');
      assert.equal(
        publicContext.status,
        200,
        await publicContext.clone().text(),
      );
      const branding = await publicContext.json();
      assert.equal(branding.workspace.id, 'a');
      assert.equal(branding.branding.displayName, 'Fixture Branded Alpha');
      assert.equal(
        (
          await request(
            '/api/public/tenant-context',
            'GET',
            undefined,
            'beta.agency.example',
          )
        ).status,
        200,
      );
      assert.equal(
        (
          await request(
            '/api/public/tenant-context',
            'GET',
            undefined,
            'unknown.example',
          )
        ).status,
        404,
      );
      const staff = await request('/api/auth/session/login', 'POST', {
        email: 'staff@example.test',
        password,
      });
      assert.equal(staff.status, 200, await staff.clone().text());
      assert.equal((await staff.json()).audience, 'tenant');
      assert.equal(
        staff.headers.getSetCookie().length,
        2,
        'Both session cookies must survive the actual proxy as distinct headers',
      );
      assert.equal((await request('/api/auth/session')).status, 200);
      assert.equal(
        (await request('/api/auth/me', 'GET', undefined, 'beta.agency.example'))
          .status,
        401,
      );
      const summary = await request('/api/dashboard/summary');
      assert.equal(summary.status, 200, await summary.clone().text());
      assert.equal((await summary.json()).summary.workspaceId, 'a');
      assert.equal((await request('/api/workspace/branding')).status, 200);
      const staffConversations = await request('/api/conversations');
      assert.equal(staffConversations.status, 200);
      const staffBody = await staffConversations.text();
      assert.match(staffBody, /sibling/);
      assert.doesNotMatch(staffBody, /foreign/);
      assert.equal(
        (await request('/api/conversations/foreign/messages')).status,
        404,
      );
      assert.equal(
        (await request('/api/auth/session/logout', 'POST')).status,
        200,
      );
      assert.equal((await request('/api/auth/me')).status, 401);
      const preview = await request(
        '/api/client-auth/invite?token=' + encodeURIComponent(token),
      );
      assert.equal(preview.status, 200);
      assert.equal((await preview.json()).invite.isValid, true);
      assert.equal(
        (
          await request(
            '/api/client-auth/invite?token=' + encodeURIComponent(token),
            'GET',
            undefined,
            'beta.agency.example',
          )
        ).status,
        401,
      );
      const accepted = await request('/api/client-auth/accept-invite', 'POST', {
        token,
        password,
        name: 'Fixture Client',
      });
      assert.equal(accepted.status, 200, await accepted.clone().text());
      assert.equal(accepted.headers.getSetCookie().length, 2);
      assert.equal((await request('/api/client-auth/me')).status, 200);
      assert.equal((await request('/api/auth/me')).status, 401);
      assert.equal(
        (
          await request('/api/client-auth/accept-invite', 'POST', {
            token,
            password,
          })
        ).status,
        401,
      );
      const overview = await request('/api/client/overview');
      assert.equal(overview.status, 200, await overview.clone().text());
      assert.equal((await overview.json()).overview.tenantClientId, 'client-a');
      const conversations = await request('/api/client/conversations');
      assert.equal(conversations.status, 200);
      const list = await conversations.text();
      assert.match(list, /own/);
      assert.doesNotMatch(list, /sibling|foreign/);
      const own = await request('/api/client/conversations/own/messages');
      assert.equal(own.status, 200);
      assert.match(await own.text(), /Fixture own message/);
      for (const id of ['sibling', 'foreign'])
        assert.equal(
          (await request(`/api/client/conversations/${id}/messages`)).status,
          404,
        );
      assert.equal(
        (
          await request(
            '/api/client-auth/me',
            'GET',
            undefined,
            'beta.agency.example',
          )
        ).status,
        401,
      );
      assert.equal(
        (await request('/api/client-auth/logout', 'POST')).status,
        200,
      );
      assert.equal((await request('/api/client-auth/me')).status, 401);
      const relogin = await request('/api/auth/session/login', 'POST', {
        email: 'client@example.test',
        password,
      });
      assert.equal(relogin.status, 200, await relogin.clone().text());
      assert.equal((await relogin.json()).audience, 'client');
      assert.equal((await request('/api/client-auth/me')).status, 200);
      assert.equal(
        (await request('/api/auth/session/logout', 'POST')).status,
        200,
      );
      assert.equal((await request('/api/client-auth/me')).status, 401);
    } finally {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) {
          const exit = once(child, 'exit');
          child.kill('SIGTERM');
          await Promise.race([
            exit,
            delay(5000, undefined, { ref: false }).then(() => {
              child.kill('SIGKILL');
              return exit;
            }),
          ]);
        }
      await pool.end();
      try {
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await admin.end();
      }
    }
  },
);
