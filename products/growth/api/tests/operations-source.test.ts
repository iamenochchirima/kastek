import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type {Pool} from 'pg';
import {registerOperationsSource} from '../src/routes/operations-source.js';
import {createOperationsServiceAuthority,OPERATIONS_AUTHORITY_HEADER} from '@kasitek-labs/server-support/operations-authority';
test('observer route validates fixed source/environment/path before observing and exposes no customer authority',async()=>{
 let reads=0;const db={async query(sql:string){reads++;if(sql.startsWith('SELECT'))return {rows:[{value:'0'}]};return {rows:[]};},release(){}};
 const app=Fastify();registerOperationsSource(app,{connect:async()=>db} as unknown as Pool,{OPS_OBSERVER_SECRET:'x'.repeat(64),OPS_ENVIRONMENT:'development'});await app.ready();
 try{assert.equal((await app.inject({url:'/internal/operations/signals'})).statusCode,403);assert.equal(reads,0);
 const token=createOperationsServiceAuthority({secret:'x'.repeat(64),audience:'growth',scope:'signals:read',method:'GET',path:'/internal/operations/signals',environment:'development'});
 const response=await app.inject({url:'/internal/operations/signals',headers:{[OPERATIONS_AUTHORITY_HEADER]:token}});assert.equal(response.statusCode,200);assert.equal(response.json().source,'growth');assert(reads>0);assert.equal((await app.inject({url:'/internal/operations/signals?extra=1',headers:{[OPERATIONS_AUTHORITY_HEADER]:token}})).statusCode,403);
 assert.equal((await app.inject({url:'/api/admin/customers/customer',headers:{[OPERATIONS_AUTHORITY_HEADER]:token}})).statusCode,404);
 }finally{await app.close();}
});
