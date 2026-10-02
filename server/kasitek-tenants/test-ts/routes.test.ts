import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import type pg from 'pg';
import {buildApp} from '../src-ts/app.js';
import {routes} from '../src-ts/routes.js';
import {readConfig} from '../src-ts/config.js';

test('native Tenant API registers every source route and method without placeholders',async()=>{
 const text=await readFile(new URL('../src/routes.rs',import.meta.url),'utf8');
 // The source's web::scope and route calls are flat, non-nested registrations.
 const tokens=[...text.matchAll(/web::scope\("([^\"]*)"\)|\.route\(\s*"([^\"]*)"\s*,\s*web::(get|post|put|patch|delete)\(\)/g)];
 let prefix='';const expected=new Set<string>();
 for(const token of tokens){if(token[1]!==undefined)prefix=token[1];else expected.add(`${token[3]!.toUpperCase()} ${prefix}${token[2]!.replace(/\{([^}]+)\}/g,':$1')}`);}
 // Root/health precede the first scope. Source cfg.route isn't dot-prefixed.
 expected.add('GET /');expected.add('GET /health');
 const actual=new Set<string>();
 const config=readConfig({TENANT_DATABASE_URL:'postgres://unused',LOG_LEVEL:'silent'});
 const app=await buildApp({config,pool:{} as pg.Pool},[(app)=>{
  app.addHook('onRoute',route=>{for(const method of Array.isArray(route.method)?route.method:[route.method])if(method!=='OPTIONS')actual.add(`${method} ${route.url}`);});
 },...routes]);
 actual.add('GET /');actual.add('GET /health');
 try{await app.ready();assert.equal(expected.size,81);assert.deepEqual([...actual].sort(),[...expected].sort());}
 finally{await app.close();}
});
