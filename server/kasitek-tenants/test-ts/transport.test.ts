import test from 'node:test';
import assert from 'node:assert/strict';
import type pg from 'pg';
import {buildApp,originMatchesPlatformDomain} from '../src-ts/app.js';
import {readConfig} from '../src-ts/config.js';
import {forbidden,RequestExtractionError} from '../src-ts/error.js';
const config=readConfig({TENANT_DATABASE_URL:'postgres://unused',TENANT_SERVER_ENVIRONMENT:'production',TENANT_ALLOWED_ORIGINS:'https://portal.example',TENANT_PLATFORM_BASE_DOMAIN:'agency.example',LOG_LEVEL:'silent'});
test('native Agency HTTP keeps health, explicit errors, source CORS and method misses',async()=>{
 const app=await buildApp({config,pool:{} as pg.Pool},[(app)=>{
  app.post('/api/fixture',async()=>{throw forbidden();});
  app.post('/api/schema',{
   schema:{body:{type:'object',required:['name'],properties:{name:{type:'string'}},additionalProperties:false}},
  },async()=>({ok:true}));
  app.delete('/api/bodyless',async()=>({deleted:true}));
  app.post('/api/auth/logout',async()=>({loggedOut:true}));
  app.post('/api/extractor',async()=>{throw new RequestExtractionError('json');});
  app.get('/api/count',async()=>({count:9223372036854775807n}));
 }]);
 try {
  const health=await app.inject('/health');assert.equal(health.statusCode,200);assert.equal(health.json().service,'tenant-server');assert.ok(health.headers['x-correlation-id']);
  const error=await app.inject({method:'POST',url:'/api/fixture',payload:{}});assert.equal(error.statusCode,403);assert.deepEqual(error.json(),{error:'forbidden'});
  for(const [payload,detail] of [['{}','missing field `name`'],['{"name":false}','invalid type: a boolean, expected a string at `body.name`']] as const){
   const invalid=await app.inject({method:'POST',url:'/api/schema',payload,headers:{'content-type':'application/json'}});
   assert.equal(invalid.statusCode,400);assert.equal(invalid.body,`Json deserialize error: ${detail}`);assert.match(invalid.headers['content-type']!,/^text\/plain/);
   assert.doesNotMatch(invalid.body,/false/);
  }
  const extractor=await app.inject({method:'POST',url:'/api/extractor',payload:{}});assert.equal(extractor.statusCode,400);assert.match(extractor.headers['content-type']!,/^text\/plain/);
  for(const [payload,detail] of [['{','EOF while parsing an object at line 1 column 1'],['[1,]','trailing comma at line 1 column 4']] as const){
   const malformed=await app.inject({method:'POST',url:'/api/fixture',payload,headers:{'content-type':'application/json'}});
   assert.equal(malformed.statusCode,400);assert.equal(malformed.body,`Json deserialize error: ${detail}`);
  }
  for(const [method,path] of [['DELETE','/api/bodyless'],['POST','/api/auth/logout']] as const){
   for(const [contentType,payload] of [['application/json','{'],['text/csv','ignored'],['application/json','x'.repeat(2097153)]]){
    const result=await app.inject({method,url:path,payload,headers:{'content-type':contentType!}});assert.equal(result.statusCode,200);
   }
  }
  assert.equal((await app.inject('/api/count')).body,'{"count":9223372036854775807}');
  for(const method of ['POST','HEAD'] as const){const unknown=await app.inject({method,url:'/health',payload:method==='POST'?'broken':undefined});assert.equal(unknown.statusCode,404);assert.equal(unknown.body,'');}
  const allowed=await app.inject({method:'OPTIONS',url:'/api/fixture',headers:{origin:'https://partner.agency.example','access-control-request-method':'POST','access-control-request-headers':'x-admin-secret'}});assert.equal(allowed.statusCode,204);assert.equal(allowed.headers['access-control-allow-origin'],'https://partner.agency.example');assert.equal(allowed.headers['access-control-allow-credentials'],'true');
  const denied=await app.inject({url:'/health',headers:{origin:'https://agency.example.evil'}});assert.equal(denied.headers['access-control-allow-origin'],undefined);
 }finally{await app.close();}
});
test('platform origin matching retains source scheme and host boundaries',()=>{
 assert.equal(originMatchesPlatformDomain('https://A.Agency.Example:443/path','..agency.example..'),true);
 assert.equal(originMatchesPlatformDomain('ftp://agency.example','agency.example'),false);
 assert.equal(originMatchesPlatformDomain('https://notagency.example','agency.example'),false);
});
