import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {parseOperationsNotification,registerOperationsNotifications,publishOperationsNotification} from '../src/routes/operations-notifications.js';
import {createOperationsServiceAuthority,OPERATIONS_AUTHORITY_HEADER} from '@kasitek-labs/server-support/operations-authority';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
const valid={id:'event1',incidentId:'incident1',transition:'opened' as const,severity:'critical' as const,recipients:['admin1'],title:'Source unavailable',message:'Growth source unavailable',link:'/operations/incidents/incident1'};
test('notification validation rejects arbitrary redirects, duplicate recipients and unbounded content',()=>{
 assert.equal(parseOperationsNotification(valid).id,'event1');
 for(const changes of [{link:'https://evil.test'},{link:'/operations/incidents/another'},{recipients:['admin1','admin1']},{message:'x'.repeat(501)},{severity:'SUCCESS'}])assert.throws(()=>parseOperationsNotification({...valid,...changes}));
});
test('bridge rejects observer authority, changed payload and notification publisher on read projection',async()=>{
 const app=Fastify();registerOperationsNotifications(app,{} as pg.Pool,{OPS_NOTIFICATION_SECRET:'x'.repeat(64),OPS_ENVIRONMENT:'development'});await app.ready();
 try{const body=JSON.stringify(valid),secret='x'.repeat(64);let token=createOperationsServiceAuthority({secret,audience:'growth',scope:'signals:read',method:'GET',path:'/internal/operations/signals',environment:'development'});
 assert.equal((await app.inject({method:'POST',url:'/internal/operations/notifications',payload:body,headers:{'content-type':'application/json',[OPERATIONS_AUTHORITY_HEADER]:token}})).statusCode,403);
 token=createOperationsServiceAuthority({secret,audience:'growth',scope:'notifications:publish',method:'POST',path:'/internal/operations/notifications',body,environment:'development'});
 assert.equal((await app.inject({method:'POST',url:'/internal/operations/notifications',payload:body+' ',headers:{'content-type':'application/json',[OPERATIONS_AUTHORITY_HEADER]:token}})).statusCode,403);
 }finally{await app.close();}
});
test('notification retry is transactional, recipients are verified, and payload conflicts cannot duplicate delivery',{skip:!process.env.OPERATIONS_TEST_DATABASE_URL},async()=>{
 const parent=new pg.Pool({connectionString:process.env.OPERATIONS_TEST_DATABASE_URL});const schema='notification_'+randomUUID().replaceAll('-','');await parent.query(`CREATE SCHEMA "${schema}"`);const pool=new pg.Pool({connectionString:process.env.OPERATIONS_TEST_DATABASE_URL,options:`-c search_path=${schema}`});
 try{await pool.query(`CREATE TABLE "AdminUser"(id text,role text);INSERT INTO "AdminUser" VALUES('admin1','operator');CREATE TABLE "OperationsNotificationReceipt"(id text PRIMARY KEY,digest text);CREATE TABLE "NotificationEvent"(id text,"scopeType" text,"scopeId" text,"eventType" text,title text,message text,severity text,"entityType" text,"entityId" text,payload jsonb,"dedupeKey" text,"createdAt" timestamptz);CREATE TABLE "Notification"(id text,"eventId" text,"recipientType" text,"recipientId" text,channel text,status text,"sentAt" timestamptz,"createdAt" timestamptz,"updatedAt" timestamptz);`);
 const results=await Promise.all([publishOperationsNotification(pool,valid),publishOperationsNotification(pool,valid)]);assert(results.some(r=>r.duplicate));assert.equal((await pool.query('SELECT count(*) n FROM "Notification"')).rows[0].n,'1');await assert.rejects(()=>publishOperationsNotification(pool,{...valid,message:'different'}),/conflict/);await assert.rejects(()=>publishOperationsNotification(pool,{...valid,id:'event2',recipients:['missing']}),/unavailable/);assert.equal((await pool.query('SELECT count(*) n FROM "OperationsNotificationReceipt"')).rows[0].n,'1');
 }finally{await pool.end();await parent.query(`DROP SCHEMA "${schema}" CASCADE`);await parent.end();}
});
