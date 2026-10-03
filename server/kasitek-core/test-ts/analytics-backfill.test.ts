import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import type {AnalyticsOutboxRecord,SourceBackfillWork,BackfillRecord,BackfillBatchResponse} from '@kasitek-labs/contracts';
import {canonicalJson,canonicalJsonSha256} from '@kasitek-labs/server-support/json';
import {backfillSourceSequence} from '@kasitek-labs/server-support/analytics-producer';
import {installPgTimestampParsers,UtcTimestamp,transaction} from '../src-ts/db.js';
import {epochMicros,epochMillis} from '../src-ts/analytics/facts.js';
import {buildMetaMessageBackfillRecord} from '../src-ts/analytics/inbox.js';
import * as connections from '../src-ts/analytics/connections.js';
import * as campaigns from '../src-ts/analytics/campaigns.js';
import {backfillSettings,metaResponderType,processSourceBackfillWork,buildHistoryBackfillRecord,type BackfillTransport} from '../src-ts/workers/analytics-backfill.js';
installPgTimestampParsers();
const settings=backfillSettings({ANALYTICS_INGESTION_TOKEN:'synthetic-token',ANALYTICS_BACKFILL_BATCH_SIZE:'1'})!;
function work(domain:string):SourceBackfillWork{return {job_id:'synthetic-job',source_service:'core',source_domain:domain,reporting_scope_id:1,root_scope_id:1,scope_external_id:'synthetic-org',requested_range_start:'2030-01-01T00:00:00Z',requested_range_end:'2030-01-02T00:00:00Z',contract_version:'1',method:'source_reconstruction',job_status:'running',checkpoint:{},remaining_count:100,lease_expires_at:'2030-01-02T00:00:00Z'};}
function capture(){const batches:BackfillRecord[][]=[];const transport:BackfillTransport={claimSourceBackfillWork:async()=>undefined,sendBackfillBatch:async(producer,job,records)=>{assert.equal(producer,'core-customer-analytics');assert.equal(job,'synthetic-job');batches.push(records);return {accepted_count:records.length,duplicate_count:0,rejected_count:0,retryable_count:0,acknowledgements:records.map(record=>({source_sequence:record.source_sequence,record_id:record.record.record_id,status:'accepted'}))};}};return {transport,batches};}
test('source event timestamp identities preserve micros, pre-epoch floor, numeric JSON and responder attribution',()=>{
 const time=new UtcTimestamp('2030-01-01 00:00:00.123456+00',true);assert.equal(epochMicros(time),1893456000123456n);assert.equal(epochMillis(time),1893456000123n);assert.equal(epochMillis('1969-12-31T23:59:59.999999Z'),-1n);
 const record=buildMetaMessageBackfillRecord('org','msg','conv','facebook','outbound','agent','text',time);assert.equal(record.record_id,'message:msg:created:1893456000123');assert.equal((record.envelope as {time:string}).time,'2030-01-01T00:00:00.123456Z');assert.equal(record.payload_hash,canonicalJsonSha256((record.envelope as {data:unknown}).data));assert.equal(record.payload_hash,'e451d6fe0cc81c844596b4a9444c4e02f58456bfa4a9f12466a27631fa49f66a');assert.ok(canonicalJson(record.envelope).includes('"response_time_ms":null'));
 const bytes=createHash('sha256').update(`kasitek.analytics.backfill:${record.record_id}`).digest();const expected=bytes.readBigUInt64BE()&0x7fffffffffffffffn;assert.equal(backfillSourceSequence(record.record_id),expected===0n?1n:expected);
 assert.equal(metaResponderType('customer','agent','template'),'customer');assert.equal(metaResponderType('business',' ',null),'agent');assert.equal(metaResponderType('business',null,'template'),'system');assert.equal(metaResponderType('business',null,null),'human');
 assert.equal(backfillSettings({ANALYTICS_CORE_INGESTION_TOKEN:' ',ANALYTICS_INGESTION_TOKEN:'fallback'}),undefined);assert.equal(backfillSettings({ANALYTICS_INGESTION_TOKEN:'fixture',ANALYTICS_BACKFILL_BATCH_SIZE:'9223372036854775808'})?.batch_size,100);
 const row={...record,source_sequence:1};assert.throws(()=>buildHistoryBackfillRecord(row,'connections'),/source_identity_mismatch/);assert.equal(connections.lifecycleAction('UNKNOWN'),'needs_attention');
});
test('source backfill safely resumes after the remote commit loses its acknowledgement',async()=>{
 const conversations=[
  {id:'c1',channel:'facebook',created_at:'2030-01-01T00:00:00.123451Z'},
  {id:'c2',channel:'instagram',created_at:'2030-01-01T00:00:00.123459Z'},
 ];
 const messages=[
  {id:'m1',conversation_id:'c1',channel:'facebook',sender:'customer',message_type:'TEXT',agent_idempotency_key:null,inbox_message_kind:null,occurred_at:'2030-01-01T00:00:01.123451Z'},
  {id:'m2',conversation_id:'c2',channel:'instagram',sender:'business',message_type:'TEXT',agent_idempotency_key:'agent-key',inbox_message_kind:null,occurred_at:'2030-01-01T00:00:01.123459Z'},
 ];
 const byConversation=new Map(conversations.map(row=>[row.id,row]));
 const pool={query:async(sql:string,values?:unknown[])=>{
  const [org,start,end,cursorTime,cursorId,limit]=values as [string,string,string,string|null,string|null,number];
  const source=sql.includes('FROM "Message" message')
   ? messages.flatMap(row=>{const conversation=byConversation.get(row.conversation_id);return conversation?[{...row,org_id:'synthetic-org',conversation_channel:conversation.channel}]:[];})
   : conversations.map(row=>({...row,org_id:'synthetic-org'}));
  const eligible=source.filter(row=>{
   const time='occurred_at' in row?row.occurred_at:row.created_at;
   return row.org_id===org&&Date.parse(time)>=Date.parse(start)&&Date.parse(time)<Date.parse(end)&&(!cursorTime||time>cursorTime||(time===cursorTime&&row.id>cursorId!));
  }).sort((a,b)=>{
   const at='occurred_at' in a?a.occurred_at:a.created_at;
   const bt='occurred_at' in b?b.occurred_at:b.created_at;
   return at.localeCompare(bt)||a.id.localeCompare(b.id);
  }).slice(0,limit).map(row=>{
   if('occurred_at' in row){const {org_id:_org,conversation_channel,...message}=row;return {...message,channel:conversation_channel};}
   const {org_id:_org,...conversation}=row;return conversation;
  });
  return {rows:eligible};
 }} as unknown as pg.Pool;
 const persisted=new Set<string>();
 const attempts=new Map<string,bigint[]>();
 let loseFirstAcknowledgement=true;
 let duplicateAcknowledgements=0;
 let uniqueEffects=0;
 const transport:BackfillTransport={
  claimSourceBackfillWork:async()=>undefined,
  sendBackfillBatch:async(producer,job,records)=>{
   assert.equal(producer,'core-customer-analytics');
   assert.equal(job,'lost-ack-job');
   for(const item of records){const history=attempts.get(item.record.record_id)??[];history.push(item.source_sequence);attempts.set(item.record.record_id,history);}
   if(loseFirstAcknowledgement){
    loseFirstAcknowledgement=false;
    for(const item of records){persisted.add(item.record.record_id);uniqueEffects++;}
    throw new Error('simulated lost response after remote commit');
   }
   let accepted_count=0;
   let duplicate_count=0;
   const acknowledgements=records.map(item=>{
    if(persisted.has(item.record.record_id)){duplicate_count++;duplicateAcknowledgements++;return {source_sequence:item.source_sequence,record_id:item.record.record_id,status:'duplicate' as const};}
    persisted.add(item.record.record_id);uniqueEffects++;accepted_count++;
    return {source_sequence:item.source_sequence,record_id:item.record.record_id,status:'accepted' as const};
   });
   return {accepted_count,duplicate_count,rejected_count:0,retryable_count:0,acknowledgements};
  },
 };
 const item={...work('inbox'),job_id:'lost-ack-job',remaining_count:4};
 await assert.rejects(processSourceBackfillWork(pool,transport,settings,item),/simulated lost response after remote commit/);
 const resumed=await processSourceBackfillWork(pool,transport,settings,item);
 assert.equal(resumed.conversation_records,2);
 assert.equal(resumed.message_records,2);
 assert.equal(duplicateAcknowledgements,1);
 assert.equal(uniqueEffects,4);
 assert.equal(persisted.size,4);
 const replayed=[...attempts].filter(([,sequences])=>sequences.length===2);
 assert.equal(replayed.length,1);
 assert.equal(replayed[0]![1][0],replayed[0]![1][1]);
});
test('isolated source reconstruction pages precise cursors, preserves history hashes and excludes foreign organization/range/channel',{skip:!process.env.CORE_ANALYTICS_TEST_DATABASE_URL},async()=>{
 const schema=`analytics_backfill_test_${randomUUID().replaceAll('-','')}`;const admin=new pg.Pool({connectionString:process.env.CORE_ANALYTICS_TEST_DATABASE_URL});await admin.query(`CREATE SCHEMA "${schema}"`);const pool=new pg.Pool({connectionString:process.env.CORE_ANALYTICS_TEST_DATABASE_URL,options:`-c search_path=${schema} -c timezone=UTC`});
 try{
 await pool.query(`CREATE TABLE "Conversation"(id text PRIMARY KEY,"orgId" text,channel text,"createdAt" timestamptz);CREATE TABLE "Message"(id text PRIMARY KEY,"conversationId" text,sender text,"contentType" text,"providerMetadata" jsonb,timestamp timestamptz);
 CREATE TABLE analytics_outbox(outbox_id text PRIMARY KEY,source_service text,source_domain text,source_stream_key text,record_category text,record_id text,contract_name text,schema_version integer,scope_kind text,scope_external_id text,idempotency_key text,envelope jsonb,payload_hash text,source_sequence bigserial,delivery_status text DEFAULT 'pending',attempt_count integer DEFAULT 0,next_attempt_at timestamptz DEFAULT NOW(),lease_owner text,lease_expires_at timestamptz,last_error_code text,created_at timestamptz DEFAULT NOW(),updated_at timestamptz DEFAULT NOW(),delivered_at timestamptz,quarantined_at timestamptz,UNIQUE(source_service,record_category,record_id));
 INSERT INTO "Conversation" VALUES('z-first','synthetic-org','facebook','2030-01-01T00:00:00.123451Z'),('a-second','synthetic-org','instagram','2030-01-01T00:00:00.123459Z'),('whatsapp','synthetic-org','whatsapp','2030-01-01T00:00:00Z'),('foreign','foreign-org','facebook','2030-01-01T00:00:00Z'),('end','synthetic-org','facebook','2030-01-02T00:00:00Z');
 INSERT INTO "Message" VALUES('z-message','z-first','customer','TEXT','{}','2030-01-01T00:00:01.123451Z'),('a-message','a-second','business',NULL,'{"_kasitek_agent_idempotency_key":"synthetic-agent"}','2030-01-01T00:00:01.123459Z'),('template','a-second','business','IMAGE','{"_kasitek_inbox_message_kind":"template"}','2030-01-01T01:00:00Z'),('foreign-msg','foreign','customer','TEXT','{}','2030-01-01T00:00:00Z'),('whatsapp-msg','whatsapp','customer','TEXT','{}','2030-01-01T00:00:00Z'),('end-msg','a-second','customer','TEXT','{}','2030-01-02T00:00:00Z');`);
 const inbox=capture();const stats=await processSourceBackfillWork(pool,inbox.transport,settings,work('inbox'));assert.equal(stats.conversation_records,2);assert.equal(stats.message_records,3);assert.equal(inbox.batches.length,5);const records=inbox.batches.flat().map(item=>item.record);assert.deepEqual(records.slice(0,2).map(record=>record.record_id),['conversation:z-first:opened:1893456000123','conversation:a-second:opened:1893456000123']);assert.ok(canonicalJson(records[3]!.envelope).includes('"responder_type":"agent"'));assert.ok(canonicalJson(records[4]!.envelope).includes('"responder_type":"system"'));assert.ok(canonicalJson(records[1]!.envelope).includes('2030-01-01T00:00:00.123459Z'));
 await transaction(pool,async tx=>{const time=new UtcTimestamp('2030-01-01T03:00:00.123456Z',true);await connections.enqueueLifecycle(tx,'synthetic-org','connection','meta','connected','CONNECTED','valid','healthy','ready',time);await connections.enqueueSyncAttempt(tx,'synthetic-org','connection','meta','attempt','sync','success','none',9223372036854775807n,time);await connections.enqueueRateLimit(tx,'synthetic-org','connection','meta','sync','account',null,time);await connections.enqueueLifecycle(tx,'foreign-org','connection-foreign','meta','connected','CONNECTED','valid','healthy','ready',time);
 await campaigns.enqueueRecipientSent(tx,'synthetic-org','campaign','recipient','whatsapp','meta',time);await campaigns.enqueueRecipientTiming(tx,'synthetic-org','campaign','recipient','whatsapp','meta','delivery',9223372036854775807n,time);await campaigns.enqueueRecipientPricing(tx,'synthetic-org','campaign','recipient','whatsapp','meta',true,'utility',null,null,time);
 assert.equal((await connections.enqueueManifest(tx,'synthetic-org',3,time)).kind,'inserted');assert.equal((await connections.enqueueManifest(tx,'synthetic-org',99,time)).kind,'duplicate');});
 for(const domain of ['connections','campaigns']){const captured=capture();const result=await processSourceBackfillWork(pool,captured.transport,settings,work(domain));assert.equal(domain==='connections'?result.connection_records:result.campaign_records,3);assert.equal(captured.batches.length,3);for(const item of captured.batches.flat()){assert.equal(item.record.payload_hash,canonicalJsonSha256((item.record.envelope as {data:unknown}).data));assert.equal(item.source_sequence,backfillSourceSequence(item.record.record_id));assert.equal(item.record.scope_external_id,'synthetic-org');}const text=canonicalJson(captured.batches[1]![0]!.record.envelope);assert.ok(text.includes('"duration_ms":9223372036854775807'));assert.ok(text.includes('2030-01-01T03:00:00.123456Z'));}
 const retrying:BackfillTransport={...inbox.transport,sendBackfillBatch:async()=>({accepted_count:0,duplicate_count:0,rejected_count:0,retryable_count:1,acknowledgements:[]})};await assert.rejects(processSourceBackfillWork(pool,retrying,settings,work('connections')),/connections_batch_has_retryable_records/);await assert.rejects(processSourceBackfillWork(pool,inbox.transport,settings,{...work('inbox'),remaining_count:null}),/requires_expected_count/);await assert.rejects(processSourceBackfillWork(pool,inbox.transport,settings,{...work('inbox'),method:'provider_history'}),/unsupported_source_job/);
 assert.equal((await pool.query('SELECT COUNT(*)::integer AS count FROM analytics_outbox WHERE delivery_status <> \'pending\'')).rows[0].count,0);
 }finally{await pool.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`);await admin.end();}
});
