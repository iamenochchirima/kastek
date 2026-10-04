import test from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { readConfig } from '../src-ts/config.js';
import { buildApp } from '../src-ts/app.js';
import { routes } from '../src-ts/routes.js';

test('registered DTO schemas reject duplicate fields before effects; Value bodies keep last value', async () => {
 let effects=0;
 const dtoSchemas=new Map<string,Record<string,unknown>>();
 const collectSchemas=(server:FastifyInstance)=>server.addHook('onRoute',route=>{
  if(route.url==='/typed-json'||route.url==='/value-json')return;
  const schema=route.schema?.body;
  if(!schema||typeof schema!=='object'||Array.isArray(schema))return;
  const methods=Array.isArray(route.method)?route.method:[route.method];
  for(const method of methods)dtoSchemas.set(`${method} ${route.url}`,schema as Record<string,unknown>);
 });
 const app=await buildApp({
  config:readConfig({TENANT_DATABASE_URL:'postgres://unused',TENANT_SERVER_ENVIRONMENT:'test',LOG_LEVEL:'silent'}),
  pool:{} as Pool,
 },[collectSchemas,(server)=>{
  server.post('/typed-json',{schema:{body:{type:'object',properties:{token:{type:'string'}}}}},()=>{effects++;return {ok:true};});
  server.post('/value-json',(request)=>{effects++;return request.body;});
 },...routes]);
 try {
  const duplicate=await app.inject({method:'POST',url:'/typed-json',headers:{'content-type':'application/json'},payload:'{"token":"first","token":"second"}'});
  assert.equal(duplicate.statusCode,400);
  assert.match(duplicate.body,/duplicate field `token`/);
  assert.equal(effects,0);

  const value=await app.inject({method:'POST',url:'/value-json',headers:{'content-type':'application/json'},payload:'{"key":"first","key":"last"}'});
  assert.equal(value.statusCode,200);
  assert.deepEqual(value.json(),{key:'last'});
  assert.equal(effects,1);

  const duplicateReportField=await app.inject({method:'POST',url:'/api/analytics/query',headers:{'content-type':'application/json'},payload:'{"range_start":"first","range_start":"second"}'});
  assert.equal(duplicateReportField.statusCode,400);
  assert.match(duplicateReportField.body,/duplicate field `range_start`/);

  const repeatedFilterMapKey=await app.inject({method:'POST',url:'/api/analytics/query',headers:{'content-type':'application/json'},payload:'{"range_start":"2026-01-01T00:00:00Z","range_end":"2026-02-01T00:00:00Z","timezone":"UTC","filters":{"channel":["first"],"channel":["last"]}}'});
  assert.equal(repeatedFilterMapKey.statusCode,401);

  let checked=0;
  for(const [routeKey,schema] of dtoSchemas){
   const properties=schema.properties&&typeof schema.properties==='object'?schema.properties as Record<string,unknown>:{};
   const field=Object.keys(properties)[0];
   if(!field)continue;
   const [method,...parts]=routeKey.split(' ');
   const path=parts.join(' ').replace(/:[^/]+/g,'fixture');
   const duplicateDto=await app.inject({
    method:method!,url:path,headers:{'content-type':'application/json'},
    payload:`{${JSON.stringify(field)}:"first",${JSON.stringify(field)}:"second"}`,
   });
   assert.equal(duplicateDto.statusCode,400,routeKey);
   assert.ok(duplicateDto.body.includes('duplicate field'),routeKey);
   assert.ok(duplicateDto.body.includes(field),routeKey);
   checked++;
  }
  assert.equal(checked,22);
 } finally {await app.close();}
});
