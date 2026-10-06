import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import type pg from 'pg';
import {buildApp} from '../src/app.js';
import {routes} from '../src/routes.js';
import {readConfig} from '../src/config.js';

test('native Tenant API registers every source route and method without placeholders',async()=>{
 const snapshot=JSON.parse(await readFile(new URL('./fixtures/routes.json',import.meta.url),'utf8')) as {sourceCommit:string;sourcePath:string;sourceSha256:string;routeCount:number;routes:string[]};
 assert.match(snapshot.sourceCommit,/^[a-f0-9]{40}$/);
 assert.equal(snapshot.sourcePath,'server/kasitek-tenants/src/routes.rs');
 assert.match(snapshot.sourceSha256,/^[a-f0-9]{64}$/);
 assert.equal(snapshot.routeCount,81);
 assert.equal(snapshot.routes.length,snapshot.routeCount);
 const expected=new Set(snapshot.routes);
 const actual=new Set<string>();
 const config=readConfig({TENANT_DATABASE_URL:'postgres://unused',LOG_LEVEL:'silent'});
 const app=await buildApp({config,pool:{} as pg.Pool},[(app)=>{
  app.addHook('onRoute',route=>{for(const method of Array.isArray(route.method)?route.method:[route.method])if(method!=='OPTIONS')actual.add(`${method} ${route.url}`);});
 },...routes]);
 actual.add('GET /');actual.add('GET /health');
 try{await app.ready();assert.equal(expected.size,81);assert.deepEqual([...actual].sort(),[...expected].sort());}
 finally{await app.close();}
});
