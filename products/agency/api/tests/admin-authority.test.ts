import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { createAdminAuthority, ADMIN_AUTHORITY_HEADER } from '@kasitek-labs/server-support/admin-authority';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { registerAdminRoutes } from '../src/controllers/admin.js';
import { verifiedAdminActors } from '../src/admin-authority.js';

test('Agency HTTP requires service and actor authority, rejects viewer writes, tampering and replay', {skip:!process.env.ADMIN_SECURITY_TEST_DATABASE_URL},async()=>{
 const url=process.env.ADMIN_SECURITY_TEST_DATABASE_URL!;
 const schema=`agency_admin_${randomUUID().replaceAll('-','')}`;
 const base=new pg.Pool({connectionString:url}); await base.query(`CREATE SCHEMA "${schema}"`);
 const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
 const secret='synthetic-service-secret-at-least-32-bytes';
 const context={pool,config:readConfig({TENANT_DATABASE_URL:url,KASITEK_ADMIN_SERVICE_SECRET:secret,LOG_LEVEL:'silent'})};
 await pool.query('CREATE TABLE workspaces (id TEXT PRIMARY KEY,slug TEXT,display_name TEXT,status TEXT,created_at TIMESTAMPTZ DEFAULT NOW(),updated_at TIMESTAMPTZ); CREATE TABLE tenant_clients (id TEXT,workspace_id TEXT); CREATE TABLE workspace_domains (id TEXT, workspace_id TEXT,domain TEXT,is_primary BOOLEAN,dns_status TEXT,verified_at TIMESTAMPTZ,created_at TIMESTAMPTZ);');
 await pool.query(readFileSync(new URL('../migrations/20261023030000_admin_authority_nonces.sql',import.meta.url),'utf8'));
 await pool.query("INSERT INTO workspaces (id,slug,display_name,status) VALUES ('test','test','Test','active')");
 const app=await buildApp(context,[registerAdminRoutes]);
 let lastActor='';app.addHook('onResponse',async r=>{lastActor=verifiedAdminActors.get(r)?.id??'';});
 const path='/api/admin/workspaces/test'; const body='{"status":"paused"}';
 const sign=(role:string,method:string,path:string,body='',capability?:'admin:read')=>createAdminAuthority({secret,audience:'agency',actor:{id:`${role}-admin`,role},method,path,body,...(capability?{capability}:{})});
 try{
  assert.equal((await app.inject({url:path,headers:{'x-admin-secret':secret}})).statusCode,403);
  assert.equal((await app.inject({url:path,headers:{[ADMIN_AUTHORITY_HEADER]:sign('viewer','GET',path)}})).statusCode,200);
  assert.equal(lastActor,'viewer-admin');
  assert.equal((await app.inject({method:'PATCH',url:path,payload:body,headers:{'content-type':'application/json',[ADMIN_AUTHORITY_HEADER]:sign('viewer','PATCH',path,body,'admin:read')}})).statusCode,403);
  const token=sign('operator','PATCH',path,body);
  const request={method:'PATCH' as const,url:path,payload:body,headers:{'content-type':'application/json',[ADMIN_AUTHORITY_HEADER]:token}};
  assert.equal((await app.inject(request)).statusCode,200);assert.equal(lastActor,'operator-admin');
  assert.equal((await app.inject(request)).statusCode,403);
  assert.equal((await app.inject({...request,payload:'{"status":"active"}',headers:{...request.headers,[ADMIN_AUTHORITY_HEADER]:sign('operator','PATCH',path,body)}})).statusCode,403);
  const ownerToken=sign('owner','PATCH',path,body);assert.equal((await app.inject({...request,headers:{...request.headers,[ADMIN_AUTHORITY_HEADER]:ownerToken}})).statusCode,200);
 }finally{await app.close();await pool.end();await base.query(`DROP SCHEMA "${schema}" CASCADE`);await base.end();}
});
