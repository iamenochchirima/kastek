import { randomUUID } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { resolve, join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dispatchReceiptsOnce } from '../src/product/inbox/handoff-pending-receipt-runtime';
import { dropClosedTestDatabase } from './support/database-cleanup';

const enabled=process.env.AGENTS_TEST_DATABASE_URL && process.env.AGENTS_HANDOFF_RECEIPT_RUNTIME==='1';
(enabled?describe:describe.skip)('durable handoff receipt recovery',()=>{
  const database=`agents_receipt_runtime_${randomUUID().replaceAll('-','')}`, container=`agents-receipt-runtime-${randomUUID()}`;
  const image='docker.restate.dev/restatedev/restate:1.7.13@sha256:adf7bca9d89b8c868be682e1a2e1d42043613e988a17bfaad28753ac8d780742';
  const docker=(...args:string[])=>execFileSync('docker',args,{encoding:'utf8',timeout:60000}).trim();
  let admin:Pool,pool:Pool,worker:ChildProcess|undefined,started=false,bridge='',port=0,ingress='',runtimeAdmin='',databaseUrl='',output='';
  const wait=async(check:()=>Promise<boolean>,ms=30000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,75));}throw Error('Receipt recovery timed out');};
  const startWorker=async()=>{output='';worker=spawn(process.execPath,['--import','tsx',resolve(__dirname,'handoff-receipt-runtime-worker.ts')],{cwd:resolve(__dirname,'..'),env:{...process.env,AGENTS_DATABASE_URL:databaseUrl,RECEIPT_FIXTURE_HOST:bridge,RECEIPT_FIXTURE_PORT:String(port)},stdio:['ignore','pipe','pipe']});const active=worker;active.stdout!.on('data',chunk=>output+=String(chunk));active.stderr!.on('data',chunk=>output+=String(chunk));await wait(async()=>{if(active.exitCode!==null)throw Error('Receipt worker exited: '+output);return output.includes('RECEIPT_FIXTURE_READY');});};
  const stopWorker=async()=>{if(worker&&worker.exitCode===null&&worker.signalCode===null){const active=worker;active.kill('SIGKILL');await new Promise<void>(resolve=>active.once('exit',()=>resolve()));}};
  beforeAll(async()=>{
    admin=new Pool({connectionString:process.env.AGENTS_TEST_DATABASE_URL});await admin.query(`CREATE DATABASE "${database}"`);
    const u=new URL(process.env.AGENTS_TEST_DATABASE_URL!);u.pathname=`/${database}`;databaseUrl=u.href;pool=new Pool({connectionString:databaseUrl});
    await pool.query(`CREATE SCHEMA agents_platform; CREATE TABLE agents_platform.tasks(id uuid PRIMARY KEY); CREATE TABLE agents_platform.customer_conversations(id uuid PRIMARY KEY,state text,ownership_generation bigint); CREATE TABLE agents_platform.customer_messages(id uuid PRIMARY KEY,body text); CREATE TABLE agents_platform.customer_cancellations(task_id uuid PRIMARY KEY REFERENCES agents_platform.tasks(id));`);
    await pool.query(await readFile(join(__dirname,'../schema/087_handoff_pending_receipts.sql'),'utf8'));
    bridge=docker('network','inspect','bridge','--format','{{(index .IPAM.Config 0).Gateway}}');const reservation=createServer();await new Promise<void>(resolve=>reservation.listen(0,bridge,resolve));port=(reservation.address() as {port:number}).port;await new Promise<void>(resolve=>reservation.close(()=>resolve()));
    await startWorker();docker('run','-d','--name',container,'--cpus','1','--memory','768m','--add-host','host.docker.internal:host-gateway','-p','127.0.0.1::8080','-p','127.0.0.1::9070',image);started=true;
    ingress=`http://${docker('port',container,'8080/tcp')}`;runtimeAdmin=`http://${docker('port',container,'9070/tcp')}`;await wait(async()=>{try{return (await fetch(`${runtimeAdmin}/health`)).ok;}catch{return false;}});
    const result=await fetch(`${runtimeAdmin}/deployments`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({uri:`http://host.docker.internal:${port}`,force:false})});expect(result.ok,await result.text()).toBe(true);
  },90000);
  afterAll(async()=>{await stopWorker();if(started)docker('rm','-f',container);await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}},30000);
  it('recovers the deadline after worker and Restate restart and publishes once',async()=>{
    const task=randomUUID(),conversation=randomUUID();await pool.query('INSERT INTO agents_platform.tasks VALUES($1)',[task]);await pool.query("INSERT INTO agents_platform.customer_conversations VALUES($1,'handoff_pending',2)",[conversation]);
    await pool.query(`INSERT INTO agents_platform.pending_handoff_receipts(task_id,conversation_id,ownership_generation,delay_ms,created_at,deadline) SELECT $1,$2,2,6000,t,t+interval '6 seconds' FROM (SELECT clock_timestamp() t) q`,[task,conversation]);
    await dispatchReceiptsOnce(pool,ingress);await stopWorker();docker('restart','--time','0',container);
    ingress=`http://${docker('port',container,'8080/tcp')}`;runtimeAdmin=`http://${docker('port',container,'9070/tcp')}`;
    await wait(async()=>{try{return (await fetch(`${runtimeAdmin}/health`)).ok;}catch{return false;}});await startWorker();
    try {await wait(async()=>Boolean((await pool.query("SELECT 1 FROM agents_platform.pending_handoff_receipts WHERE task_id=$1 AND outcome='fallback'",[task])).rowCount));}
    catch(error){const logs=docker('logs','--tail','120',container);const receipt=(await pool.query('SELECT outcome,dispatched_at,deadline FROM agents_platform.pending_handoff_receipts WHERE task_id=$1',[task])).rows[0];throw Error(`Receipt recovery did not settle: ${output}\nreceipt=${JSON.stringify(receipt)}\n${logs}`,{cause:error});}
    expect((await pool.query('SELECT count(*)::int count FROM agents_platform.customer_messages')).rows[0].count).toBe(1);
    expect((await pool.query('SELECT count(*)::int count FROM agents_platform.customer_cancellations WHERE task_id=$1',[task])).rows[0].count).toBe(1);
  },60000);
});
