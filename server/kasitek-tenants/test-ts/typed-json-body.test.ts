import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { readConfig } from '../src-ts/config.js';
import { buildApp } from '../src-ts/app.js';

test('typed request bodies reject duplicate fields before effects; Value bodies keep last value', async () => {
 let effects=0;
 const app=await buildApp({
  config:readConfig({TENANT_DATABASE_URL:'postgres://unused',TENANT_SERVER_ENVIRONMENT:'test'}),
  pool:{} as Pool,
 },[(server)=>{
  server.post('/typed-json',{schema:{body:{type:'object',properties:{token:{type:'string'}}}}},()=>{effects++;return {ok:true};});
  server.post('/value-json',(request)=>{effects++;return request.body;});
 }]);
 try {
  const duplicate=await app.inject({method:'POST',url:'/typed-json',headers:{'content-type':'application/json'},payload:'{"token":"first","token":"second"}'});
  assert.equal(duplicate.statusCode,400);
  assert.match(duplicate.body,/duplicate field `token`/);
  assert.equal(effects,0);
  const value=await app.inject({method:'POST',url:'/value-json',headers:{'content-type':'application/json'},payload:'{"key":"first","key":"last"}'});
  assert.equal(value.statusCode,200);
  assert.deepEqual(value.json(),{key:'last'});
  assert.equal(effects,1);
 } finally { await app.close(); }
});
