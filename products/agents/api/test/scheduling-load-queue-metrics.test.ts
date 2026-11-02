import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {expect,it} from 'vitest';
import {dropClosedTestDatabase} from './support/database-cleanup';
import {childActivationCte,verifyQueueAges} from './scheduling-load-verification';
const url=process.env.AGENTS_TEST_DATABASE_URL;
(url?it:it.skip)('grades cancelled children that actually started, exempting only cancellation before any native operation',async()=>{
 const database=`agents_queue_metric_${randomUUID().replaceAll('-','')}`,admin=new Pool({connectionString:url,max:1});let pool:Pool|undefined,created=false;
 try{
  await admin.query(`CREATE DATABASE "${database}"`);created=true;const scoped=new URL(url!);scoped.pathname=`/${database}`;pool=new Pool({connectionString:scoped.href,max:1});
  // These are read-contract fixtures for the load grader, not native execution acceptance.
  await pool.query(`CREATE SCHEMA agents_platform;
   CREATE TABLE agents_platform.tasks(id uuid PRIMARY KEY,parent_task_id uuid,state text,runtime_invocation_id text,created_at timestamptz);
   CREATE TABLE agents_platform.operations(task_id uuid,started_at timestamptz)`);
  const parent=randomUUID(),lateCancelled=randomUUID(),neverStartedCancelled=randomUUID(),completed=randomUUID(),missing=randomUUID();
  for(const[id,state]of[[lateCancelled,'cancelled'],[neverStartedCancelled,'cancelled'],[completed,'completed'],[missing,'accepted']])await pool.query('INSERT INTO agents_platform.tasks VALUES($1,$2,$3,$4,to_timestamp(0))',[id,parent,state,'inv_fixture']);
  await pool.query('INSERT INTO agents_platform.operations VALUES($1,to_timestamp(70)),($2,to_timestamp(15))',[lateCancelled,completed]);
  const rows=(await pool.query(`WITH ${childActivationCte} SELECT * FROM child_activation`)).rows;
  expect(rows.map(row=>row.id).sort()).toEqual([lateCancelled,completed,missing].sort());
  const metrics=(await pool.query(`WITH ${childActivationCte} SELECT 1000::int dispatch_lag_p95_ms,count(*)::int child_count,count(first_operation_at)::int child_started_count,percentile_cont(0.95) WITHIN GROUP(ORDER BY extract(epoch FROM(first_operation_at-created_at))*1000) child_activation_p95_ms FROM child_activation`)).rows[0];
  expect(verifyQueueAges(metrics,30000)).toEqual(['Child first-native-operation coverage missing','Child admission-to-first-native-operation threshold failed']);
 }finally{await pool?.end();if(created)await dropClosedTestDatabase(admin,database);await admin.end();}
});
