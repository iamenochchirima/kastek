import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { readConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import { registerProfileRoutes } from '../src/routes/profile.js';
import { sha256 } from '../src/identity/session.js';
import { installPgTimestampParsers } from '../src/db.js';

test('profile updates preserve omitted-field clearing, UTC timestamps and password privacy',
  { skip: !process.env.CORE_PROFILE_TEST_DATABASE_URL }, async () => {
    process.env.TZ = 'UTC';
    installPgTimestampParsers();
    const databaseUrl = process.env.CORE_PROFILE_TEST_DATABASE_URL!;
    const schema = `profile_test_${randomUUID().replaceAll('-', '')}`;
    const admin = new pg.Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE SCHEMA "${schema}"`);
    const pool = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema} -c timezone=UTC` });
    const config = readConfig({ DATABASE_URL: databaseUrl, LOG_LEVEL: 'silent' });
    const app = await buildApp({ pool, config }, [registerProfileRoutes]);
    try {
      await pool.query(`CREATE TABLE "User"(id text PRIMARY KEY, name text, email text, phone text, image text,
        password text, "emailVerified" timestamp, "createdAt" timestamp, "updatedAt" timestamp);
        CREATE TABLE "Session"("userId" text, "sessionToken" text PRIMARY KEY, "refreshToken" text,
          expires timestamp, "lastActivityAt" timestamp, "identityCheckedAt" timestamp, "providerRefreshedAt" timestamp)`);
      await pool.query(`INSERT INTO "User" VALUES ('user', 'Before', 'profile@example.test', '123', 'https://image.test',
        'synthetic secret hash', NOW(), '2026-01-01 12:00:00', NOW())`);
      await pool.query(`INSERT INTO "Session" VALUES ('user',$1,'unused',NOW()+INTERVAL '1 day',NOW(),NOW(),NOW())`, [sha256('synthetic-cookie')]);
      const headers = { cookie: 'kasitek_session=synthetic-cookie', origin: config.frontendUrl };
      const before = await app.inject({ method: 'GET', url: '/api/profile', headers });
      assert.equal(before.statusCode, 200);
      assert.equal(before.json().hasPassword, true);
      assert.equal(before.json().user.createdAt, '2026-01-01T12:00:00Z');
      assert.ok(!before.body.includes('synthetic secret hash'));
      const changed = await app.inject({ method: 'PATCH', url: '/api/profile', headers, payload: { name: ' After ' } });
      assert.equal(changed.statusCode, 200);
      assert.equal(changed.json().user.name, 'After');
      assert.equal(changed.json().user.phone, null);
      assert.equal(changed.json().user.image, null);
      assert.ok(!changed.body.includes('password'));
      const invalid = await app.inject({ method: 'PATCH', url: '/api/profile', headers, payload: { image: 'javascript:alert(1)' } });
      assert.equal(invalid.statusCode, 400);
      assert.equal(invalid.json().code, 'bad_request');
      const denied = await app.inject({ method: 'POST', url: '/api/onboarding/phone', headers: { ...headers, origin: 'https://wrong.test' }, payload: { phone: '456' } });
      assert.equal(denied.statusCode, 403);
    } finally {
      await app.close();
      await pool.end();
      await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
      await admin.end();
    }
  });
