import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type {AnalyticsContext} from '../src/context.js';
import {registerOperationsSource} from '../src/operations-source.js';
import {createOperationsServiceAuthority,OPERATIONS_AUTHORITY_HEADER} from '@kasitek-labs/server-support/operations-authority';
test('analytics fixed source observer verifies exact authority and cannot become an admin actor',async()=>{
 const original=process.env.OPS_OBSERVER_SECRET;process.env.OPS_OBSERVER_SECRET='x'.repeat(64);const env=process.env.OPS_ENVIRONMENT??'development';let reads=0;
 const db={async query(sql:string){reads++;if(sql.startsWith('SELECT'))return {rows:[{value:'0'}]};return {rows:[]};},release(){}};
 const app=Fastify();registerOperationsSource(app,{pool:{connect:async()=>db},config:{admin_reporting_secret:'human-secret'.repeat(4)}} as unknown as AnalyticsContext);await app.ready();
 try{assert.equal((await app.inject({url:'/internal/operations/signals'})).statusCode,403);assert.equal(reads,0);const token=createOperationsServiceAuthority({secret:'x'.repeat(64),audience:'analytics',scope:'signals:read',method:'GET',path:'/internal/operations/signals',environment:env});
 assert.equal((await app.inject({url:'/internal/operations/signals',headers:{[OPERATIONS_AUTHORITY_HEADER]:token}})).statusCode,200);assert.equal((await app.inject({url:'/api/admin/operations/audit',headers:{[OPERATIONS_AUTHORITY_HEADER]:token}})).statusCode,403);
 }finally{await app.close();if(original===undefined)delete process.env.OPS_OBSERVER_SECRET;else process.env.OPS_OBSERVER_SECRET=original;}
});
