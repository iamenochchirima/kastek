import assert from 'node:assert/strict';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parse } from 'dotenv';
import { Pool } from 'pg';
import Fastify from 'fastify';
import { registerOperationsAuth, encryptRefresh } from '../src/auth.js';
import { provisionAdmin } from '../src/provision-admin.js';
import { migrate } from '../src/migrate-main.js';
test('PostgreSQL grants, automatic revision revocation, opaque sessions and grant audit', { skip: !process.env.OPERATIONS_TEST_ENV_FILE }, async () => {
    const env = parse(await readFile(process.env.OPERATIONS_TEST_ENV_FILE!));
    assert(new URL(env.DATABASE_URL!).pathname.endsWith('identity_test_dev'), 'Use dedicated identity test database');
    await migrate(env.DATABASE_URL!);
    const pool = new Pool({ connectionString: env.DATABASE_URL }), app = Fastify(), key = randomBytes(32), id = 'identity-test-' + randomUUID(), issuer = 'http://localhost:8080/realms/kasitek';
    await registerOperationsAuth(app, pool, { OPS_OIDC_ISSUER: issuer, OPS_OIDC_CLIENT_SECRET: 'unneeded-fixture', OPS_SESSION_ENCRYPTION_KEY: key.toString('hex'), ENVIRONMENT: 'test' });
    const grant = { adminId: id, issuer, subject: id + '-subject', role: 'operator', name: 'Test Operator', email: '', operatorId: 'test-bootstrap', reason: 'Controlled isolated identity verification', environment: 'test', active: true };
    async function insertSession() {
        const token = randomBytes(32).toString('base64url');
        await pool.query(`INSERT INTO operations.admin_sessions(token_hash,admin_id,principal_revision,refresh_token,expires_at,refresh_after)
    SELECT $1,admin_id,revision,$3,now()+interval '1 hour',now()+interval '1 minute' FROM operations.admin_principals WHERE admin_id=$2`, [createHash('sha256').update(token).digest('hex'), id, encryptRefresh('fixture-refresh', key)]);
        return 'labs_admin_session=' + token;
    }
    try {
        await provisionAdmin(pool, grant);
        const cookie = await insertSession();
        let response = await app.inject({ url: '/auth/session', headers: { cookie } });
        assert.equal(response.statusCode, 200);
        assert.equal(response.json().admin.id, id);
        await pool.query("UPDATE operations.admin_principals SET role='viewer' WHERE admin_id=$1", [id]);
        assert.equal((await app.inject({ url: '/auth/session', headers: { cookie } })).statusCode, 401, 'direct role change automatically increments revision');
        assert.equal((await pool.query('SELECT revision FROM operations.admin_principals WHERE admin_id=$1', [id])).rows[0].revision, 2);
        const nextCookie = await insertSession();
        assert.equal((await app.inject({ url: '/auth/session', headers: { cookie: nextCookie } })).statusCode, 200);
        await provisionAdmin(pool, { ...grant, active: false });
        assert.equal((await app.inject({ url: '/auth/session', headers: { cookie: nextCookie } })).statusCode, 401);
        assert.equal((await pool.query('SELECT count(*)::int AS total FROM operations.principal_changes WHERE admin_id=$1', [id])).rows[0].total, 2);
        assert.equal((await pool.query("SELECT count(*)::int AS total FROM ops_audit WHERE resource_type='admin_principal' AND resource_id=$1", [id])).rows[0].total, 2);
        await assert.rejects(() => provisionAdmin(pool, { ...grant, subject: 'other-subject' }), /cannot be reassigned/);
        await assert.rejects(() => provisionAdmin(pool, { ...grant, adminId: id + '-other' }), /duplicate key/, 'one subject cannot silently become another stable admin');
    }
    finally {
        await pool.query('DELETE FROM operations.admin_sessions WHERE admin_id=$1', [id]);
        await pool.query('DELETE FROM operations.principal_changes WHERE admin_id=$1', [id]);
        await pool.query('DELETE FROM operations.admin_principals WHERE admin_id=$1', [id]);
        await pool.query('DELETE FROM ops_audit WHERE resource_id=$1', [id]);
        await app.close();
        await pool.end();
    }
});
