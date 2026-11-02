import {it as test} from 'vitest';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {readOperationsSource} from '@kasitek-labs/server-support/operations-source';
import {registerOperationsSource,agentsOperationsMeasurements} from '../src/product/operations/source';
import {createOperationsServiceAuthority,OPERATIONS_AUTHORITY_HEADER} from '@kasitek-labs/server-support/operations-authority';
test('observer route validates fixed source/environment/path before observing and exposes no customer authority',async()=>{
 let reads=0;const db={async query(sql:string){reads++;if(sql.startsWith('SELECT'))return {rows:[{value:'0'}]};return {rows:[]};},release(){}};
 const app=Fastify();registerOperationsSource(app,{connect:async()=>db} as unknown as Pool,{OPS_OBSERVER_SECRET:'x'.repeat(64),OPS_ENVIRONMENT:'development'});await app.ready();
 try{assert.equal((await app.inject({url:'/internal/operations/signals'})).statusCode,403);assert.equal(reads,0);
 const token=createOperationsServiceAuthority({secret:'x'.repeat(64),audience:'agents',scope:'signals:read',method:'GET',path:'/internal/operations/signals',environment:'development'});
 const response=await app.inject({url:'/internal/operations/signals',headers:{[OPERATIONS_AUTHORITY_HEADER]:token}});assert.equal(response.statusCode,200);assert.equal(response.json().source,'agents');assert(reads>0);assert.equal((await app.inject({url:'/internal/operations/signals?extra=1',headers:{[OPERATIONS_AUTHORITY_HEADER]:token}})).statusCode,403);
 assert.equal((await app.inject({url:'/api/admin/customers/customer',headers:{[OPERATIONS_AUTHORITY_HEADER]:token}})).statusCode,404);
 }finally{await app.close();}
});

const integration=process.env.OPERATIONS_TEST_DATABASE_URL?test:test.skip;
integration('failure rate excludes cancelled, refused, incomplete and evaluation traffic from eligible attempts',async()=>{
 const parent=new Pool({connectionString:process.env.OPERATIONS_TEST_DATABASE_URL}),schema='source_rate_'+randomUUID().replaceAll('-','');await parent.query(`CREATE SCHEMA "${schema}"`);
 const pool=new Pool({connectionString:process.env.OPERATIONS_TEST_DATABASE_URL,options:`-c search_path=${schema}`});
 try{
 await pool.query(`CREATE TABLE tasks(id uuid PRIMARY KEY,organization_id uuid,evaluation_trial_id uuid,state text,updated_at timestamptz,parent_task_id uuid); INSERT INTO tasks SELECT md5('failure'||n)::uuid,md5('customer')::uuid,NULL,'failed',now() FROM generate_series(1,20) n; INSERT INTO tasks SELECT md5(s.state||n)::uuid,md5('customer')::uuid,NULL,s.state,now() FROM (VALUES('cancelled'),('refused'),('incomplete')) s(state) CROSS JOIN generate_series(1,100) n; INSERT INTO tasks SELECT md5('eval'||n)::uuid,md5('customer')::uuid,md5('trial')::uuid,'failed',now() FROM generate_series(1,100) n;`);
 const measurement=agentsOperationsMeasurements.find(m=>m.key==='execution.failure_rate_bps')!;
 const result=await readOperationsSource(pool,'agents',{},[{...measurement,sql:measurement.sql!.replaceAll('agents_platform.tasks',`"${schema}".tasks`),sampleSql:measurement.sampleSql!.replaceAll('agents_platform.tasks',`"${schema}".tasks`)}]);
 const rate=result.signals.find(s=>s.key==='execution.failure_rate_bps')!;assert.equal(rate.status,'available');assert.equal(rate.denominator,'20');assert.equal(rate.value,'10000');assert.equal(rate.evidence.length,20);
 await pool.query(`CREATE TABLE task_outbox(task_id uuid,available_at timestamptz,dispatched_at timestamptz,lease_until timestamptz);INSERT INTO tasks(id,organization_id,state,updated_at,parent_task_id) VALUES(md5('dispatch-root')::uuid,md5('customer')::uuid,'accepted',now(),NULL),(md5('dispatch-child')::uuid,md5('customer')::uuid,'accepted',now(),md5('dispatch-root')::uuid),(md5('dispatch-lease')::uuid,md5('customer')::uuid,'accepted',now(),NULL);INSERT INTO task_outbox VALUES(md5('dispatch-root')::uuid,now()-interval '10 minutes',NULL,NULL),(md5('dispatch-child')::uuid,now()-interval '1 day',NULL,NULL),(md5('dispatch-lease')::uuid,now()-interval '1 day',NULL,now()+interval '1 minute');`);
 const dispatch=agentsOperationsMeasurements.find(m=>m.key==='execution.dispatch_overdue_seconds')!;
 const rewrite=(sql:string)=>sql.replaceAll('agents_platform.tasks',`"${schema}".tasks`).replaceAll('agents_platform.task_outbox',`"${schema}".task_outbox`);
 const dispatchResult=await readOperationsSource(pool,'agents',{},[{...dispatch,sql:rewrite(dispatch.sql!),sampleSql:rewrite(dispatch.sampleSql!)}]);
 const overdue=dispatchResult.signals.find(s=>s.key==='execution.dispatch_overdue_seconds')!;assert.equal(overdue.status,'available');assert(Number(overdue.value)>=600&&Number(overdue.value)<700);assert.equal(overdue.evidence.length,1);assert.equal(overdue.evidence[0].customerId,(await pool.query("SELECT md5('customer')::uuid id")).rows[0].id);

 }finally{await pool.end();await parent.query(`DROP SCHEMA "${schema}" CASCADE`);await parent.end();}
});
