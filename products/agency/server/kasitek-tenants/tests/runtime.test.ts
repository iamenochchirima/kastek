import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {createPool} from '../src/db.js';
import {readConfig} from '../src/config.js';
const enabled=!!process.env.TENANT_TEST_DATABASE_URL;
async function unusedPort():Promise<number>{const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const address=server.address();assert.ok(address&&typeof address==='object');await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));return address.port;}
test('compiled native API and both dedicated modes apply migrations, keep scopes, and shut down', {skip:!enabled,timeout:20000},async()=>{
 const admin=new pg.Pool({connectionString:process.env.TENANT_TEST_DATABASE_URL});
 const schema=`tenant_runtime_${randomUUID().replaceAll('-','')}`;
 await admin.query(`CREATE SCHEMA "${schema}"`);
 const url=new URL(process.env.TENANT_TEST_DATABASE_URL!);url.searchParams.set('options',`-c search_path=${schema} -c timezone=UTC`);
 const pool=createPool(readConfig({TENANT_DATABASE_URL:url.toString()}));
 try {
  // Check the exact production pool's search_path before allowing startup DDL.
  assert.equal((await pool.query('SELECT current_schema() AS name')).rows[0].name,schema);
  for(const mode of ['api','analytics-publisher','analytics-backfill-worker']) {
   const port=await unusedPort();
   const child=spawn(process.execPath,[fileURLToPath(new URL('../dist/bootstrap.js',import.meta.url))],{env:{...process.env,KASITEK_TENANTS_DATABASE_URL:url.toString(),TENANT_SERVER_PORT:String(port),KASITEK_PROCESS:mode,OTEL_SDK_DISABLED:'true',LOG_LEVEL:'silent',ANALYTICS_TENANT_INGESTION_TOKEN:'',ANALYTICS_INGESTION_TOKEN:''},stdio:['ignore','pipe','pipe']});
   let output='';child.stdout.on('data',chunk=>{output+=chunk});child.stderr.on('data',chunk=>{output+=chunk});
   const exit=once(child,'exit');
   try {
    if(mode==='api'){
     let ready=false;
     for(let i=0;i<100;i++){
      if(child.exitCode!==null)throw Error(`Compiled Tenant API exited before readiness: ${output.slice(-1000)}`);
      try{const response=await fetch(`http://127.0.0.1:${port}/health`);if(response.ok){assert.equal((await response.json() as {service:string}).service,'tenant-server');ready=true;break;}}catch{}
      await new Promise(resolve=>setTimeout(resolve,30));
     }
     assert.equal(ready,true);
     assert.equal((await fetch(`http://127.0.0.1:${port}/api/auth/me`)).status,401);
     child.kill('SIGTERM');
    }
    const [code,signal]=await exit;assert.equal(code,0);assert.equal(signal,null);
    assert.equal((await pool.query('SELECT count(*) FROM _sqlx_migrations')).rows[0].count,'12');
    if(mode!=='api')assert.match(output,/missing_ingestion_token/);
   }finally{if(child.exitCode===null&&child.signalCode===null){child.kill('SIGTERM');await exit;}}
  }
 }finally{await pool.end();try{await admin.query(`DROP SCHEMA "${schema}" CASCADE`);}finally{await admin.end();}}
});
