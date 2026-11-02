import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {readOperationsSource} from '@kasitek-labs/server-support/operations-source';
import {registerOperationsSource,growthWebhookMeasurements} from '../src/routes/operations-source.js';
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

test('outgoing webhook source facts match due claims, exclude future retries and valid leases, and expose safe evidence only',{skip:!process.env.OPERATIONS_TEST_DATABASE_URL},async()=>{
 const parent=new Pool({connectionString:process.env.OPERATIONS_TEST_DATABASE_URL}),schema='source_webhook_'+randomUUID().replaceAll('-','');await parent.query(`CREATE SCHEMA "${schema}"`);
 const pool=new Pool({connectionString:process.env.OPERATIONS_TEST_DATABASE_URL,options:`-c search_path=${schema}`});
 try{
 await pool.query(`CREATE TABLE "PublicApiWebhookSubscription"(id text PRIMARY KEY,"orgId" text,status text);CREATE TABLE "PublicApiWebhookDelivery"(id text PRIMARY KEY,"subscriptionId" text,status text,"nextAttemptAt" timestamptz,"updatedAt" timestamptz,payload jsonb);INSERT INTO "PublicApiWebhookSubscription" VALUES('active','customer1','ACTIVE'),('disabled','customer2','DISABLED');INSERT INTO "PublicApiWebhookDelivery" VALUES('future','active','PENDING',now()+interval '1 hour',now()-interval '1 day','{"secret":"private-payload"}'),('leased','active','DELIVERING',now()-interval '1 hour',now()-interval '2 minutes','{}'),('disabled','disabled','PENDING',now()-interval '2 days',now()-interval '2 days','{}'),('failed','active','FAILED',now(),now(),'{"secret":"private-failure"}'),('delivered','active','DELIVERED',now()-interval '1 day',now(),'{}');`);
 let result=await readOperationsSource(pool,'growth',{},growthWebhookMeasurements);assert.equal(result.signals.find(s=>s.key==='webhook.overdue_seconds')!.value,'0');assert.equal(result.signals.find(s=>s.key==='webhook.failed')!.value,'1');assert(!JSON.stringify(result).includes('private-'));assert.deepEqual(result.signals.find(s=>s.key==='webhook.failed')!.evidence,[{product:'growth',resourceType:'webhook_delivery',resourceId:'failed',customerId:'customer1'}]);
 await pool.query(`INSERT INTO "PublicApiWebhookDelivery" VALUES('due','active','PENDING',now()-interval '10 minutes',now(),'{}'),('expired','active','DELIVERING',now()-interval '2 hours',now()-interval '6 minutes','{}');`);
 result=await readOperationsSource(pool,'growth',{},growthWebhookMeasurements);const due=result.signals.find(s=>s.key==='webhook.overdue_seconds')!;assert(Number(due.value)>=600);assert.deepEqual(due.evidence.map(e=>e.resourceId),['due','expired']);assert.equal((await pool.query('SELECT count(*) n FROM "PublicApiWebhookDelivery"')).rows[0].n,'7');assert.equal((await pool.query(`SELECT status FROM "PublicApiWebhookDelivery" WHERE id='leased'`)).rows[0].status,'DELIVERING');
 }finally{await pool.end();await parent.query(`DROP SCHEMA "${schema}" CASCADE`);await parent.end();}
});
