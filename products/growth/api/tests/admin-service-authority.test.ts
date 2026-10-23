import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {buildApp} from '../src/app.js';
import {readConfig} from '../src/config.js';
import {extractAdmin} from '../src/identity/admin-session.js';
import {createAdminAuthority,ADMIN_AUTHORITY_HEADER} from '@kasitek-labs/server-support/admin-authority';
import type {CoreContext} from '../src/context.js';

test('Labs signed human requests bind exact bodies, current roles, origins and one-use mutation nonces', {skip:!process.env.ADMIN_SERVICE_TEST_DATABASE_URL}, async()=>{
 const databaseUrl=process.env.ADMIN_SERVICE_TEST_DATABASE_URL!,schema=`admin_service_${randomUUID().replaceAll('-','')}`;
 const base=new pg.Pool({connectionString:databaseUrl});await base.query(`CREATE SCHEMA "${schema}"`);
 const pool=new pg.Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`});
 const secret='isolated-test-secret-at-least-32-bytes';
 await pool.query(`CREATE TABLE "AdminUser" (id text primary key,name text,email text,password text,role text,"createdAt" timestamptz,"updatedAt" timestamptz);CREATE TABLE "AdminServiceAssertionNonce"(nonce text primary key,"expiresAt" timestamptz);INSERT INTO "AdminUser" VALUES('admin','Admin','fixture@example.test','unused','owner',now(),now())`);
 const context={pool,config:readConfig({DATABASE_URL:databaseUrl,LOG_LEVEL:'silent',ADMIN_FRONTEND_URL:'http://localhost:3001',KASITEK_ADMIN_SERVICE_SECRET:secret})} as CoreContext;
 const app=await buildApp(context,[(app,core)=>{
  app.get('/api/admin/fixture',async request=>({role:(await extractAdmin(request,core)).role}));
  app.post('/api/admin/fixture',async request=>({role:(await extractAdmin(request,core)).role}));
 }]);
 const sign=(method='POST',body='{"enabled":true}',role='operator',id='admin')=>createAdminAuthority({secret,audience:'growth',actor:{id,role},method,path:'/api/admin/fixture',body});
 const send=(token:string,body='{"enabled":true}',origin='http://localhost:3001')=>app.inject({method:'POST',url:'/api/admin/fixture',headers:{[ADMIN_AUTHORITY_HEADER]:token,origin,'content-type':'application/json'},payload:body});
 try{
  const token=sign();const success=await send(token);assert.equal(success.statusCode,200,success.body);assert.equal(success.json().role,'operator');
  assert.equal((await send(token)).statusCode,401);
  assert.equal((await send(sign(),'{"enabled":false}')).statusCode,401);
  assert.equal((await send(sign(),'{"enabled":true}','https://attacker.test')).statusCode,403);
  assert.equal((await send(sign('POST','{"enabled":true}','operator','unknown'))).statusCode,401);
  const viewer=sign('GET','','viewer');assert.equal((await app.inject({url:'/api/admin/fixture',headers:{[ADMIN_AUTHORITY_HEADER]:viewer}})).statusCode,200);
  const insufficient=createAdminAuthority({secret,audience:'growth',actor:{id:'admin',role:'viewer'},method:'POST',path:'/api/admin/fixture',body:'{"enabled":true}',capability:'admin:read'});
  assert.equal((await send(insufficient)).statusCode,401);
  assert.equal((await app.inject({url:'/api/admin/fixture',headers:{[ADMIN_AUTHORITY_HEADER]:'invalid',cookie:'kasitek_admin_session=admin'}})).statusCode,401);
 }finally{await app.close();await pool.end();await base.query(`DROP SCHEMA "${schema}" CASCADE`);await base.end();}
});
