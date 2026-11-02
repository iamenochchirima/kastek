import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { hash } from 'bcryptjs';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { extractAdmin } from '../src/identity/admin-session.js';
import { registerAdminAuthRoutes } from '../src/routes/admin-auth.js';

test('real HTTP admin sessions reject fabrication, expiration and revocation and enforce roles/origin', {skip: !process.env.ADMIN_SECURITY_TEST_DATABASE_URL}, async () => {
  const url = process.env.ADMIN_SECURITY_TEST_DATABASE_URL!;
  const schema = `admin_security_${randomUUID().replaceAll('-', '')}`;
  const base = new pg.Pool({connectionString: url});
  await base.query(`CREATE SCHEMA "${schema}"`);
  const pool = new pg.Pool({connectionString: url, options:`-c search_path=${schema}`});
  const context = {pool, config:readConfig({DATABASE_URL:url, LOG_LEVEL:'silent',ADMIN_FRONTEND_URL:'http://localhost:3001'})};
  await pool.query('CREATE TABLE "AdminUser" (id TEXT PRIMARY KEY, name TEXT,email TEXT,password TEXT,role TEXT,"createdAt" TIMESTAMP DEFAULT NOW(),"updatedAt" TIMESTAMP DEFAULT NOW())');
  await pool.query(readFileSync(new URL('../../database/prisma/migrations/20261023030000_admin_sessions/migration.sql',import.meta.url),'utf8'));
  const password = await hash('test-password',4);
  for (const role of ['viewer','operator','owner']) await pool.query('INSERT INTO "AdminUser" (id,name,email,password,role) VALUES ($1,$1,$2,$3,$1)',[role,`${role}@example.test`,password]);
  const app = await buildApp(context,[registerAdminAuthRoutes,(app,core)=>{
    app.get('/api/admin/security-fixture', async request=>({id:(await extractAdmin(request,core)).id}));
    app.post('/api/admin/security-fixture', async request=>({id:(await extractAdmin(request,core)).id}));
  }]);
  const origin = 'http://localhost:3001';
  const login = async (role:string) => {
    const res = await app.inject({method:'POST',url:'/api/admin/login',headers:{origin},payload:{email:`${role}@example.test`,password:'test-password'}});
    assert.equal(res.statusCode,200,res.body);
    return String(res.headers['set-cookie']).split(';')[0]!;
  };
  try {
    assert.equal((await app.inject({url:'/api/admin/security-fixture'})).statusCode,401);
    assert.equal((await app.inject({url:'/api/admin/security-fixture',headers:{cookie:'kasitek_admin_session=owner'}})).statusCode,401);
    const viewer=await login('viewer');
    assert.equal((await app.inject({url:'/api/admin/security-fixture',headers:{cookie:viewer}})).statusCode,200);
    assert.equal((await app.inject({method:'POST',url:'/api/admin/security-fixture',headers:{cookie:viewer,origin}})).statusCode,403);
    const cookie=await login('operator');
    const token=cookie.split('=')[1]!;
    assert.equal(token.length,43);
    const stored=(await pool.query('SELECT "tokenHash" FROM "AdminSession" WHERE "adminId"=\'operator\'')).rows[0].tokenHash;
    assert.notEqual(stored,token);assert.equal(stored,createHash('sha256').update(token).digest('hex'));
    assert.equal((await app.inject({method:'POST',url:'/api/admin/security-fixture',headers:{cookie,origin}})).statusCode,200);
    assert.equal((await app.inject({method:'POST',url:'/api/admin/security-fixture',headers:{cookie,origin:'https://attacker.test'}})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:'/api/admin/security-fixture',headers:{cookie}})).statusCode,403);
    const owner=await login('owner');
    assert.equal((await app.inject({method:'POST',url:'/api/admin/security-fixture',headers:{cookie:owner,origin}})).statusCode,200);
    await pool.query('UPDATE "AdminSession" SET "expiresAt"=NOW()-INTERVAL \'1 second\' WHERE "adminId"=\'viewer\'');
    assert.equal((await app.inject({url:'/api/admin/security-fixture',headers:{cookie:viewer}})).statusCode,401);
    assert.equal((await app.inject({method:'POST',url:'/api/admin/logout',headers:{cookie,origin}})).statusCode,200);
    assert.equal((await app.inject({url:'/api/admin/security-fixture',headers:{cookie}})).statusCode,401);
  } finally {await app.close();await pool.end();await base.query(`DROP SCHEMA "${schema}" CASCADE`);await base.end();}
});
