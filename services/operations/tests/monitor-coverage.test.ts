import test from 'node:test';
import assert from 'node:assert/strict';
import {measurementSummary} from '../src/monitor-coverage.js';
import {monitor} from '../src/serializers.js';
test('HTTP success cannot hide entirely unknown business measurements',()=>{
 const result=measurementSummary([{key:'source.available',status:'available',coverage:'complete',value:'1'},{key:'source.read_ready',status:'available',coverage:'complete',value:'0'},{key:'publication.overdue_seconds',status:'unknown'},{key:'publication.quarantined',status:'unknown'}]);
 assert.deepEqual(result,{total:2,available:0,unknown:2,unsupported:0,notConfigured:0,noActivity:0,readReady:'unavailable'});
});
test('no snapshot and explicit unsupported, unconfigured and idle coverage remain distinct',()=>{
 assert.equal(measurementSummary(null).readReady,'unknown');assert.equal(measurementSummary(null).total,0);
 const result=measurementSummary([{key:'source.read_ready',status:'available',coverage:'complete',value:'1'},{key:'known',status:'available'},{key:'unsupported',status:'unsupported'},{key:'configuration',status:'not_configured'},{key:'idle',status:'no_activity'}]);
 assert.deepEqual(result,{total:4,available:1,unknown:0,unsupported:1,notConfigured:1,noActivity:1,readReady:'ready'});
});
test('monitor projection is bounded and never returns raw snapshot fields',()=>{
 const date=new Date();const result=monitor({id:'growth',source:'growth',origin:'http://localhost:4000',enabled:true,interval_seconds:60,last_observed_at:date,last_error:null,next_poll_at:date,lease_until:null,signal_statuses:Array.from({length:101},()=>({key:'known',status:'unknown',payload:'private'})),snapshot:{secret:'private'}});
 assert.equal(result.measurementSummary.total,100);assert.equal(result.measurementSummary.unknown,100);assert(!JSON.stringify(result).includes('private'));assert(!('snapshot' in result));
});

test('monitor query reads latest bounded statuses without copying evidence or payload',{skip:!process.env.OPERATIONS_TEST_DATABASE_URL},async()=>{
 const {default:pg}=await import('pg'),{randomUUID}=await import('node:crypto');const parent=new pg.Pool({connectionString:process.env.OPERATIONS_TEST_DATABASE_URL}),schema='monitor_coverage_'+randomUUID().replaceAll('-','');await parent.query(`CREATE SCHEMA "${schema}"`);const pool=new pg.Pool({connectionString:process.env.OPERATIONS_TEST_DATABASE_URL,options:`-c search_path=${schema}`});
 try{await pool.query(`CREATE TABLE ops_monitors(id text,source text);CREATE TABLE ops_observations(id integer,monitor_id text,observed_at timestamptz,snapshot jsonb);INSERT INTO ops_monitors VALUES('growth','growth'),('empty','agency');INSERT INTO ops_observations VALUES(1,'growth',now()-interval '1 minute','{"signals":[{"key":"old","status":"available","value":"555"}]}'),(2,'growth',now(),'{"secret":"private","signals":[{"key":"source.available","status":"available","coverage":"complete","value":"1"},{"key":"source.read_ready","status":"available","coverage":"complete","value":"0"},{"key":"publication.quarantined","status":"unknown","value":"555","evidence":[{"secret":"private"}]}]}');`);
 const {monitorCoverageQuery}=await import('../src/monitor-coverage.js');const rows=(await pool.query(monitorCoverageQuery)).rows;assert.equal(rows.length,2);const growth=rows.find(r=>r.id==='growth');assert.deepEqual(measurementSummary(growth.signal_statuses),{total:1,available:0,unknown:1,unsupported:0,notConfigured:0,noActivity:0,readReady:'unavailable'});assert(!JSON.stringify(rows).includes('private'));assert(!JSON.stringify(rows).includes('555'));assert.equal(measurementSummary(rows.find(r=>r.id==='empty').signal_statuses).total,0);
 }finally{await pool.end();await parent.query(`DROP SCHEMA "${schema}" CASCADE`);await parent.end();}
});
