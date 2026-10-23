import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import {randomUUID} from 'node:crypto';
import {readOperationsSource,publicationMeasurements,parseOperationsAuditQuery,readOperationsAudit,recordOperationsWorkerHeartbeat} from '../dist/operations-source.js';
test('query bounds reject injection-shaped filters and never permit unbounded pages',()=>{
 for(const value of [0,101,-1,1.1,'x'])assert.throws(()=>parseOperationsAuditQuery({limit:value}));
 assert.throws(()=>parseOperationsAuditQuery({actorId:'x\ncontent'}));
 assert.deepEqual(parseOperationsAuditQuery({limit:'25',actorId:'a'}),{limit:25,cursor:null,actor:'a',action:null,customer:null,resource:null,status:null});
});
test('measurement failures preserve unknown and do not invalidate other source facts',async()=>{
 const statements=[];const db={async query(sql){statements.push(sql);if(sql==='broken')throw Error('missing table');if(sql==='good')return {rows:[{value:'7'}]};return {rows:[]};},release(){}};
 const result=await readOperationsSource({connect:async()=>db},'growth',{},[{key:'missing',group:'source',unit:'count',sql:'broken'},{key:'good',group:'source',unit:'count',sql:'good'},{key:'unsupported',group:'source',unit:'count',unsupported:true}]);
 assert.equal(result.signals[0].status,'unknown');assert.equal(result.signals[0].value,null);assert.equal(result.signals[1].value,'7');assert.equal(result.signals[2].status,'unsupported');assert(statements.includes('BEGIN READ ONLY'));assert(statements.includes('ROLLBACK TO SAVEPOINT measurement'));assert(statements.includes('COMMIT'));
});
test('due-only queues, SQL read-only isolation and audit pagination against disposable database',{skip:!process.env.OPERATIONS_TEST_DATABASE_URL},async()=>{
 const parent=new pg.Pool({connectionString:process.env.OPERATIONS_TEST_DATABASE_URL});const name='operations_'+randomUUID().replaceAll('-','');await parent.query(`CREATE SCHEMA "${name}"`);const pool=new pg.Pool({connectionString:process.env.OPERATIONS_TEST_DATABASE_URL,options:`-c search_path=${name}`});const queueMeasurements=publicationMeasurements.map(m=>({...m,sql:m.sql.replaceAll("public.analytics_outbox",`"${name}".analytics_outbox`)}));
 try{
 await pool.query(`CREATE TABLE analytics_outbox(delivery_status text,next_attempt_at timestamptz,lease_expires_at timestamptz); INSERT INTO analytics_outbox VALUES('pending',now()+interval '1 hour',NULL),('leased',now()-interval '1 day',now()+interval '1 minute'),('quarantined',now(),NULL); CREATE TABLE audit_rows(id text,actor_id text,action text,status text,customer_id text,resource_type text,resource_id text,operation_id text,code text,occurred_at timestamptz); INSERT INTO audit_rows VALUES('a','alice','cancel','confirmed','one','task','task1','op1',NULL,now()),('b','bob','retry','failed','two','delivery','delivery1','op2','denied',now());`);
 let result=await readOperationsSource(pool,'growth',{},queueMeasurements);assert.equal(result.signals[0].value,'0');assert.equal(result.signals[1].value,'1');
 await pool.query(`INSERT INTO analytics_outbox VALUES('pending',now()-interval '60 seconds',NULL)`);result=await readOperationsSource(pool,'growth',{},queueMeasurements);assert(Number(result.signals[0].value)>=60);
 result=await readOperationsSource(pool,'growth',{},[{key:'unsafe',group:'test',unit:'count',sql:'DELETE FROM analytics_outbox RETURNING 1 AS value'}]);assert.equal(result.signals[0].status,'unknown');assert.equal((await pool.query('SELECT count(*) n FROM analytics_outbox')).rows[0].n,'4');
 await pool.query('CREATE TABLE operations_worker_heartbeats(worker text,instance text,environment text,observed_at timestamptz,PRIMARY KEY(worker,instance,environment))');
 await recordOperationsWorkerHeartbeat(pool,'publisher',{OPS_HEARTBEATS_ENABLED:'1',OPS_WORKER_INSTANCE:'test1',OPS_ENVIRONMENT:'development'});
 result=await readOperationsSource(pool,'growth',{OPS_EXPECTED_WORKERS:'publisher@test1,publisher@missing'},[]);assert.equal(result.signals[0].status,'available');assert.equal(result.signals[1].status,'unknown');assert.equal(result.signals[1].value,null);assert.equal(result.signals[0].expectedIntervalSeconds,30);
 await pool.query("UPDATE operations_worker_heartbeats SET observed_at=now()-interval '2 minutes'");result=await readOperationsSource(pool,'growth',{OPS_EXPECTED_WORKERS:'publisher@test1'},[]);assert(Number(result.signals[0].value)>=120);
 const page=await readOperationsAudit(pool,'growth','development','SELECT * FROM audit_rows',{limit:1});assert.equal(page.entries[0].id,'b');assert.equal(page.nextCursor,'b');const next=await readOperationsAudit(pool,'growth','development','SELECT * FROM audit_rows',{cursor:page.nextCursor});assert.equal(next.entries[0].id,'a');assert.equal(next.nextCursor,null);assert.equal((await readOperationsAudit(pool,'growth','development','SELECT * FROM audit_rows',{resourceId:'task1',status:'confirmed'})).entries.length,1);assert.equal((await readOperationsAudit(pool,'growth','development','SELECT * FROM audit_rows',{resourceId:'task1',status:'failed'})).entries.length,0);assert.equal((await readOperationsAudit(pool,'growth','development','SELECT * FROM audit_rows',{customerId:'one',actorId:'bob'})).entries.length,0);
 }finally{await pool.end();await parent.query(`DROP SCHEMA "${name}" CASCADE`);await parent.end();}
});
