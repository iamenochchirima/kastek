import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import pg from 'pg';
import { hash, getRounds } from 'bcryptjs';
import { buildApp } from '../src-ts/app.js';
import { readConfig } from '../src-ts/config.js';
import { registerAdminAuthRoutes } from '../src-ts/routes/admin-auth.js';
import { adminCookieOptions } from '../src-ts/identity/admin-session.js';
import type { CoreContext } from '../src-ts/context.js';

test('administrator cookie preserves current production policy and optional domain', () => {
  const context = { config: readConfig({ DATABASE_URL: 'postgres://unused' }) } as CoreContext;
  assert.deepEqual(adminCookieOptions(context), { path: '/', httpOnly: true, secure: false, sameSite: 'lax' });
  context.config.environment = 'Production'; context.config.env.COOKIE_DOMAIN = '.example.test';
  assert.deepEqual(adminCookieOptions(context), { path: '/', httpOnly: true, secure: true, sameSite: 'none', domain: '.example.test' });
});

test('isolated administrator login, profile, password reset delivery/expiry/replay and password change', { skip: !process.env.CORE_ADMIN_AUTH_TEST_DATABASE_URL }, async () => {
  const url = process.env.CORE_ADMIN_AUTH_TEST_DATABASE_URL!;
  const schema = `admin_auth_test_${randomUUID().replaceAll('-', '')}`;
  const adminPool = new pg.Pool({ connectionString: url });
  await adminPool.query(`CREATE SCHEMA "${schema}"`);
  const pool = new pg.Pool({ connectionString: url, options: `-c search_path=${schema} -c timezone=UTC` });
  const messages: Record<string, unknown>[] = [];
  let mailStatus = 200;
  const sink = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => { messages.push(JSON.parse(Buffer.concat(chunks).toString())); response.writeHead(mailStatus, { 'content-type': 'application/json' }); response.end('{}'); });
  });
  await new Promise<void>(resolve => sink.listen(0, '127.0.0.1', resolve));
  const address = sink.address(); assert.ok(address && typeof address === 'object');
  const context = { pool, config: readConfig({ DATABASE_URL: url, LOG_LEVEL: 'silent', LOCAL_MAILPIT_URL: `http://127.0.0.1:${address.port}` }) };
  const app = await buildApp(context, [registerAdminAuthRoutes]);
  const post = (url: string, payload: Record<string, unknown>, cookie?: string) => app.inject({ method: 'POST', url, payload, headers: cookie ? { cookie } : {} });
  try {
    await pool.query(`CREATE TABLE "AdminUser" (id text PRIMARY KEY,name text,email text,password text,role text,"createdAt" timestamp,"updatedAt" timestamp);
      CREATE TABLE "VerificationToken" (identifier text,token text UNIQUE,expires timestamp,UNIQUE(identifier,token));`);
    const initial = await hash('first-password', 4);
    await pool.query('INSERT INTO "AdminUser" (id,name,email,password,role,"createdAt","updatedAt") VALUES (\'synthetic-admin\',\'Synthetic Administrator\',\'admin@example.test\',$1,\'support\',NOW(),NOW())', [initial]);
    const wrong = await post('/api/admin/login', { email: 'admin@example.test', password: 'wrong' });
    assert.equal(wrong.statusCode, 401); assert.equal(wrong.json().code, 'unauthorized');
    const login = await post('/api/admin/login', { email: ' ADMIN@EXAMPLE.TEST ', password: ' first-password ' });
    assert.equal(login.statusCode, 200); assert.deepEqual(login.json(), { id: 'synthetic-admin', name: 'Synthetic Administrator', email: 'admin@example.test', role: 'support' });
    const setCookie = String(login.headers['set-cookie']); assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Lax/); assert.doesNotMatch(setCookie, /password/i);
    const cookie = setCookie.split(';')[0]!;
    const me = await app.inject({ method: 'GET', url: '/api/admin/me', headers: { cookie } }); assert.equal(me.statusCode, 200); assert.equal(me.json().role, 'support'); assert.equal(me.json().password, undefined);
    const missing = await post('/api/admin/forgot-password', { email: '  ' }); assert.equal(missing.statusCode, 400); assert.equal(missing.json().error, 'Email is required');
    const unknown = await post('/api/admin/forgot-password', { email: 'unknown@example.test' }); assert.equal(unknown.statusCode, 200); assert.equal(messages.length, 0);
    const invalid = await post('/api/admin/forgot-password', { email: true }); assert.equal(invalid.statusCode, 400);
    const forgot = await post('/api/admin/forgot-password', { email: ' ADMIN@EXAMPLE.TEST ' }); assert.equal(forgot.statusCode, 200); assert.deepEqual(forgot.json(), unknown.json());
    assert.equal(messages.length, 1); assert.equal(messages[0]!.Subject, 'Reset your KasiTek admin password');
    const resetUrl = new URL(String(messages[0]!.Text).split(': ').slice(1).join(': '));
    let token = resetUrl.searchParams.get('token')!; assert.equal(token.length, 48); assert.equal(resetUrl.searchParams.get('email'), 'admin@example.test');
    const lifetime = (await pool.query('SELECT EXTRACT(EPOCH FROM expires-NOW()) AS seconds FROM "VerificationToken"')).rows[0]; assert.ok(Number(lifetime.seconds) > 86390 && Number(lifetime.seconds) <= 86400);
    assert.equal((await post('/api/admin/reset-password', { email: 'other@example.test', token, password: 'second-password' })).statusCode, 400);
    assert.equal((await post('/api/admin/reset-password', { email: 'admin@example.test', token, password: 'short' })).json().error, 'Password must be at least 8 characters');
    assert.equal((await pool.query('SELECT COUNT(*) FROM "VerificationToken"')).rows[0].count, '1');
    await post('/api/admin/forgot-password', { email: 'admin@example.test' });
    assert.equal((await pool.query('SELECT COUNT(*) FROM "VerificationToken"')).rows[0].count, '1');
    assert.equal((await post('/api/admin/reset-password', { email: 'admin@example.test', token, password: 'second-password' })).statusCode, 400);
    token = new URL(String(messages.at(-1)!.Text).split(': ').slice(1).join(': ')).searchParams.get('token')!;
    const concurrent = await Promise.all([post('/api/admin/reset-password', { email: 'admin@example.test', token, password: ' second-password ' }), post('/api/admin/reset-password', { email: 'admin@example.test', token, password: ' second-password ' })]);
    assert.deepEqual(concurrent.map(r => r.statusCode).sort(), [200, 400]);
    assert.equal((await post('/api/admin/login', { email: 'admin@example.test', password: 'second-password' })).statusCode, 200);
    assert.equal(getRounds((await pool.query('SELECT password FROM "AdminUser"')).rows[0].password), 12);
    const changed = await app.inject({ method: 'PATCH', url: '/api/admin/password', payload: { currentPassword: ' second-password ', nextPassword: 'third-password' }, headers: { cookie } }); assert.equal(changed.statusCode, 400); assert.equal(changed.json().error, 'Current password is incorrect');
    const good = await app.inject({ method: 'PATCH', url: '/api/admin/password', payload: { currentPassword: 'second-password', nextPassword: ' third-password ' }, headers: { cookie } }); assert.equal(good.statusCode, 200); assert.equal(good.json().message, 'Password updated.');
    // Current change-password path preserves spaces, while login intentionally trims them.
    assert.equal((await post('/api/admin/login', { email: 'admin@example.test', password: ' third-password ' })).statusCode, 401);
    await post('/api/admin/forgot-password', { email: 'admin@example.test' });
    token = (await pool.query('SELECT token FROM "VerificationToken"')).rows[0].token;
    await pool.query('UPDATE "VerificationToken" SET expires=NOW()-INTERVAL \'1 minute\'');
    assert.equal((await post('/api/admin/reset-password', { email: 'admin@example.test', token, password: 'fourth-password' })).statusCode, 400);
    mailStatus = 503; assert.equal((await post('/api/admin/forgot-password', { email: 'admin@example.test' })).statusCode, 503);
    assert.equal((await pool.query('SELECT COUNT(*) FROM "VerificationToken"')).rows[0].count, '1');
    await pool.query('UPDATE "AdminUser" SET role=\'unknown\'');
    assert.equal((await app.inject({ method: 'GET', url: '/api/admin/me', headers: { cookie } })).statusCode, 403);
    const logout = await post('/api/admin/logout', {}); assert.equal(logout.statusCode, 200); assert.equal(logout.json().message, 'Logged out'); assert.match(String(logout.headers['set-cookie']), /Expires=/);
  } finally {
    await app.close(); await pool.end(); await new Promise<void>((resolve, reject) => sink.close(error => error ? reject(error) : resolve()));
    await adminPool.query(`DROP SCHEMA "${schema}" CASCADE`); await adminPool.end();
  }
});
